// ─── Sync Engine ──────────────────────────────────────────────────────────────
// Local-first cloud sync via Supabase.
//
// Outbound: local dispatches → debounced push to Supabase
// Inbound:  Supabase real-time → dispatch into local state
// Offline:  queue writes, replay when reconnected
//
// Usage:
//   syncEngine.start({ workspaceId, userId, dispatch })
//   syncEngine.stop()
//   syncEngine.onAction(action) — called by AppContext after every dispatch

import { supabase, getCurrentUser } from './supabase';
import eventBus from './eventBus';
import { setSyncHook } from './storage';

// ─── State ───────────────────────────────────────────────────────────────────

let _workspaceId = null;
let _userId = null;
let _dispatch = null;
let _channel = null;
let _running = false;
let _status = 'idle'; // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'

// Ignore actions coming from incoming real-time events (avoid echo loop)
let _incomingIds = new Set();

// Outbound write queue (for offline / debouncing)
const _pendingWrites = new Map(); // key: `${table}:${id}` → { table, row, op }
let _flushTimer = null;

// Status listeners
const _statusListeners = new Set();

function setStatus(newStatus) {
  if (newStatus === _status) return;
  _status = newStatus;
  _statusListeners.forEach(fn => { try { fn(newStatus); } catch (e) { console.error('[syncEngine] status listener failed:', e); } });
}

export function onStatusChange(fn) {
  _statusListeners.add(fn);
  fn(_status);
  return () => _statusListeners.delete(fn);
}

export function getStatus() {
  return _status;
}

// ─── Key → table mapping for array-based storage syncs ────────────────────

const ARRAY_SYNC_CONFIG = {
  'noltech:arbitrage:bids': {
    table: 'bids',
    toRow: (bid, workspaceId) => ({
      id: bid.id,
      workspace_id: workspaceId,
      lot_id: bid.lotId || null,
      lot_title: bid.lotTitle || null,
      source: bid.source || null,
      lot_url: bid.lotUrl || null,
      bid_amount: bid.bidAmount ? parseFloat(bid.bidAmount) : null,
      bid_ceiling: bid.bidCeiling ? parseFloat(bid.bidCeiling) : null,
      est_resale: bid.estResale ? parseFloat(bid.estResale) : null,
      won_price: bid.wonPrice ? parseFloat(bid.wonPrice) : null,
      actual_profit: bid.actualProfit ? parseFloat(bid.actualProfit) : null,
      status: bid.status || null,
      inventory_lot_id: bid.inventoryLotId || null,
      notes: bid.notes || null,
      alert_conditions: bid.alertConditions || null,
      bid_date: bid.bidDate || null,
      updated_at: bid.updatedAt || new Date().toISOString(),
      imported_at: bid.importedAt || null,
    }),
    fromRow: (row) => ({
      id: row.id,
      lotId: row.lot_id,
      lotTitle: row.lot_title,
      source: row.source,
      lotUrl: row.lot_url,
      bidAmount: row.bid_amount,
      bidCeiling: row.bid_ceiling,
      estResale: row.est_resale,
      wonPrice: row.won_price,
      actualProfit: row.actual_profit,
      status: row.status,
      inventoryLotId: row.inventory_lot_id,
      notes: row.notes,
      alertConditions: row.alert_conditions,
      bidDate: row.bid_date,
      updatedAt: row.updated_at,
      importedAt: row.imported_at,
    }),
  },
  'noltech:books:transactions': {
    table: 'transactions',
    toRow: (t, workspaceId) => ({
      id: t.id,
      workspace_id: workspaceId,
      date: t.date || null,
      type: t.type || null,
      category: t.category || null,
      description: t.description || null,
      amount: t.amount ? parseFloat(t.amount) : null,
      notes: t.notes || null,
      source: t.source || null,
      import_id: t.importId || null,
      // Per-row eBay order ID (stamped on auto rows by useEventBridge so the
      // bookkeeping ledger search bar and eBay Match reconciliation can find
      // every row tied to a given order). Added in migration 010.
      order_id: t.orderId || null,
      sku: t.sku || null,
    }),
    fromRow: (row) => ({
      id: row.id,
      date: row.date,
      type: row.type,
      category: row.category,
      description: row.description,
      amount: row.amount,
      notes: row.notes,
      source: row.source,
      importId: row.import_id,
      orderId: row.order_id,
      sku: row.sku,
    }),
  },
  'noltech:sales:history': {
    table: 'sales_history',
    toRow: (s, workspaceId) => ({
      id: s.id || crypto.randomUUID(),
      workspace_id: workspaceId,
      item_id: s.itemId || null,
      lot_id: s.lotId || null,
      sale: s.sale || null,
      brand: s.brand || null,
      model: s.model || null,
      recorded_at: s.recordedAt || new Date().toISOString(),
    }),
    fromRow: (row) => ({
      id: row.id,
      itemId: row.item_id,
      lotId: row.lot_id,
      sale: row.sale,
      brand: row.brand,
      model: row.model,
      recordedAt: row.recorded_at,
    }),
  },
};

// Object-based storage keys (single row per workspace or user)
const OBJECT_SYNC_CONFIG = {
  // Workspace-wide settings (shared across members)
  'noltech:settings:condition-multipliers': { table: 'workspace_settings', column: 'condition_multipliers', scope: 'workspace' },
  'noltech:settings:categories':             { table: 'workspace_settings', column: 'categories', scope: 'workspace' },
  'noltech:settings:sources':                { table: 'workspace_settings', column: 'sources', scope: 'workspace' },
  'noltech:settings:ebay-fee-rate':          { table: 'workspace_settings', column: 'ebay_fee_rate', scope: 'workspace', isNumber: true },
  'noltech:settings:auto-sync':              { table: 'workspace_settings', column: 'auto_sync_config', scope: 'workspace' },
  'noltech:pricereductor:rules':             { table: 'workspace_settings', column: 'price_reductor_rules', scope: 'workspace' },
  'noltech:autorelist:config':               { table: 'workspace_settings', column: 'auto_relist_config', scope: 'workspace' },
  // User-specific preferences
  'noltech:arbitrage:watchlist':             { table: 'user_preferences', column: 'watchlist', scope: 'user' },
  'noltech:arbitrage:lot-notes':             { table: 'user_preferences', column: 'lot_notes', scope: 'user' },
  // Phone-alert webhook URL — synced to user_preferences so the bid-alerts
  // Cloudflare Worker can read it (it runs without access to local storage).
  'noltech:settings:phone-webhook':          { table: 'user_preferences', column: 'phone_webhook_url', scope: 'user' },
};

// Cache last-known array state to compute diffs
const _lastKnownArrays = new Map(); // storageKey → array

// ─── Shape converters (local ↔ cloud) ──────────────────────────────────────

function lotToRow(lot, workspaceId, userId) {
  return {
    id: lot.id,
    workspace_id: workspaceId,
    source: lot.source || null,
    source_name: lot.sourceName || null,
    purchase_date: lot.purchaseDate || null,
    cost: lot.cost ? parseFloat(lot.cost) : null,
    item_count: lot.itemCount ? parseInt(lot.itemCount) : null,
    status: lot.status || 'received',
    notes: lot.notes || null,
    sku_prefix: lot.skuPrefix || null,
    sku_suffix: lot.skuSuffix || null,
    manifest: lot.manifest || null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
}

function rowToLot(row) {
  return {
    id: row.id,
    source: row.source,
    sourceName: row.source_name,
    purchaseDate: row.purchase_date,
    cost: row.cost,
    itemCount: row.item_count,
    status: row.status,
    notes: row.notes,
    skuPrefix: row.sku_prefix,
    skuSuffix: row.sku_suffix,
    manifest: row.manifest,
    items: [], // populated separately
    _version: row.version,
    _updatedAt: row.updated_at,
  };
}

function itemToRow(item, workspaceId, userId) {
  return {
    id: item.id,
    workspace_id: workspaceId,
    lot_id: item.lotId || null,
    brand: item.brand || null,
    model: item.model || null,
    category: item.category || null,
    serial_number: item.serialNumber || null,
    sku: item.sku || null,
    status: item.status || 'received',
    condition_grade: item.conditionGrade || null,
    condition_on_arrival: item.conditionOnArrival || null,
    disposition: item.disposition || null,
    listing_price: item.listingPrice ? parseFloat(item.listingPrice) : null,
    cost_basis: item.costBasis ? parseFloat(item.costBasis) : null,
    estimated_value: item.estimatedValue ? parseFloat(item.estimatedValue) : null,
    ebay_item_id: item.ebayItemId || null,
    date_added: item.dateAdded || null,
    sale: item.sale || null,
    test_results: item.testResults || null,
    photos: item.photos || null,
    notes: item.notes || null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
}

function rowToItem(row) {
  return {
    id: row.id,
    lotId: row.lot_id,
    brand: row.brand,
    model: row.model,
    category: row.category,
    serialNumber: row.serial_number,
    sku: row.sku,
    status: row.status,
    conditionGrade: row.condition_grade,
    conditionOnArrival: row.condition_on_arrival,
    disposition: row.disposition,
    listingPrice: row.listing_price,
    costBasis: row.cost_basis,
    estimatedValue: row.estimated_value,
    ebayItemId: row.ebay_item_id,
    dateAdded: row.date_added,
    sale: row.sale,
    testResults: row.test_results,
    photos: row.photos,
    notes: row.notes,
    _version: row.version,
    _updatedAt: row.updated_at,
    _updatedBy: row.updated_by,
  };
}

// ─── Write queue ────────────────────────────────────────────────────────────

function queueWrite(table, row, op = 'upsert') {
  const key = `${table}:${row.id}`;
  _pendingWrites.set(key, { table, row, op });
  markLocalWrite(table, row.id); // Track so we ignore the echo
  scheduleFlush();
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushWrites();
  }, 500); // 500ms debounce — batches rapid updates
}

// Retry queue for failed writes
const _retryQueue = []; // [{ write, attempts, nextAttemptAt }]
let _retryTimer = null;

async function flushWrites() {
  if (!supabase || _pendingWrites.size === 0) return;
  const writes = Array.from(_pendingWrites.values());
  _pendingWrites.clear();

  setStatus('syncing');

  // Group by table + op for batching
  const upsertsByTable = {};
  const deletesByTable = {};
  for (const w of writes) {
    if (w.op === 'delete') {
      (deletesByTable[w.table] ||= { rows: [], items: [] });
      deletesByTable[w.table].rows.push(w.row.id);
      deletesByTable[w.table].items.push(w);
    } else {
      (upsertsByTable[w.table] ||= { rows: [], items: [] });
      upsertsByTable[w.table].rows.push(w.row);
      upsertsByTable[w.table].items.push(w);
    }
  }

  let errorCount = 0;

  // Process DELETES first, then UPSERTS. When a "Rebuild auto rows" pass
  // generates fresh row UUIDs for the same logical importId, the old rows
  // need to be removed BEFORE the new ones are inserted — otherwise the
  // upsert hits a unique constraint on import_id and the new row is lost.
  for (const [table, { rows, items }] of Object.entries(deletesByTable)) {
    try {
      const { error } = await supabase.from(table).delete().in('id', rows);
      if (error) {
        console.error(`[sync] delete ${table}:`, error);
        errorCount++;
        for (const w of items) enqueueRetry(w);
      }
    } catch (e) {
      console.error(`[sync] delete ${table} threw:`, e);
      errorCount++;
      for (const w of items) enqueueRetry(w);
    }
  }

  // Upserts
  for (const [table, { rows, items }] of Object.entries(upsertsByTable)) {
    try {
      const { error } = await supabase.from(table).upsert(rows);
      if (error) {
        console.error(`[sync] upsert ${table}:`, error);
        errorCount++;
        for (const w of items) enqueueRetry(w);
      }
    } catch (e) {
      console.error(`[sync] upsert ${table} threw:`, e);
      errorCount++;
      for (const w of items) enqueueRetry(w);
    }
  }

  if (errorCount === 0 && _retryQueue.length === 0) {
    setStatus('synced');
  } else if (_retryQueue.length > 0) {
    setStatus('syncing'); // Keep showing syncing while retries pending
    scheduleRetry();
  } else {
    setStatus('error');
  }
}

function enqueueRetry(write) {
  const existing = _retryQueue.find(r => r.write.table === write.table && r.write.row.id === write.row.id);
  if (existing) {
    existing.attempts++;
    existing.nextAttemptAt = Date.now() + backoffMs(existing.attempts);
  } else {
    _retryQueue.push({ write, attempts: 1, nextAttemptAt: Date.now() + backoffMs(1) });
  }
}

function backoffMs(attempts) {
  // 2s, 5s, 15s, 30s, 60s max
  const delays = [2000, 5000, 15000, 30000, 60000];
  return delays[Math.min(attempts - 1, delays.length - 1)];
}

function scheduleRetry() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    retryFailedWrites();
  }, 2000);
}

async function retryFailedWrites() {
  if (!supabase || _retryQueue.length === 0) return;
  const now = Date.now();
  const ready = _retryQueue.filter(r => r.nextAttemptAt <= now && r.attempts <= 5);
  const stillWaiting = _retryQueue.filter(r => r.nextAttemptAt > now && r.attempts <= 5);
  const giveUp = _retryQueue.filter(r => r.attempts > 5);

  _retryQueue.length = 0;
  _retryQueue.push(...stillWaiting);

  if (giveUp.length > 0) {
    console.error(`[sync] Giving up on ${giveUp.length} writes after 5 attempts`);
    eventBus.emit('notification:push', {
      type: 'error',
      title: 'Sync failed',
      message: `${giveUp.length} change${giveUp.length !== 1 ? 's' : ''} could not be synced. Check your connection.`,
    });
  }

  for (const { write } of ready) {
    _pendingWrites.set(`${write.table}:${write.row.id}`, write);
  }
  if (ready.length > 0) flushWrites();
  else if (_retryQueue.length > 0) scheduleRetry();
  else setStatus('synced');
}

// ─── Array storage sync (bids, transactions, sales_history) ──────────────
// When window.storage.set is called with a synced key, diff against last-known
// state and push only changed rows to Supabase.

export function onArrayStorageWrite(storageKey, newValue) {
  if (!_running || !_workspaceId) return;

  // Object-based sync (settings + user preferences)
  const objConfig = OBJECT_SYNC_CONFIG[storageKey];
  if (objConfig) {
    syncObjectColumn(storageKey, newValue, objConfig);
    return;
  }

  const config = ARRAY_SYNC_CONFIG[storageKey];
  if (!config) return;
  const newArray = newValue;
  if (!Array.isArray(newArray)) return;

  const oldArray = _lastKnownArrays.get(storageKey) || [];
  const oldMap = new Map(oldArray.filter(x => x?.id).map(x => [x.id, x]));
  const newMap = new Map(newArray.filter(x => x?.id).map(x => [x.id, x]));

  // Detect changes
  const toUpsert = [];
  const toDelete = [];

  for (const [id, newItem] of newMap) {
    const old = oldMap.get(id);
    if (!old || JSON.stringify(old) !== JSON.stringify(newItem)) {
      toUpsert.push(config.toRow(newItem, _workspaceId));
    }
  }

  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) toDelete.push(id);
  }

  for (const row of toUpsert) {
    queueWrite(config.table, row);
  }
  for (const id of toDelete) {
    queueWrite(config.table, { id }, 'delete');
  }

  _lastKnownArrays.set(storageKey, JSON.parse(JSON.stringify(newArray)));
}

// Initialize last-known state from current storage (call after login)
export async function hydrateArrayCache() {
  for (const key of Object.keys(ARRAY_SYNC_CONFIG)) {
    try {
      const val = await window.storage.get(key);
      if (Array.isArray(val)) _lastKnownArrays.set(key, JSON.parse(JSON.stringify(val)));
    } catch (e) { console.error('[syncEngine] hydrate array cache failed:', e); }
  }
}

// ─── Object-based sync (single-column updates) ─────────────────────────────
// Debounce object writes so rapid typing doesn't spam the server
const _pendingObjectWrites = new Map(); // key: storageKey → { value, config, timer }

async function syncObjectColumn(storageKey, value, config) {
  // Debounce — wait 1s after last write to batch rapid updates
  const existing = _pendingObjectWrites.get(storageKey);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    _pendingObjectWrites.delete(storageKey);
    try {
      if (config.scope === 'workspace') {
        const payload = { workspace_id: _workspaceId, updated_at: new Date().toISOString(), updated_by: _userId };
        payload[config.column] = config.isNumber ? Number(value) : value;
        const { error } = await supabase.from('workspace_settings').upsert(payload, { onConflict: 'workspace_id' });
        if (error) console.error(`[sync] workspace_settings.${config.column}:`, error);
      } else if (config.scope === 'user') {
        const payload = { user_id: _userId, workspace_id: _workspaceId, updated_at: new Date().toISOString() };
        payload[config.column] = value;
        const { error } = await supabase.from('user_preferences').upsert(payload, { onConflict: 'user_id' });
        if (error) console.error(`[sync] user_preferences.${config.column}:`, error);
      }
      markLocalWrite(config.table, _workspaceId);
    } catch (e) { console.error('[sync] object write error:', e); }
  }, 1000);

  _pendingObjectWrites.set(storageKey, { value, config, timer });
}

// ─── Action handler (called by AppContext after every dispatch) ──────────

export function onAction(action) {
  if (!_running) return;
  // Skip actions triggered by incoming real-time events
  if (action._fromSync) return;

  try {
    switch (action.type) {
      case 'ADD_LOT':
      case 'UPDATE_LOT': {
        const lot = action.lot || action.updates;
        if (!lot) return;
        // For UPDATE_LOT, we need the full lot — we'll need to pass it via state
        // For now, just queue the lot fields we have
        if (action.type === 'ADD_LOT') {
          queueWrite('lots', lotToRow(action.lot, _workspaceId, _userId));
        } else {
          // UPDATE_LOT: fetch current lot from dispatch scope
          // Caller should pass the full lot — we'll do it in AppContext wrapper
          queueWrite('lots', { id: action.id, ...lotToRow({ id: action.id, ...action.updates }, _workspaceId, _userId) });
        }
        break;
      }
      case 'DELETE_LOT':
        queueWrite('lots', { id: action.id }, 'delete');
        break;

      case 'ADD_ITEM':
        queueWrite('items', itemToRow(action.item, _workspaceId, _userId));
        break;

      case 'UPDATE_ITEM':
        // We need the full item; pass updates + id merged. Server will upsert.
        queueWrite('items', itemToRow({ id: action.id, ...action.updates }, _workspaceId, _userId));
        break;

      case 'DELETE_ITEM':
        queueWrite('items', { id: action.id }, 'delete');
        break;

      default:
        break;
    }
  } catch (e) { console.error('[sync] onAction error:', e); }
}

// ─── Real-time subscriptions ────────────────────────────────────────────

function subscribeRealtime() {
  if (!supabase || !_workspaceId) return;
  if (_channel) { supabase.removeChannel(_channel); _channel = null; }

  _channel = supabase
    .channel(`ws:${_workspaceId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lots', filter: `workspace_id=eq.${_workspaceId}` }, handleLotChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `workspace_id=eq.${_workspaceId}` }, handleItemChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bids', filter: `workspace_id=eq.${_workspaceId}` }, (p) => handleArrayChange('noltech:arbitrage:bids', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions', filter: `workspace_id=eq.${_workspaceId}` }, (p) => handleArrayChange('noltech:books:transactions', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_history', filter: `workspace_id=eq.${_workspaceId}` }, (p) => handleArrayChange('noltech:sales:history', p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_settings', filter: `workspace_id=eq.${_workspaceId}` }, handleWorkspaceSettingsChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_preferences', filter: `user_id=eq.${_userId}` }, handleUserPreferencesChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'browse_lots', filter: `workspace_id=eq.${_workspaceId}` }, handleBrowseLotChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[sync] Realtime subscribed to workspace', _workspaceId);
      }
    });
}

// Inbound browse_lots change from the AWS sync-agent's scrape-lots cron.
// Merges the lot into the local IndexedDB cache so freshly-scraped auctions
// appear in the Source page without a manual Refresh.
async function handleBrowseLotChange(payload) {
  const KEY = 'noltech:arbitrage:browse-lots';
  try {
    const cached = (await window.storage.get(KEY)) || { lots: [], scrapedAt: null, _version: 2, enrichments: {} };
    const lots = Array.isArray(cached.lots) ? cached.lots.slice() : [];

    if (payload.eventType === 'DELETE') {
      const oldId = payload.old?.id;
      if (!oldId) return;
      const filtered = lots.filter((l) => String(l.id) !== String(oldId));
      if (filtered.length === lots.length) return; // not found locally
      await window.storage.set(KEY, { ...cached, lots: filtered });
    } else {
      const row = payload.new;
      if (!row?.id || !row?.data) return;
      const incomingLot = row.data;
      const idx = lots.findIndex((l) => String(l.id) === String(row.id));
      if (idx >= 0) lots[idx] = incomingLot;
      else lots.push(incomingLot);
      await window.storage.set(KEY, {
        ...cached,
        lots,
        scrapedAt: row.scraped_at || new Date().toISOString(),
        _version: 2,
        // Keep existing enrichments so we don't blow away pricing data the
        // user has already paid Bright Data for.
      });
    }
    eventBus.emit('sync:browse-lots-updated', { eventType: payload.eventType });
  } catch (e) {
    console.error('[syncEngine] browse_lots change apply failed:', e);
  }
}

async function handleWorkspaceSettingsChange(payload) {
  if (wasRecentLocalWrite('workspace_settings', _workspaceId)) return;
  const row = payload.new;
  if (!row) return;
  // Apply each column back to its storage key
  for (const [storageKey, config] of Object.entries(OBJECT_SYNC_CONFIG)) {
    if (config.scope !== 'workspace') continue;
    const val = row[config.column];
    if (val == null) continue;
    try {
      await window.storage.set(storageKey, val);
      eventBus.emit('sync:object-updated', { storageKey, value: val });
    } catch (e) { console.error('[syncEngine] workspace settings write failed:', e); }
  }
}

async function handleUserPreferencesChange(payload) {
  if (wasRecentLocalWrite('user_preferences', _workspaceId)) return;
  const row = payload.new;
  if (!row) return;
  for (const [storageKey, config] of Object.entries(OBJECT_SYNC_CONFIG)) {
    if (config.scope !== 'user') continue;
    const val = row[config.column];
    if (val == null) continue;
    try {
      await window.storage.set(storageKey, val);
      eventBus.emit('sync:object-updated', { storageKey, value: val });
    } catch (e) { console.error('[syncEngine] user preferences write failed:', e); }
  }
}

async function handleArrayChange(storageKey, payload) {
  const config = ARRAY_SYNC_CONFIG[storageKey];
  if (!config) return;
  const { eventType, new: newRow, old } = payload;
  const id = newRow?.id || old?.id;

  if (wasRecentLocalWrite(config.table, id)) return;

  try {
    const current = (await window.storage.get(storageKey)) || [];
    let updated;
    if (eventType === 'DELETE') {
      updated = current.filter(x => x.id !== id);
    } else {
      const newItem = config.fromRow(newRow);
      const existingIdx = current.findIndex(x => x.id === id);
      if (existingIdx >= 0) {
        updated = [...current];
        updated[existingIdx] = newItem;
      } else {
        updated = [newItem, ...current];
      }
    }
    _lastKnownArrays.set(storageKey, JSON.parse(JSON.stringify(updated)));
    await window.storage.set(storageKey, updated);
    // Notify UI to refresh
    eventBus.emit('sync:array-updated', { storageKey, data: updated });
  } catch (e) { console.error('[sync] array change error:', e); }
}

// Track IDs we just wrote so we can ignore their echo without false positives.
// When we queue a write, add id+timestamp here. When an incoming change arrives,
// check if we wrote this id within the last 2 seconds.
const _recentLocalWrites = new Map(); // key: `${table}:${id}` → timestamp

// Track last-seen updated_at per row so we can detect conflicts
// (teammate updated the row after we last saw it).
const _lastSeenRows = new Map(); // key: `${table}:${id}` → { updated_at, updated_by }

function recordSeenRow(table, id, updated_at, updated_by) {
  if (!id || !updated_at) return;
  _lastSeenRows.set(`${table}:${id}`, { updated_at, updated_by });
}

function getSeenRow(table, id) {
  return _lastSeenRows.get(`${table}:${id}`);
}

function markLocalWrite(table, id) {
  _recentLocalWrites.set(`${table}:${id}`, Date.now());
  // Prune old entries
  const cutoff = Date.now() - 5000;
  for (const [k, t] of _recentLocalWrites) {
    if (t < cutoff) _recentLocalWrites.delete(k);
  }
}

function wasRecentLocalWrite(table, id) {
  const key = `${table}:${id}`;
  const t = _recentLocalWrites.get(key);
  return t && (Date.now() - t < 2000);
}

function handleLotChange(payload) {
  if (!_dispatch) return;
  const { eventType, new: newRow, old } = payload;
  const id = newRow?.id || old?.id;

  if (newRow) recordSeenRow('lots', id, newRow.updated_at, newRow.updated_by);

  if (wasRecentLocalWrite('lots', id)) return;

  // Conflict detection: if the local user was actively editing this row
  // and the change came from another user, emit a conflict event
  if (eventType === 'UPDATE' && newRow?.updated_by && newRow.updated_by !== _userId) {
    // Notify UI — the real-time update is about to override the user's view
    eventBus.emit('sync:conflict', {
      table: 'lots',
      id,
      otherUserId: newRow.updated_by,
      itemLabel: newRow.source_name || newRow.source || 'Lot',
    });
  }

  if (eventType === 'DELETE') {
    _dispatch({ type: 'DELETE_LOT', id: old.id, _fromSync: true });
  } else if (eventType === 'INSERT') {
    _dispatch({ type: 'ADD_LOT', lot: rowToLot(newRow), _fromSync: true });
  } else if (eventType === 'UPDATE') {
    _dispatch({ type: 'UPDATE_LOT', id: newRow.id, updates: rowToLot(newRow), _fromSync: true });
  }
}

function handleItemChange(payload) {
  if (!_dispatch) return;
  const { eventType, new: newRow, old } = payload;
  const id = newRow?.id || old?.id;

  if (newRow) recordSeenRow('items', id, newRow.updated_at, newRow.updated_by);

  if (wasRecentLocalWrite('items', id)) return;

  if (eventType === 'UPDATE' && newRow?.updated_by && newRow.updated_by !== _userId) {
    eventBus.emit('sync:conflict', {
      table: 'items',
      id,
      otherUserId: newRow.updated_by,
      itemLabel: [newRow.brand, newRow.model].filter(Boolean).join(' ') || newRow.serial_number || 'Item',
    });
  }

  if (eventType === 'DELETE') {
    _dispatch({ type: 'DELETE_ITEM', id: old.id, _fromSync: true });
  } else if (eventType === 'INSERT') {
    _dispatch({ type: 'ADD_ITEM', item: rowToItem(newRow), _fromSync: true });
  } else if (eventType === 'UPDATE') {
    _dispatch({ type: 'UPDATE_ITEM', id: newRow.id, updates: rowToItem(newRow), _fromSync: true });
  }
}

// ─── Initial download (new device / first login) ──────────────────────────

export async function downloadWorkspace(workspaceId) {
  if (!supabase) return { lots: [] };

  const { data: lotRows, error: lotErr } = await supabase
    .from('lots').select('*').eq('workspace_id', workspaceId);
  if (lotErr) { console.error('[sync] download lots:', lotErr); return { lots: [] }; }

  const { data: itemRows, error: itemErr } = await supabase
    .from('items').select('*').eq('workspace_id', workspaceId);
  if (itemErr) { console.error('[sync] download items:', itemErr); return { lots: [] }; }

  // Reconstruct the nested structure
  const lots = (lotRows || []).map(rowToLot);
  const itemsByLot = {};
  for (const row of itemRows || []) {
    const item = rowToItem(row);
    (itemsByLot[item.lotId] ||= []).push(item);
  }
  for (const lot of lots) {
    lot.items = itemsByLot[lot.id] || [];
  }

  // Download array-based tables and replace local storage
  for (const [storageKey, config] of Object.entries(ARRAY_SYNC_CONFIG)) {
    try {
      const { data, error } = await supabase.from(config.table).select('*').eq('workspace_id', workspaceId);
      if (error) { console.error(`[sync] download ${config.table}:`, error); continue; }
      const local = (data || []).map(config.fromRow);
      await window.storage.set(storageKey, local);
      _lastKnownArrays.set(storageKey, JSON.parse(JSON.stringify(local)));
    } catch (e) { console.error(`[sync] download ${config.table} threw:`, e); }
  }

  // Download workspace_settings
  try {
    const { data: ws } = await supabase.from('workspace_settings').select('*').eq('workspace_id', workspaceId).maybeSingle();
    if (ws) {
      for (const [storageKey, config] of Object.entries(OBJECT_SYNC_CONFIG)) {
        if (config.scope !== 'workspace') continue;
        if (ws[config.column] != null) await window.storage.set(storageKey, ws[config.column]);
      }
    }
  } catch (e) { console.error('[syncEngine] download workspace settings failed:', e); }

  // Download user_preferences
  try {
    const user = await getCurrentUser();
    if (user) {
      const { data: prefs } = await supabase.from('user_preferences').select('*').eq('user_id', user.id).maybeSingle();
      if (prefs) {
        for (const [storageKey, config] of Object.entries(OBJECT_SYNC_CONFIG)) {
          if (config.scope !== 'user') continue;
          if (prefs[config.column] != null) await window.storage.set(storageKey, prefs[config.column]);
        }
      }
    }
  } catch (e) { console.error('[syncEngine] download user preferences failed:', e); }

  return { lots };
}

// ─── Initial upload (first-time migration) ──────────────────────────────

export async function uploadLocalData(localLots, workspaceId, userId) {
  if (!supabase) return { success: false, error: 'Cloud not configured' };

  try {
    // Upload lots
    const lotRows = localLots.map(l => lotToRow(l, workspaceId, userId));
    if (lotRows.length > 0) {
      const { error: lotErr } = await supabase.from('lots').upsert(lotRows);
      if (lotErr) return { success: false, error: `Lots: ${lotErr.message}` };
    }

    // Upload items
    const itemRows = [];
    for (const lot of localLots) {
      for (const item of lot.items || []) {
        itemRows.push(itemToRow({ ...item, lotId: lot.id }, workspaceId, userId));
      }
    }
    if (itemRows.length > 0) {
      for (let i = 0; i < itemRows.length; i += 500) {
        const batch = itemRows.slice(i, i + 500);
        const { error: itemErr } = await supabase.from('items').upsert(batch);
        if (itemErr) return { success: false, error: `Items: ${itemErr.message}` };
      }
    }

    // Upload array-based tables (bids, transactions, sales_history)
    let otherCount = 0;
    for (const [storageKey, config] of Object.entries(ARRAY_SYNC_CONFIG)) {
      const local = (await window.storage.get(storageKey)) || [];
      if (!Array.isArray(local) || local.length === 0) continue;
      const rows = local.filter(x => x?.id).map(x => config.toRow(x, workspaceId));
      if (rows.length === 0) continue;
      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const { error } = await supabase.from(config.table).upsert(batch);
        if (error) return { success: false, error: `${config.table}: ${error.message}` };
      }
      otherCount += rows.length;
      // Seed the last-known cache so future writes diff correctly
      _lastKnownArrays.set(storageKey, JSON.parse(JSON.stringify(local)));
    }

    // Upload object-based settings + user preferences
    const wsPayload = { workspace_id: workspaceId, updated_at: new Date().toISOString(), updated_by: userId };
    const userPayload = { user_id: userId, workspace_id: workspaceId, updated_at: new Date().toISOString() };
    let hasWsData = false, hasUserData = false;

    for (const [storageKey, config] of Object.entries(OBJECT_SYNC_CONFIG)) {
      const val = await window.storage.get(storageKey);
      if (val == null) continue;
      if (config.scope === 'workspace') {
        wsPayload[config.column] = config.isNumber ? Number(val) : val;
        hasWsData = true;
      } else if (config.scope === 'user') {
        userPayload[config.column] = val;
        hasUserData = true;
      }
    }

    if (hasWsData) {
      const { error } = await supabase.from('workspace_settings').upsert(wsPayload, { onConflict: 'workspace_id' });
      if (error) console.error('[sync] upload workspace_settings:', error);
    }
    if (hasUserData) {
      const { error } = await supabase.from('user_preferences').upsert(userPayload, { onConflict: 'user_id' });
      if (error) console.error('[sync] upload user_preferences:', error);
    }

    return { success: true, lotCount: lotRows.length, itemCount: itemRows.length, otherCount };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

export async function start({ workspaceId, dispatch }) {
  if (_running) stop();
  const user = await getCurrentUser();
  if (!user) { console.warn('[sync] No user, not starting'); return; }

  _workspaceId = workspaceId;
  _userId = user.id;
  _dispatch = dispatch;
  _running = true;

  // Hydrate last-known array state so first writes don't look like deletes
  await hydrateArrayCache();

  // Hook into storage.set — fires for every write, we filter inside onArrayStorageWrite
  setSyncHook(onArrayStorageWrite);

  subscribeRealtime();
  setStatus('synced');

  // Online/offline detection
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
}

export function stop() {
  _running = false;
  setSyncHook(null);
  if (_channel && supabase) { supabase.removeChannel(_channel); _channel = null; }
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  setStatus('idle');
}

function handleOnline() {
  setStatus('syncing');
  flushWrites();
}

function handleOffline() {
  setStatus('offline');
}

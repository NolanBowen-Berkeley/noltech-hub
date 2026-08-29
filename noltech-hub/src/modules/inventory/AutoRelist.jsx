import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  RefreshCw, CheckSquare, Square, Filter, ArrowDown, Trash2,
  Edit, Package, Tag, Settings, Plus, X, SkipForward, Scissors, Zap,
  AlertTriangle, CheckCircle, Loader2, ExternalLink,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import eventBus from '../../services/eventBus';
import { formatCurrency, formatDate, today } from '../../utils/formatters';
import { CATEGORIES, PIPELINE_BASE, EBAY_TOKEN_KEY } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import { Button, Input, Label, Select } from '../../components/ui';

// ─── Constants ───────────────────────────────────────────────────────────────

const CONFIG_KEY = 'noltech:autorelist:config';
const SKIPPED_KEY = 'noltech:autorelist:skipped';
const RELIST_LOG_KEY = 'noltech:autorelist:log';
const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const DEFAULT_CONFIG = {
  enabled: true,
  daysThreshold: 30,
  rules: [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysSince(isoDate) {
  if (!isoDate) return Infinity;
  const d = isoDate.includes('T') ? new Date(isoDate) : new Date(isoDate + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function uuid() {
  return crypto.randomUUID?.() || Math.random().toString(36).slice(2, 10);
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-4 flex flex-col gap-1">
      <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-bold" style={{ ...MONO, color }}>{value}</span>
      {sub && <span className="text-xs text-fg-subtle">{sub}</span>}
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      {[...Array(6)].map((_, i) => (
        <td key={i} className="px-4 py-3"><div className="h-4 bg-muted rounded w-3/4" /></td>
      ))}
    </tr>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AutoRelist() {
  const { state, dispatch } = useApp();

  // State
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [skipped, setSkipped] = useState([]);
  const [relistLog, setRelistLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [relisting, setRelisting] = useState(null); // itemId or 'all'
  const [syncing, setSyncing] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({ category: '', daysThreshold: '' });
  const [actionMessage, setActionMessage] = useState(null);

  // ── Load from storage ────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      window.storage.get(CONFIG_KEY).catch(() => null),
      window.storage.get(SKIPPED_KEY).catch(() => null),
      window.storage.get(RELIST_LOG_KEY).catch(() => null),
    ])
      .then(([cfg, skip, log]) => {
        if (cfg && typeof cfg === 'object') setConfig({ ...DEFAULT_CONFIG, ...cfg });
        if (Array.isArray(skip)) setSkipped(skip);
        if (Array.isArray(log)) setRelistLog(log);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Couldn't load auto-relist data");
        setLoading(false);
      });
  }, []);

  // ── Persist helpers ──────────────────────────────────────────────────────
  const saveConfig = useCallback(async (next) => {
    setConfig(next);
    try { await window.storage.set(CONFIG_KEY, next); } catch (e) { console.error('Config save error:', e); }
  }, []);

  const saveSkipped = useCallback(async (next) => {
    setSkipped(next);
    try { await window.storage.set(SKIPPED_KEY, next); } catch (e) { console.error('Skipped save error:', e); }
  }, []);

  const saveRelistLog = useCallback(async (next) => {
    setRelistLog(next);
    try { await window.storage.set(RELIST_LOG_KEY, next); } catch (e) { console.error('Relist log save error:', e); }
  }, []);

  // ── Flatten all items ────────────────────────────────────────────────────
  const allItems = useMemo(() => {
    return (state.lots || []).flatMap((lot) =>
      (lot.items || []).map((item) => ({
        ...item,
        displayName: [item.brand, item.model].filter(Boolean).join(' ') || 'Unnamed Item',
        lotName: lot.sourceName || lot.source || 'Unknown Lot',
        lotPurchaseDate: lot.purchaseDate,
      }))
    );
  }, [state.lots]);

  // ── Count previous relists from log ──────────────────────────────────────
  const relistCounts = useMemo(() => {
    const counts = {};
    relistLog.forEach(entry => {
      counts[entry.itemId] = (counts[entry.itemId] || 0) + 1;
    });
    return counts;
  }, [relistLog]);

  // ── Build relist queue ───────────────────────────────────────────────────
  const relistQueue = useMemo(() => {
    if (!config.enabled) return [];

    return allItems
      .filter((item) => {
        if (item.status !== 'listed') return false;
        if (skipped.includes(item.id)) return false;
        if (!item.ebayItemId) return false; // Need eBay item ID to relist

        const categoryRule = config.rules.find((r) => r.category === item.category);
        const threshold = categoryRule ? categoryRule.daysThreshold : config.daysThreshold;
        const listedDate = item.dateAdded || item.lotPurchaseDate;
        const age = daysSince(listedDate);

        return age >= threshold;
      })
      .map((item) => {
        const listedDate = item.dateAdded || item.lotPurchaseDate;
        const daysListed = daysSince(listedDate);
        const currentPrice = item.listingPrice || item.estimatedValue || 0;
        const prevRelists = relistCounts[item.id] || 0;

        return { ...item, currentPrice, daysListed, prevRelists };
      })
      .sort((a, b) => b.daysListed - a.daysListed);
  }, [allItems, config, skipped, relistCounts]);

  // ── Stats ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const previouslyRelisted = relistLog.length;
    const noEbayId = allItems.filter(i => i.status === 'listed' && !i.ebayItemId).length;
    return { queueCount: relistQueue.length, previouslyRelisted, noEbayId };
  }, [relistQueue, allItems, relistLog]);

  // ── Get eBay credentials ────────────────────────────────────────────────
  const getEbayCreds = useCallback(async () => {
    try {
      const raw = await window.storage.get(EBAY_TOKEN_KEY);
      const creds = await decryptObject(raw || {});
      return {
        userToken: creds?.token?.trim() || '',
        appId: creds?.appId?.trim() || '',
        devId: creds?.devId?.trim() || '',
        certId: creds?.certId?.trim() || '',
      };
    } catch { return null; }
  }, []);

  // ── Relist one item on eBay ─────────────────────────────────────────────
  const relistItem = useCallback(async (item) => {
    setRelisting(item.id);
    try {
      const creds = await getEbayCreds();
      if (!creds?.userToken) {
        setActionMessage({ type: 'error', text: 'eBay user token not configured. Go to Settings > eBay Credentials.' });
        setRelisting(null);
        return;
      }

      const resp = await fetch(`${PIPELINE_BASE}/api/ebay/relist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...creds, itemId: item.ebayItemId }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();

      if (data.success) {
        // Update the item with the new eBay item ID and refresh the listed date
        dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: {
          ebayItemId: data.newItemId,
          dateAdded: new Date().toISOString(),
        }});

        const logEntry = {
          itemId: item.id, displayName: item.displayName,
          oldEbayId: item.ebayItemId, newEbayId: data.newItemId,
          insertionFee: data.insertionFee || 0,
          date: new Date().toISOString(),
        };
        await saveRelistLog([logEntry, ...relistLog]);

        eventBus.emit('notification:push', {
          type: 'success', title: 'Relisted on eBay',
          message: `${item.displayName} is now a fresh listing`,
        });
        setActionMessage({ type: 'success', text: `Relisted ${item.displayName} (new ID: ${data.newItemId})` });
      } else {
        // If the listing was ended but AddItem failed, mark it so it leaves the queue
        if (data.ended) {
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { status: 'received', ebayItemId: null } });
          setActionMessage({ type: 'error', text: `Failed: ${data.error}. Item removed from queue (listing was ended on eBay).` });
        } else {
          setActionMessage({ type: 'error', text: `Failed: ${data.error}` });
        }
      }
    } catch (e) {
      setActionMessage({ type: 'error', text: `Relist failed: ${e.message}` });
    }
    setRelisting(null);
    setTimeout(() => setActionMessage(null), 5000);
  }, [dispatch, getEbayCreds, relistLog, saveRelistLog]);

  // ── Relist all ──────────────────────────────────────────────────────────
  const relistAll = useCallback(async () => {
    setRelisting('all');
    const creds = await getEbayCreds();
    if (!creds?.userToken) {
      setActionMessage({ type: 'error', text: 'eBay user token not configured.' });
      setRelisting(null);
      return;
    }

    let success = 0, failed = 0;
    const newLog = [...relistLog];

    for (const item of relistQueue) {
      try {
        const resp = await fetch(`${PIPELINE_BASE}/api/ebay/relist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...creds, itemId: item.ebayItemId }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await resp.json();

        if (data.success) {
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: {
            ebayItemId: data.newItemId,
            dateAdded: new Date().toISOString(),
          }});
          newLog.unshift({
            itemId: item.id, displayName: item.displayName,
            oldEbayId: item.ebayItemId, newEbayId: data.newItemId,
            insertionFee: data.insertionFee || 0,
            date: new Date().toISOString(),
          });
          success++;
        } else {
          if (data.ended) {
            dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { status: 'received', ebayItemId: null } });
          }
          failed++;
        }
        // Delay between relists to avoid rate limiting
        await new Promise(r => setTimeout(r, 2000));
      } catch {
        failed++;
      }
    }

    await saveRelistLog(newLog);
    setRelisting(null);
    eventBus.emit('notification:push', {
      type: failed > 0 ? 'warning' : 'success',
      title: 'Batch Relist Complete',
      message: `${success} relisted${failed > 0 ? `, ${failed} failed` : ''}`,
    });
    setActionMessage({ type: 'success', text: `Relisted ${success} item${success !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}` });
    setTimeout(() => setActionMessage(null), 5000);
  }, [dispatch, getEbayCreds, relistQueue, relistLog, saveRelistLog]);

  // ── Skip item ────────────────────────────────────────────────────────────
  const skipItem = useCallback(async (itemId) => {
    const next = [...skipped, itemId];
    await saveSkipped(next);
  }, [skipped, saveSkipped]);

  // ── Add category rule ────────────────────────────────────────────────────
  const addRule = useCallback(() => {
    if (!ruleForm.category || !ruleForm.daysThreshold) return;
    const rule = {
      id: uuid(),
      category: ruleForm.category,
      daysThreshold: Number(ruleForm.daysThreshold),
    };
    const next = { ...config, rules: [...config.rules, rule] };
    saveConfig(next);
    setRuleForm({ category: '', daysThreshold: '' });
    setShowRuleForm(false);
  }, [ruleForm, config, saveConfig]);

  const deleteRule = useCallback((ruleId) => {
    const next = { ...config, rules: config.rules.filter((r) => r.id !== ruleId) };
    saveConfig(next);
  }, [config, saveConfig]);

  // ── Loading / Error states ───────────────────────────────────────────────
  if (state.loading || loading) {
    return (
      <div className="space-y-6">
        <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-muted rounded w-1/3" />
            <div className="h-4 bg-muted rounded w-2/3" />
            <div className="h-10 bg-muted rounded w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (error || state.error) {
    return (
      <div className="bg-surface rounded-xl border border-danger/30 shadow-sm p-6">
        <div className="flex items-center gap-3 text-danger">
          <RefreshCw className="w-5 h-5" />
          <div>
            <p className="font-semibold">Couldn't load auto-relist data</p>
            <p className="text-sm text-danger">{error || state.error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Action message toast ──────────────────────────────────────────── */}
      {actionMessage && (
        <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
          actionMessage.type === 'success' ? 'bg-success-subtle text-success border border-success/30' : 'bg-danger-subtle text-danger border border-danger/30'
        }`}>
          {actionMessage.text}
        </div>
      )}

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Ready to Relist" value={stats.queueCount} sub="stale listings over threshold" color="var(--accent)" />
        <StatCard label="Previously Relisted" value={stats.previouslyRelisted} sub="total relists performed" color="var(--accent-hover)" />
        <StatCard label="No eBay ID" value={stats.noEbayId} sub="sync eBay to get item IDs" color="var(--warning)" />
      </div>

      {/* ── Warning if no eBay credentials ── */}
      {stats.noEbayId > 0 && (
        <div className="flex items-start gap-2 bg-warning-subtle border border-warning/30 rounded-xl px-4 py-3 text-xs text-warning">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{stats.noEbayId} listed item{stats.noEbayId !== 1 ? 's' : ''} missing eBay Item ID. Run eBay Sync to pull your active listings so they can be relisted.</span>
        </div>
      )}

      {/* ── Global Settings ───────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-5">
          <Settings className="w-5 h-5 text-fg-muted" />
          <h3 className="text-lg font-semibold text-fg">Global Settings</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Enable toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Auto-Relist</label>
            <button
              onClick={() => saveConfig({ ...config, enabled: !config.enabled })}
              className={`h-10 rounded-lg font-medium text-sm transition-colors ${
                config.enabled
                  ? 'bg-success-subtle text-success border border-success/30 hover:bg-success-subtle'
                  : 'bg-muted text-fg-muted border border-border-strong hover:bg-muted'
              }`}
            >
              {config.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          {/* Days threshold */}
          <div className="flex flex-col gap-1.5">
            <Label>Days Before Relist</Label>
            <Input
              type="number"
              min={1}
              value={config.daysThreshold}
              onChange={(e) => saveConfig({ ...config, daysThreshold: Math.max(1, Number(e.target.value)) })}
              className="font-mono"
            />
          </div>
        </div>
        <p className="text-xs text-fg-subtle mt-3">
          Relisting ends the listing on eBay and immediately creates a new one from it. eBay's algorithm treats relisted items as fresh listings, boosting visibility. The item keeps the same title, photos, and price.
        </p>
      </div>

      {/* ── Category Rules ────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Tag className="w-5 h-5 text-fg-muted" />
            <h3 className="text-lg font-semibold text-fg">Category Rules</h3>
            <span className="text-xs text-fg-subtle">Override global defaults per category</span>
          </div>
          <button
            onClick={() => setShowRuleForm(!showRuleForm)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-info-subtle text-info border border-info/30 hover:bg-info-subtle transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add Rule
          </button>
        </div>

        {/* Add rule form */}
        {showRuleForm && (
          <div className="flex flex-wrap items-end gap-3 mb-4 p-4 bg-muted/40 rounded-lg border border-border">
            <div className="flex flex-col gap-1">
              <Label>Category</Label>
              <Select
                size="sm"
                value={ruleForm.category}
                onChange={(e) => setRuleForm({ ...ruleForm, category: e.target.value })}
              >
                <option value="">Select...</option>
                {CATEGORIES.filter((c) => !config.rules.some((r) => r.category === c.value)).map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Days Before Relist</Label>
              <Input
                size="sm"
                type="number"
                min={1}
                value={ruleForm.daysThreshold}
                onChange={(e) => setRuleForm({ ...ruleForm, daysThreshold: e.target.value })}
                className="w-20 font-mono"
                placeholder="21"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="accent"
                size="sm"
                onClick={addRule}
                disabled={!ruleForm.category || !ruleForm.daysThreshold}
              >
                Add
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setShowRuleForm(false); setRuleForm({ category: '', daysThreshold: '' }); }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Rules list */}
        {config.rules.length === 0 ? (
          <p className="text-sm text-fg-subtle italic">No category-specific rules. Global defaults will apply to all categories.</p>
        ) : (
          <div className="space-y-2">
            {config.rules.map((rule) => {
              const cat = CATEGORIES.find((c) => c.value === rule.category);
              return (
                <div key={rule.id} className="flex items-center justify-between px-4 py-2.5 bg-muted/40 rounded-lg border border-border">
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium text-fg">{cat?.label || rule.category}</span>
                    <span className="text-xs text-fg-muted">
                      relist after <span className="font-mono font-semibold">{rule.daysThreshold}</span> days
                    </span>
                  </div>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="p-1 rounded hover:bg-danger-subtle text-fg-subtle hover:text-danger transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Relist Queue ──────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-5 h-5 text-fg-muted" />
            <h3 className="text-lg font-semibold text-fg">Relist Queue</h3>
            <span className="text-xs text-fg-subtle">{relistQueue.length} items</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setSyncing(true);
                try {
                  const creds = await getEbayCreds();
                  if (!creds?.userToken) { setActionMessage({ type: 'error', text: 'eBay token not configured' }); setSyncing(false); return; }
                  const resp = await fetch(`${PIPELINE_BASE}/api/ebay/active-listings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(creds),
                    signal: AbortSignal.timeout(30000),
                  });
                  const data = await resp.json();
                  if (data.success && data.listings) {
                    // Update inventory items with real eBay listing start dates
                    let updated = 0;
                    for (const listing of data.listings) {
                      // Find matching inventory item by ebayItemId or SKU
                      const match = allItems.find(i =>
                        i.ebayItemId === listing.itemId ||
                        (listing.sku && i.serialNumber === listing.sku) ||
                        (listing.sku && i.sku === listing.sku)
                      );
                      if (match && listing.startTime) {
                        dispatch({ type: 'UPDATE_ITEM', id: match.id, updates: {
                          ebayItemId: listing.itemId,
                          dateAdded: listing.startTime,
                          listingPrice: listing.price || match.listingPrice,
                        }});
                        updated++;
                      }
                    }
                    setActionMessage({ type: 'success', text: `Found ${data.total} active listings, updated ${updated} items` });
                  } else {
                    setActionMessage({ type: 'error', text: data.error || 'Sync failed' });
                  }
                } catch (e) { setActionMessage({ type: 'error', text: e.message }); }
                setSyncing(false);
                setTimeout(() => setActionMessage(null), 4000);
              }}
              disabled={syncing}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-fg-muted text-sm font-medium hover:bg-muted/40 disabled:opacity-50 transition-colors"
              title="Sync eBay listings to refresh queue"
            >
              {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {syncing ? 'Syncing...' : 'Sync eBay'}
            </button>
            {relistQueue.length > 0 && (
              <button
                onClick={relistAll}
                disabled={relisting === 'all'}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-success text-white text-sm font-medium hover:bg-success/90 disabled:opacity-50 transition-colors"
              >
                {relisting === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                {relisting === 'all' ? 'Relisting...' : `Relist All (${relistQueue.length})`}
              </button>
            )}
          </div>
        </div>

        {!config.enabled ? (
          <div className="flex flex-col items-center justify-center py-12 text-fg-subtle">
            <RefreshCw className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm font-medium">Auto-relist is disabled</p>
            <p className="text-xs mt-1">Enable it in the settings above to see queued items</p>
          </div>
        ) : relistQueue.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-fg-subtle">
            <Package className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm font-medium">No items need repricing</p>
            <p className="text-xs mt-1">Items will appear here when they exceed the days threshold</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Item</th>
                  <th className="text-center px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Days Listed</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Price</th>
                  <th className="text-center px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">eBay ID</th>
                  <th className="text-center px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Relists</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>
                {relistQueue.map((item, idx) => (
                  <tr key={item.id} className={idx % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-fg">{item.displayName}</div>
                      <div className="text-xs text-fg-subtle">{item.lotName}</div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                        item.daysListed >= 90 ? 'bg-danger-subtle text-danger' :
                        item.daysListed >= 60 ? 'bg-warning-subtle text-warning' :
                        'bg-warning-subtle text-warning'
                      }`}>
                        {item.daysListed}d
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-fg" style={MONO}>
                      {formatCurrency(item.currentPrice)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-[10px] font-mono text-fg-muted">{item.ebayItemId}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="font-mono text-fg-muted" style={MONO}>{item.prevRelists}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => relistItem(item)}
                          disabled={relisting === item.id || relisting === 'all'}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-success-subtle text-success text-xs font-medium border border-success/30 hover:bg-success-subtle disabled:opacity-50 transition-colors"
                          title="End and relist on eBay"
                        >
                          {relisting === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                          {relisting === item.id ? 'Relisting...' : 'Relist'}
                        </button>
                        <button
                          onClick={() => skipItem(item.id)}
                          className="p-1 rounded-md bg-muted/40 text-fg-subtle border border-border hover:bg-muted hover:text-fg-muted transition-colors"
                          title="Skip this item"
                        >
                          <SkipForward className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

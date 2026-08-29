// ─── All Supabase writes the Worker performs ────────────────────────────────
// Centralized so the pipeline doesn't sprinkle .from(...).upsert(...) calls
// everywhere. Each helper batches as much as PostgREST allows.

const BATCH_SIZE = 100;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Ensure the "ebay-sync-lot" exists. Idempotent. Called once per tick before
// any items get inserted. Returns the lot row.
export async function ensureEbaySyncLot({ supabase, workspaceId, lotId }) {
  const { data: existing } = await supabase
    .from('lots').select('id').eq('workspace_id', workspaceId).eq('id', lotId).maybeSingle();
  if (existing) return existing;
  // source/source_name match the Hub's own EBAY_SYNC_LOT auto-create
  // (useSyncAll.js) so the upsert is genuinely idempotent across both
  // writers — without alignment, the Hub would create a competing lot
  // with source='other' on first user-side Sync All.
  const { error } = await supabase.from('lots').upsert({
    id: lotId,
    workspace_id: workspaceId,
    source: 'other',
    source_name: 'eBay Auto-sync',
    purchase_date: null,
    cost: 0,
    item_count: 0,
    status: 'received',
    notes: 'Catch-all lot for eBay sync. Stub items from orders without inventory match are parked here until reclassified.',
  }, { onConflict: 'id' });
  if (error) console.error('[ebay-sync] ensureEbaySyncLot failed:', error.message);
  return { id: lotId };
}

// Upsert items in batches. Mix of stubs (new INSERTs) and updates (existing
// items whose sale jsonb changed) — both flow through upsert keyed by id.
export async function upsertItems({ supabase, items }) {
  if (!items?.length) return { upserted: 0, errors: [] };
  let upserted = 0;
  const errors = [];
  for (const batch of chunk(items, BATCH_SIZE)) {
    const { error, count } = await supabase
      .from('items')
      .upsert(batch, { onConflict: 'id', count: 'exact' });
    if (error) {
      console.error('[ebay-sync] items batch upsert failed, falling back per-row:', error.message);
      // Per-row fallback so one poisoned row doesn't drop the others.
      for (const row of batch) {
        const { error: e2 } = await supabase.from('items').upsert(row, { onConflict: 'id' });
        if (e2) errors.push({ id: row.id, error: e2.message.slice(0, 200) });
        else upserted++;
      }
    } else {
      upserted += (count ?? batch.length);
    }
  }
  return { upserted, errors };
}

// Insert raw Finances events. The unique constraint (workspace_id, ebay_txn_id)
// + ignoreDuplicates makes this a no-op on re-runs of the same window.
export async function insertFinancesEvents({ supabase, workspaceId, events }) {
  if (!events?.length) return { inserted: 0, errors: [] };
  const rows = events.map((e) => ({
    workspace_id:       workspaceId,
    ebay_txn_id:        e.id,
    event_type:         e.type,
    fee_type:           e.feeType || null,
    order_id:           e.orderId || null,
    order_line_item_id: e.orderLineItemId || null,
    amount:             Math.abs(Number(e.amount) || 0),
    currency:           e.currency || 'USD',
    memo:               e.memo || null,
    occurred_at:        e.date || new Date().toISOString(),
    raw_payload:        e,
  }));
  let inserted = 0;
  const errors = [];
  for (const batch of chunk(rows, BATCH_SIZE)) {
    const { error, count } = await supabase
      .from('finances_events')
      .upsert(batch, { onConflict: 'workspace_id,ebay_txn_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.error('[ebay-sync] finances_events upsert failed:', error.message);
      errors.push(error.message.slice(0, 200));
    } else {
      inserted += (count ?? 0);
    }
  }
  return { inserted, errors };
}

// Refund / credit / dispute rows mirror what useEventBridge.sale:refunded
// would write. importId scheme matches so the Hub's importId dedup catches
// any Hub-side duplicate emission on the same orderId.
//
// Column allowlist: workspace_id, id, source, import_id, order_id, date, type,
// category, description, amount, notes. The transactions table does NOT have
// supplier or payment_method columns (the Hub stores those in-memory only and
// strips them before cloud sync). Writing either would PGRST204 the insert.
export async function insertRefundTransactions({ supabase, workspaceId, refundEvents }) {
  if (!refundEvents?.length) return { inserted: 0, errors: [] };
  // All entries here are pre-filtered in financesAggregate.js to require
  // orderId — matching Hub useSyncAll.js:469 — so importId scheme is
  // always `auto_refund:${orderId}`, bit-identical to the Hub's.
  const rows = refundEvents.map((r) => ({
    workspace_id: workspaceId,
    id:           crypto.randomUUID(),
    source:       'auto_refund',
    import_id:    `auto_refund:${r.orderId}`,
    order_id:     r.orderId,
    date:         (r.date || new Date().toISOString()).slice(0, 10),
    type:         'expense',
    category:     'Returns & Refunds',
    description:  `eBay refund — order ${r.orderId}`,
    amount:       Number(r.amount) || 0,
    notes:        `${r.reason ? `Reason: ${r.reason}. ` : ''}Auto-recorded by ebay-sync Worker (${r.type}). Gross sale row left intact for 1099-K reconciliation.`,
  }));
  let inserted = 0;
  const errors = [];
  for (const batch of chunk(rows, BATCH_SIZE)) {
    const { error, count } = await supabase
      .from('transactions')
      .upsert(batch, { onConflict: 'workspace_id,import_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.error('[ebay-sync] refund transactions upsert failed:', error.message);
      errors.push(error.message.slice(0, 200));
    } else {
      inserted += (count ?? 0);
    }
  }
  return { inserted, errors };
}

// Upsert the per-workspace sync_state row with the latest tick summary.
export async function upsertSyncState({ supabase, workspaceId, patch }) {
  const { error } = await supabase
    .from('sync_state')
    .upsert({
      workspace_id: workspaceId,
      ...patch,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id' });
  if (error) console.error('[ebay-sync] sync_state upsert failed:', error.message);
  return { error: error?.message || null };
}

// Heartbeat row that the Hub's SystemHealthCard subscribes to. Lets the user
// see "Cloud eBay sync: ran 3 min ago" without inspecting Supabase manually.
//
// KEEP IN SYNC with EBAY_SYNC_AGENT_ID in
// noltech-hub/src/utils/constants.js. The Hub queries agent_heartbeats
// keyed by this exact string — renaming here without updating the Hub
// silently breaks the System Health "eBay Sync Worker" tile.
export const EBAY_SYNC_AGENT_ID = 'ebay-sync-worker';

export async function upsertAgentHeartbeat({ supabase, workspaceId, status, summary }) {
  try {
    const { error } = await supabase
      .from('agent_heartbeats')
      .upsert({
        agent_id:        EBAY_SYNC_AGENT_ID,
        workspace_id:    workspaceId,
        hostname:        'cloudflare',
        status,
        last_run_at:     new Date().toISOString(),
        last_run_summary: summary || {},
      }, { onConflict: 'agent_id,workspace_id' });
    if (error) console.error('[ebay-sync] heartbeat upsert failed:', error.message);
  } catch (e) {
    // agent_heartbeats may not exist in older Supabase schemas — non-fatal.
    console.error('[ebay-sync] heartbeat skipped:', e.message);
  }
}

// ─── Order-to-Item matching via Supabase ─────────────────────────────────────
// Replaces useSyncAll's in-memory skuMap/existingMap/orderIdMap with three
// batched Supabase queries. Same priority ordering as the Hub:
//   Tier 1: serial_number / sku match  (serial_number wins on collision)
//   Tier 2: ebay_item_id match (for multi-quantity listings)
//   Tier 3: sale->>id match (catches items whose sku/itemId got cleared
//           but still have the original sale.id attached)
//
// Result for each order: { matchedItemId, lotId, tier } or null. Caller
// decides whether to stub-create or skip.

const EBAY_SYNC_LOT_ID = 'ebay-sync-lot';

function dedupe(arr) { return Array.from(new Set(arr.filter(Boolean).map(String))); }

export async function buildMatchMaps({ supabase, workspaceId, orders }) {
  const skus     = dedupe(orders.flatMap((o) => [o.sku].filter(Boolean)));
  const itemIds  = dedupe(orders.flatMap((o) => [o.ebayItemId].filter(Boolean)));
  const orderIds = dedupe(orders.map((o) => o.orderId).filter(Boolean));

  // Three IN queries. Each returns a small set; total subrequests = 3.
  const [snRes, skuRes, eiidRes, saleRes] = await Promise.all([
    skus.length
      ? supabase.from('items').select('id, lot_id, sale, status, brand, model, serial_number, sku, ebay_item_id')
          .eq('workspace_id', workspaceId).in('serial_number', skus)
      : Promise.resolve({ data: [], error: null }),
    skus.length
      ? supabase.from('items').select('id, lot_id, sale, status, brand, model, serial_number, sku, ebay_item_id')
          .eq('workspace_id', workspaceId).in('sku', skus)
      : Promise.resolve({ data: [], error: null }),
    itemIds.length
      ? supabase.from('items').select('id, lot_id, sale, status, brand, model, serial_number, sku, ebay_item_id')
          .eq('workspace_id', workspaceId).in('ebay_item_id', itemIds)
      : Promise.resolve({ data: [], error: null }),
    // Tier 3 needs a different query: items where sale->>id IN (orderIds).
    // PostgREST: `sale->>id=in.(o1,o2,o3)`. Use the contains-by-or form.
    orderIds.length
      ? supabase.from('items').select('id, lot_id, sale, status')
          .eq('workspace_id', workspaceId).in('sale->>id', orderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  for (const [tag, res] of [['serial', snRes], ['sku', skuRes], ['ebay_item_id', eiidRes], ['sale.id', saleRes]]) {
    if (res?.error) console.error(`[ebay-sync] match query ${tag} failed:`, res.error.message);
  }

  // serial_number wins over sku on collision (same as useSyncAll).
  const bySerial = new Map(); for (const it of (snRes.data || []))   if (it.serial_number) bySerial.set(String(it.serial_number), it);
  const bySku    = new Map(); for (const it of (skuRes.data || []))  if (it.sku)           bySku.set(String(it.sku), it);
  const byEiid   = new Map(); for (const it of (eiidRes.data || [])) if (it.ebay_item_id)  byEiid.set(String(it.ebay_item_id), it);
  const byOrderId = new Map();
  for (const it of (saleRes.data || [])) {
    const oid = it.sale?.id;
    if (oid && !byOrderId.has(String(oid))) byOrderId.set(String(oid), it);
  }
  return { bySerial, bySku, byEiid, byOrderId };
}

// Returns the match record for one order, or null. Caller decides stub vs skip.
export function matchOrder(order, maps) {
  const sku = order.sku ? String(order.sku) : null;
  const eiid = order.ebayItemId ? String(order.ebayItemId) : null;
  const oid = order.orderId ? String(order.orderId) : null;

  if (sku) {
    const sn = maps.bySerial.get(sku);
    if (sn) return { item: sn, tier: 'serial_number' };
    const s = maps.bySku.get(sku);
    if (s) return { item: s, tier: 'sku' };
  }
  if (eiid) {
    const i = maps.byEiid.get(eiid);
    if (i) return { item: i, tier: 'ebay_item_id' };
  }
  if (oid) {
    const o = maps.byOrderId.get(oid);
    if (o) return { item: o, tier: 'sale.id' };
  }
  return null;
}

// Build a stub item row for an unmatched order. Hub's realtime subscription
// will pick it up and useEventBridge will fire buildAutoRowsForSale once it
// lands locally — producing the bookkeeping rows the Worker can't emit itself.
//
// Shape mirrors useSyncAll.js:644-665 stub creation. NOTE: the items table
// has NO `qty` column — qty lives inside the `sale` jsonb (saleObject.qty)
// because items are per-physical-unit in the Hub data model. Adding qty
// here would PGRST204 the insert. listing_price is left as a single-unit
// estimate — the per-line-item sale.salePrice carries the order-level total.
export function buildStubItem({ workspaceId, order, saleObject }) {
  const id = crypto.randomUUID();
  const price = Number(order.price) || 0;
  return {
    id,
    workspace_id: workspaceId,
    lot_id: EBAY_SYNC_LOT_ID,
    serial_number: order.sku || null,
    sku: order.sku || null,
    ebay_item_id: order.ebayItemId || null,
    brand: '',
    model: order.title || '',
    category: 'other',
    status: 'sold',
    condition_on_arrival: 'unknown',
    cost_basis: 0,
    listing_price: price > 0 ? Math.round(price * 100) / 100 : null,
    date_added: order.date || new Date().toISOString(),
    sale: saleObject,
    notes: `origin=ebay-stub auto_created_at=${new Date().toISOString()}. Cost basis defaults to $0; edit if known.`,
    updated_at: new Date().toISOString(),
  };
}

export { EBAY_SYNC_LOT_ID };

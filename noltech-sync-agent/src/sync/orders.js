// ─── Orders sync (Pi → Supabase) ─────────────────────────────────────────────
// Mirrors useSyncAll's "Step 2" — pulls eBay GetOrders, merges Finances API
// data (ad fees + real label costs), reconciles eBay International Shipping
// (eIS) inflation, matches each order to a Supabase inventory item, builds
// the canonical sale object, upserts the item with status='sold', and
// generates the bookkeeping row family (income + fees + ad fee + shipping)
// in the transactions table.
//
// Differences vs. desktop:
//   • No auto-creation of stub items. The desktop creates a placeholder
//     inventory row when an order has no matching item; here we just push
//     the order to a `skipped` log array. This keeps the agent simple for
//     v1 — Nolan can review skipped orders in the desktop's eBay Match UI
//     after the next listings sync repopulates inventory.
//   • Transactions table dedup: import_id has a UNIQUE(workspace_id,
//     import_id) index, so we upsert with onConflict on (workspace_id,
//     import_id) — re-runs are no-ops when the row hasn't changed.
//   • No eventBus, no toast, no sale:recorded event. The bookkeeping rows
//     are built directly from the same buildAutoRowsForSale helper.
//
// Returns { soldCount, skippedCount, skipped, financesAdFeeUpdates,
//           financesLabelUpdates }.

import { parseBrand } from '../lib/itemMapping.js';
import { getEbayAccessToken, invalidateEbayAccessToken } from '../ebayAuth.js';
import { fetchFinancesByOrder } from './finances.js';
import { buildAutoRowsForSale, transactionToRow } from './buildAutoRows.js';

const ORDERS_TIMEOUT_MS = 60000;

// Merge Finances-API ad-fee buckets into an existing fee breakdown.
// Finances values are AUTHORITATIVE for the buckets they cover — REPLACE
// existing values, don't add. (Adding caused triple-counting when
// GetOrders already had AdFeeGeneral inline AND the Finances API also
// returned it.)
function applyAdFees(baseFees, baseBreakdown, bucket) {
  if (!bucket) return { totalFees: baseFees, breakdown: baseBreakdown };
  const breakdown = { ...(baseBreakdown || {}) };
  let netDelta = 0;
  for (const [k, v] of Object.entries(bucket)) {
    const previous = Number(breakdown[k]) || 0;
    const next = Math.round(v * 100) / 100;
    breakdown[k] = next;
    netDelta += (next - previous);
  }
  return {
    totalFees: Math.round(((baseFees || 0) + netDelta) * 100) / 100,
    breakdown,
  };
}

export async function syncOrders({ supabase, workspaceId, pipelineUrl, ebayCreds, logger }) {
  // ── Step A: resolve OAuth + Finances data ────────────────────────────────
  let accessToken = null;
  try {
    accessToken = await getEbayAccessToken({ pipelineUrl, ebayCreds });
  } catch (err) {
    logger?.error({ err: err.message }, '[orders] OAuth refresh failed');
  }

  const finances = await fetchFinancesByOrder({ pipelineUrl, accessToken, logger });
  if (finances.authError) {
    // Drop cached token so the next run forces a fresh mint.
    await invalidateEbayAccessToken();
  }
  const { adFeesByOrderId, labelCostByOrderId } = finances;

  // ── Step B: fetch orders from the pipeline (Trading API GetOrders) ────────────
  const ordersRes = await fetch(`${pipelineUrl}/api/ebay/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userToken: ebayCreds.userToken || ebayCreds.token,
      appId:  ebayCreds.appId  || '',
      devId:  ebayCreds.devId  || '',
      certId: ebayCreds.certId || '',
    }),
    signal: AbortSignal.timeout(ORDERS_TIMEOUT_MS),
  });
  const ordersData = await ordersRes.json();
  if (!ordersData.success) {
    throw new Error(ordersData.error || 'Orders fetch failed');
  }

  // ── Step C: load every existing item in this workspace into lookup maps ──
  // We need: id, sku, serial_number, ebay_item_id, brand, model, status, sale,
  // cost_basis, lot_id — same fields the desktop's existingMap/skuMap/
  // orderIdMap/itemById builds need.
  const { data: itemRows, error: selErr } = await supabase
    .from('items')
    .select('id, lot_id, sku, serial_number, ebay_item_id, brand, model, status, sale, cost_basis')
    .eq('workspace_id', workspaceId);
  if (selErr) {
    throw new Error(`Supabase items SELECT failed: ${selErr.message}`);
  }

  // skuMap: serial_number wins on collisions (same precedence as desktop)
  const skuMap = new Map();
  for (const r of itemRows || []) {
    if (r.serial_number) skuMap.set(r.serial_number, r.id);
  }
  for (const r of itemRows || []) {
    if (r.sku && !skuMap.has(r.sku)) skuMap.set(r.sku, r.id);
  }
  const existingByEbayId = new Map();
  for (const r of itemRows || []) {
    if (r.ebay_item_id) existingByEbayId.set(r.ebay_item_id, r.id);
  }
  const orderIdMap = new Map();
  for (const r of itemRows || []) {
    const sId = r.sale && (r.sale.id || r.sale.orderId);
    if (sId) orderIdMap.set(String(sId), r.id);
  }
  const itemById = new Map((itemRows || []).map((r) => [r.id, r]));

  // ── Step D: walk every order, decide upsert vs. skip ─────────────────────
  let soldCount = 0;
  let financesAdFeeUpdates = 0;
  let financesLabelUpdates = 0;
  const skipped = [];

  // Batched writes — collect, flush at end. Keeps Supabase round-trips down
  // and lets us treat the whole sync atomically per-table.
  const itemUpserts = []; // items table rows (snake_case)
  const txUpserts   = []; // transactions table rows (snake_case)

  for (const order of ordersData.orders || []) {
    const itemId = skuMap.get(order.sku)
      || existingByEbayId.get(order.ebayItemId)
      || orderIdMap.get(String(order.orderId));

    if (!itemId) {
      // No match — log and continue. v1 skips auto-create entirely (see file
      // header). Capture the same fields the desktop persists in
      // noltech:sync:skipped-orders so a future agent task can replay them.
      skipped.push({
        orderId:    order.orderId,
        date:       order.date || '',
        title:      order.title || '',
        sku:        order.sku || '',
        ebayItemId: order.ebayItemId || '',
        buyer:      order.buyer || '',
        gross:      Number(order.totalRevenue) || Number(order.orderTotal) || Number(order.salePrice) || 0,
        subtotal:   Number(order.subtotal) || 0,
        shipping:   Number(order.buyerShipping) || 0,
        fees:       Number(order.ebayFees) || 0,
        reason:     order.sku || order.ebayItemId
          ? 'No inventory item matched this order'
          : 'Order has neither SKU nor eBay item ID',
      });
      continue;
    }

    const existing = itemById.get(itemId);
    const bucket    = adFeesByOrderId[order.orderId];
    const realLabel = labelCostByOrderId[order.orderId];

    // ── eIS reconciliation ────────────────────────────────────────────────
    // For eBay International Shipping orders, Trading API returns the FULL
    // international shipping fee as buyerShipping/labelCost (typically
    // equal, both inflated). The seller is actually only reimbursed the
    // domestic-leg amount, which equals the Finances API SHIPPING_LABEL
    // transaction. Override so bookkeeping reflects what the seller
    // actually earned.
    let orderBuyerShipping = parseFloat(order.buyerShipping) || 0;
    let orderTotalRevenue  = parseFloat(order.totalRevenue)  || 0;
    let orderOrderTotal    = parseFloat(order.orderTotal)    || 0;
    if (order.isInternationalForwarding && realLabel != null && realLabel > 0) {
      const subt = parseFloat(order.subtotal) || 0;
      const tax  = parseFloat(order.salesTax) || 0;
      orderBuyerShipping = realLabel;
      orderTotalRevenue  = Math.round((subt + realLabel) * 100) / 100;
      orderOrderTotal    = Math.round((subt + realLabel + tax) * 100) / 100;
    }

    // Backfill brand / model / serial_number on the inventory item if
    // they're missing. Bulk-imported items often arrive without product
    // info; the order title is the first chance to populate it.
    const orderTitle = (order.title || '').trim();
    const itemFieldUpdates = {};
    if (orderTitle) {
      if (!existing?.brand) itemFieldUpdates.brand = parseBrand(orderTitle);
      if (!existing?.model) itemFieldUpdates.model = orderTitle;
    }
    if (order.sku && !existing?.serial_number) {
      itemFieldUpdates.serial_number = order.sku;
    }

    // ── Already-sold path: refresh sale data when anything actually changed ──
    if (existing?.status === 'sold') {
      const s = existing.sale || {};
      const { totalFees, breakdown } = applyAdFees(
        parseFloat(order.ebayFees) || parseFloat(s.platformFees) || 0,
        order.feeBreakdown || s.feeBreakdown,
        bucket,
      );
      const labelCost = realLabel != null
        ? realLabel
        : (parseFloat(s.labelCost) || parseFloat(order.labelCost) || parseFloat(s.shippingCost) || 0);
      const labelCostSource = realLabel != null
        ? 'finances'
        : (s.labelCostSource || 'estimate');
      const salePrice     = orderTotalRevenue || parseFloat(s.salePrice) || 0;
      const subtotal      = parseFloat(order.subtotal)     || parseFloat(s.subtotal)  || 0;
      const buyerShipping = orderBuyerShipping || parseFloat(s.buyerShipping) || 0;
      const salesTax      = parseFloat(order.salesTax)     || parseFloat(s.salesTax)  || 0;
      const orderTotal    = orderOrderTotal   || parseFloat(s.orderTotal) || 0;
      const taxBreakdown  = order.taxBreakdown && Object.keys(order.taxBreakdown).length
        ? order.taxBreakdown
        : (s.taxBreakdown || {});
      const vatAmount     = parseFloat(order.vatAmount) || parseFloat(s.vatAmount) || 0;
      const gstAmount     = parseFloat(order.gstAmount) || parseFloat(s.gstAmount) || 0;
      const costBasis = existing.cost_basis || 0;
      const netRevenue = salePrice - labelCost - totalFees;

      const changed =
           salePrice     !== (parseFloat(s.salePrice)     || 0)
        || subtotal      !== (parseFloat(s.subtotal)      || 0)
        || buyerShipping !== (parseFloat(s.buyerShipping) || 0)
        || salesTax      !== (parseFloat(s.salesTax)      || 0)
        || orderTotal    !== (parseFloat(s.orderTotal)    || 0)
        || labelCost     !== (parseFloat(s.labelCost)     || 0)
        || totalFees     !== (parseFloat(s.platformFees)  || 0)
        || vatAmount     !== (parseFloat(s.vatAmount)     || 0)
        || gstAmount     !== (parseFloat(s.gstAmount)     || 0)
        || (order.orderId || '') !== (s.id || '')
        || (order.date || '')    !== (s.soldAt || '')
        || (order.buyer || '')   !== (s.buyerName || '')
        || (!s.itemName && (order.title || '').trim().length > 0)
        || Object.keys(itemFieldUpdates).length > 0;
      if (!changed) continue;

      if (bucket && totalFees !== (parseFloat(s.platformFees) || 0)) financesAdFeeUpdates++;
      if (realLabel != null && labelCost !== (parseFloat(s.labelCost) || 0)) financesLabelUpdates++;

      const refreshedSale = {
        ...s,
        id: order.orderId || s.id,
        platform: s.platform || 'ebay',
        itemName: (order.title || '').trim() || s.itemName || null,
        soldAt: order.date || s.soldAt,
        buyerName: order.buyer || s.buyerName || '',
        salePrice,
        subtotal,
        buyerShipping,
        salesTax,
        taxBreakdown,
        vatAmount,
        gstAmount,
        orderTotal,
        labelCost,
        shippingCost: labelCost,
        labelCostKnown: realLabel != null ? true : !!s.labelCostKnown,
        labelCostSource,
        platformFees: totalFees,
        feeBreakdown: breakdown,
        netRevenue,
        profit: Math.round((netRevenue - costBasis) * 100) / 100,
      };

      itemUpserts.push({
        id: itemId,
        workspace_id: workspaceId,
        lot_id: existing.lot_id,
        brand: itemFieldUpdates.brand || existing.brand,
        model: itemFieldUpdates.model || existing.model,
        serial_number: itemFieldUpdates.serial_number || existing.serial_number,
        status: 'sold',
        sale: refreshedSale,
        ebay_item_id: existing.ebay_item_id,
        sku: existing.sku,
        updated_at: new Date().toISOString(),
      });

      // Rebuild bookkeeping rows for this updated sale. transactions has
      // UNIQUE(workspace_id, import_id) so re-upserting same import_id with
      // updated values just refreshes — same as the desktop's sale:updated
      // → strip-and-reinsert flow.
      const rowFamily = buildAutoRowsForSale({
        itemId,
        sale: refreshedSale,
        brand: refreshedSale.itemName ? '' : (itemFieldUpdates.brand || existing.brand || ''),
        model: refreshedSale.itemName || (itemFieldUpdates.model || existing.model || ''),
        sku:   itemFieldUpdates.serial_number || existing.serial_number || existing.sku || order.sku || '',
      });
      for (const r of rowFamily.rows) {
        txUpserts.push(transactionToRow(r, workspaceId));
      }

      soldCount++;
      continue;
    }

    // ── Newly-sold path: build sale from scratch ────────────────────────────
    const costBasis = existing?.cost_basis || 0;
    const labelCost = realLabel != null
      ? realLabel
      : (parseFloat(order.labelCost) || 0);
    const labelCostKnown  = realLabel != null || !!order.labelCostKnown;
    const labelCostSource = realLabel != null ? 'finances' : 'estimate';
    const buyerShipping   = orderBuyerShipping;
    const { totalFees, breakdown } = applyAdFees(order.ebayFees, order.feeBreakdown, bucket);
    const netRevenue = orderTotalRevenue - labelCost - totalFees;

    if (bucket)            financesAdFeeUpdates++;
    if (realLabel != null) financesLabelUpdates++;

    const newSale = {
      id: order.orderId,
      platform: 'ebay',
      itemName: (order.title || '').trim() || null,
      salePrice: orderTotalRevenue,
      subtotal: order.subtotal || 0,
      buyerShipping,
      salesTax: parseFloat(order.salesTax) || 0,
      taxBreakdown: order.taxBreakdown || {},
      vatAmount: parseFloat(order.vatAmount) || 0,
      gstAmount: parseFloat(order.gstAmount) || 0,
      orderTotal: orderOrderTotal,
      labelCost,
      labelCostKnown,
      labelCostSource,
      shippingCost: labelCost,
      platformFees: totalFees,
      feeBreakdown: breakdown,
      netRevenue,
      profit: Math.round((netRevenue - costBasis) * 100) / 100,
      soldAt: order.date,
      buyerName: order.buyer || '',
    };

    itemUpserts.push({
      id: itemId,
      workspace_id: workspaceId,
      lot_id: existing?.lot_id,
      brand: itemFieldUpdates.brand || existing?.brand,
      model: itemFieldUpdates.model || existing?.model,
      serial_number: itemFieldUpdates.serial_number || existing?.serial_number,
      status: 'sold',
      sale: newSale,
      ebay_item_id: existing?.ebay_item_id,
      sku: existing?.sku,
      updated_at: new Date().toISOString(),
    });

    const rowFamily = buildAutoRowsForSale({
      itemId,
      sale: newSale,
      brand: itemFieldUpdates.brand || existing?.brand || '',
      model: itemFieldUpdates.model || existing?.model || '',
      sku:   itemFieldUpdates.serial_number || existing?.serial_number || existing?.sku || order.sku || '',
    });
    for (const r of rowFamily.rows) {
      txUpserts.push(transactionToRow(r, workspaceId));
    }

    soldCount++;
  }

  // ── Step E: flush batches ────────────────────────────────────────────────
  if (itemUpserts.length) {
    // Dedup by `id` so we don't violate Postgres's "ON CONFLICT DO UPDATE
    // command cannot affect row a second time" rule. When multi-quantity
    // listings sell across multiple orders we may have built two rows for
    // the same item — keep the last one (most recent sale wins).
    const byId = new Map();
    for (const row of itemUpserts) {
      if (row?.id) byId.set(row.id, row);
    }
    const dedupedItemUpserts = Array.from(byId.values());

    const CHUNK = 500;
    for (let i = 0; i < dedupedItemUpserts.length; i += CHUNK) {
      const chunk = dedupedItemUpserts.slice(i, i + CHUNK);
      const { error: upErr } = await supabase
        .from('items')
        .upsert(chunk, { onConflict: 'id' });
      if (upErr) {
        throw new Error(`Supabase items UPSERT failed: ${upErr.message}`);
      }
    }
  }

  if (txUpserts.length) {
    // Dedup by import_id within this batch — same root cause as items: the
    // sync may produce two rows for the same logical transaction.
    const txByImportId = new Map();
    for (const row of txUpserts) {
      if (row?.import_id) txByImportId.set(row.import_id, row);
    }
    const dedupedTx = Array.from(txByImportId.values());

    // Supabase schema doesn't expose a unique constraint matching
    // (workspace_id, import_id) to PostgREST, so ON CONFLICT can't be used
    // here. Do delete-then-insert in small chunks (the .in() filter
    // serializes IDs into the URL — large chunks blow past PostgREST's
    // request-size limit and 400). 50 keeps URLs under ~3KB even for long
    // import_ids.
    const DELETE_CHUNK = 50;
    const INSERT_CHUNK = 500;
    const importIds = dedupedTx.map((r) => r.import_id).filter(Boolean);
    for (let i = 0; i < importIds.length; i += DELETE_CHUNK) {
      const chunk = importIds.slice(i, i + DELETE_CHUNK);
      const { error: delErr } = await supabase
        .from('transactions')
        .delete()
        .eq('workspace_id', workspaceId)
        .in('import_id', chunk);
      if (delErr) {
        throw new Error(`Supabase transactions DELETE failed: ${delErr.message}`);
      }
    }
    for (let i = 0; i < dedupedTx.length; i += INSERT_CHUNK) {
      const chunk = dedupedTx.slice(i, i + INSERT_CHUNK);
      const { error: insErr } = await supabase
        .from('transactions')
        .insert(chunk);
      if (insErr) {
        throw new Error(`Supabase transactions INSERT failed: ${insErr.message}`);
      }
    }
  }

  logger?.info({
    soldCount,
    skippedCount: skipped.length,
    financesAdFeeUpdates,
    financesLabelUpdates,
    txRowsWritten: txUpserts.length,
  }, '[orders] sync complete');

  return {
    soldCount,
    skippedCount: skipped.length,
    skipped,
    financesAdFeeUpdates,
    financesLabelUpdates,
  };
}

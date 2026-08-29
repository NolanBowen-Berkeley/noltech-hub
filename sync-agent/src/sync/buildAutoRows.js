// ─── Bookkeeping row builder ─────────────────────────────────────────────────
// Server-side port of useEventBridge.buildAutoRowsForSale (NolTech-Hub).
// Given a sale + the inventory item context, returns the canonical 3-or-4 row
// family (income + platform fees + ad fees + shipping label) that mirrors what
// the desktop bookkeeping ledger writes when sale:recorded fires.
//
// Each row is a transactions-table row in DESKTOP shape (camelCase), ready to
// be remapped to snake_case before upsert. Keeping the desktop shape lets us
// share this logic 1:1 and only convert at the supabase boundary.
//
// importIds are deterministic — `auto:{itemId}:{soldAt}` and friends — so
// re-runs deduplicate via the unique (workspace_id, import_id) constraint on
// the transactions table.

import { randomUUID } from 'node:crypto';
import { localDateStr } from '../lib/localDateStr.js';

export function buildAutoRowsForSale({ itemId, sale, brand, model, sku }, existingIdByImportId = {}) {
  const idFor = (importId) => existingIdByImportId[importId] || randomUUID();
  const itemName = `${brand || ''} ${model || ''}`.trim() || 'Item Sale';
  // Convert UTC soldAt to local-time YYYY-MM-DD so the bookkeeping date
  // matches what eBay's seller UI displays.
  const txDate = localDateStr(sale.soldAt) || localDateStr(new Date());
  const platform = sale.platform || 'ebay';
  const skuVal = (sku || sale.sku || '').toString().trim() || null;
  const gross = parseFloat(sale.salePrice) || 0;
  const buyerShipping = parseFloat(sale.buyerShipping) || 0;
  const fees  = parseFloat(sale.platformFees) || 0;
  const labelCost = parseFloat(sale.labelCost) || 0;
  const labelCostKnown = !!sale.labelCostKnown || labelCost > 0;
  const labelCostFromFinances = sale.labelCostSource === 'finances';
  const labelLooksEstimated   = labelCostKnown && !labelCostFromFinances
    && Math.abs(labelCost - buyerShipping) < 0.01 && buyerShipping > 0;

  // Split ad-fee buckets out of the platform fee row so they show as their
  // own bookkeeping line (matches eBay's "Ad Fee General" presentation).
  const rawBreakdown = (sale.feeBreakdown && typeof sale.feeBreakdown === 'object')
    ? sale.feeBreakdown : {};
  const isAdFeeKey = (k) => /^(ad[_ ]?fee|promot|promoted)/i.test(k);
  const adFeeBreakdown = {};
  const platformFeeBreakdown = {};
  for (const [k, v] of Object.entries(rawBreakdown)) {
    const amt = Number(v) || 0;
    if (amt <= 0) continue;
    if (isAdFeeKey(k)) adFeeBreakdown[k] = amt;
    else               platformFeeBreakdown[k] = amt;
  }
  const adFeeAmount    = Math.round(Object.values(adFeeBreakdown).reduce((s, v) => s + v, 0) * 100) / 100;
  const platformFeesNet = Math.max(0, Math.round((fees - adFeeAmount) * 100) / 100);
  const netEarnings = Math.round((gross - fees - labelCost) * 100) / 100;
  const orderTotal = parseFloat(sale.orderTotal) || 0;
  const salesTax   = parseFloat(sale.salesTax)   || 0;
  const subtotal   = parseFloat(sale.subtotal)   || 0;
  const vatAmount  = parseFloat(sale.vatAmount)  || 0;
  const gstAmount  = parseFloat(sale.gstAmount)  || 0;
  const taxBreakdown = (sale.taxBreakdown && typeof sale.taxBreakdown === 'object') ? sale.taxBreakdown : {};
  const taxBreakdownEntries = Object.entries(taxBreakdown).filter(([, v]) => Number(v) > 0);
  const taxLabel = taxBreakdownEntries.length > 1
    ? taxBreakdownEntries.map(([k, v]) => `${k} $${Number(v).toFixed(2)}`).join(' + ')
    : (vatAmount > 0
        ? `VAT $${vatAmount.toFixed(2)}`
        : gstAmount > 0
          ? `GST $${gstAmount.toFixed(2)}`
          : `tax $${salesTax.toFixed(2)}`);

  const incomeCategory =
    platform === 'ebay'    ? 'eBay Sales' :
    platform === 'mercari' ? 'Mercari Sales' :
    platform === 'facebook'? 'Facebook Marketplace' :
                             'Other Income';
  const feeCategory =
    platform === 'ebay'    ? 'eBay Fees' :
    platform === 'mercari' ? 'Mercari Fees' :
                             'Platform Fees';
  const adFeeCategory =
    platform === 'ebay'    ? 'eBay Ad Fees' :
                             'Advertising';

  const importIds = {
    income:   `auto:${itemId}:${sale.soldAt || ''}`,
    fees:     `auto_fees:${itemId}:${sale.soldAt || ''}`,
    adfee:    `auto_adfee:${itemId}:${sale.soldAt || ''}`,
    shipping: `auto_ship:${itemId}:${sale.soldAt || ''}`,
  };

  const shipNote = buyerShipping > 0
    ? `includes $${buyerShipping.toFixed(2)} buyer-paid shipping`
    : 'no buyer-paid shipping';
  const labelNoteShort = labelCostKnown
    ? `label $${labelCost.toFixed(2)}`
    : 'label cost TBD (enter from Shipping Queue)';
  const orderTotalNote = orderTotal > 0
    ? `Order total $${orderTotal.toFixed(2)} (subtotal $${subtotal.toFixed(2)} + ship $${buyerShipping.toFixed(2)} + ${taxLabel} eBay-remitted). `
    : '';

  const rows = [{
    id: idFor(importIds.income),
    source: 'auto_sale',
    importId: importIds.income,
    date: txDate,
    type: 'income',
    category: incomeCategory,
    description: itemName,
    sku: skuVal,
    orderId: sale.id || null,
    amount: gross,
    notes: `Auto-recorded.${sale.id ? ` Order ${sale.id}.` : ''} ${orderTotalNote}Seller revenue $${gross.toFixed(2)} (${shipNote}) · fees $${fees.toFixed(2)} · ${labelNoteShort} · net earnings $${netEarnings.toFixed(2)}.`,
  }];

  // Platform-fee row (everything EXCEPT ad fees).
  const platformFeeAmountForRow = Object.keys(platformFeeBreakdown).length
    ? platformFeesNet
    : Math.max(0, Math.round((fees - adFeeAmount) * 100) / 100);
  if (platformFeeAmountForRow > 0) {
    const fmtBreakdown = (obj) => Object.entries(obj)
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} $${Number(v).toFixed(2)}`)
      .join(' · ');
    const breakdown = fmtBreakdown(platformFeeBreakdown);
    rows.push({
      id: idFor(importIds.fees),
      source: 'auto_fees',
      importId: importIds.fees,
      date: txDate,
      type: 'expense',
      category: feeCategory,
      description: `${platform === 'ebay' ? 'eBay' : platform} fees — ${itemName}`,
      sku: skuVal,
      orderId: sale.id || null,
      amount: platformFeeAmountForRow,
      notes: (sale.id ? `Order ${sale.id}. ` : '') + (breakdown
        ? `Breakdown: ${breakdown}.${adFeeAmount > 0 ? ` Ad fees ($${adFeeAmount.toFixed(2)}) recorded separately.` : ''}`
        : (adFeeAmount > 0
            ? `Auto-recorded platform fee. Ad fees ($${adFeeAmount.toFixed(2)}) recorded separately.`
            : 'Auto-recorded platform fee for order.')),
    });
  }

  // Ad-fee row — separate so it's visible as advertising expense.
  if (adFeeAmount > 0) {
    const fmtAd = Object.entries(adFeeBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} $${Number(v).toFixed(2)}`)
      .join(' · ');
    rows.push({
      id: idFor(importIds.adfee),
      source: 'auto_adfee',
      importId: importIds.adfee,
      date: txDate,
      type: 'expense',
      category: adFeeCategory,
      description: `${platform === 'ebay' ? 'eBay' : platform} ad fee — ${itemName}`,
      sku: skuVal,
      orderId: sale.id || null,
      amount: adFeeAmount,
      notes: (sale.id ? `Order ${sale.id}. ` : '') + (fmtAd
        ? `Promoted Listings / Ad Fee breakdown: ${fmtAd}.`
        : 'Auto-recorded eBay advertising fee from Finances API.'),
    });
  }

  if (labelCostKnown && labelCost > 0) {
    const labelNote = labelLooksEstimated
      ? `Estimated label cost — matches buyer-paid shipping ($${buyerShipping.toFixed(2)}). Real seller cost arrives via the Finances API on next sync. Verify in Shipping Queue if it doesn't update.`
      : labelCostFromFinances
        ? `Seller label cost (from eBay Finances API).${buyerShipping > 0 ? ` Buyer paid $${buyerShipping.toFixed(2)} for shipping.` : ''}`
        : (buyerShipping > 0
            ? `Seller label cost. Buyer paid $${buyerShipping.toFixed(2)} for shipping.`
            : 'Auto-recorded shipping label expense.');
    rows.push({
      id: idFor(importIds.shipping),
      source: 'auto_shipping',
      importId: importIds.shipping,
      date: txDate,
      type: 'expense',
      category: 'Shipping',
      description: `Shipping label — ${itemName}`,
      sku: skuVal,
      orderId: sale.id || null,
      amount: labelCost,
      notes: (sale.id ? `Order ${sale.id}. ` : '') + labelNote,
    });
  }

  return { rows, importIds };
}

// Convert a desktop-shape transaction row to the snake_case shape the
// Supabase `transactions` table expects. Mirrors syncEngine.js toRow().
export function transactionToRow(t, workspaceId) {
  return {
    id: t.id,
    workspace_id: workspaceId,
    date: t.date || null,
    type: t.type || null,
    category: t.category || null,
    description: t.description || null,
    amount: t.amount != null ? parseFloat(t.amount) : null,
    notes: t.notes || null,
    source: t.source || null,
    import_id: t.importId || null,
    order_id: t.orderId || null,
    sku: t.sku || null,
  };
}

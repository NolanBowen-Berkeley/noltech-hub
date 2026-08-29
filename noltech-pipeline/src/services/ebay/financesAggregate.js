// ─── Aggregate raw Finances transactions into per-order buckets ──────────────
// Mirrors useSyncAll.js:468-523 logic. Pure function — no I/O.
//
// Output:
//   labelCostByOrderId    — sum of SHIPPING_LABEL amounts per order
//   adFeesByOrderId       — { orderId → { feeTypeName → amount } } for NON_SALE_CHARGE
//   refundEvents          — list of refund/credit/dispute txns the persistor turns
//                           into bookkeeping Returns & Refunds rows

const FEE_KEY_FROM_RAW = (raw) => raw === 'AD_FEE'
  ? 'AdFeeGeneral'
  : String(raw || 'AdFeeGeneral')
      .split(/[_\s]+/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join('');

export function aggregateFinances(transactions) {
  const labelCostByOrderId = {};
  const adFeesByOrderId    = {};
  const refundEvents       = [];
  const stats = { labels: 0, adFees: 0, refunds: 0 };

  for (const tx of transactions) {
    if (!tx?.id || !tx?.type) continue;
    const amt = Math.abs(parseFloat(tx.amount) || 0);
    if (amt <= 0) continue;
    const orderId = tx.orderId;

    if (tx.type === 'SHIPPING_LABEL') {
      if (!orderId) continue;
      labelCostByOrderId[orderId] = Math.round(
        ((labelCostByOrderId[orderId] || 0) + amt) * 100,
      ) / 100;
      stats.labels++;
    } else if (tx.type === 'REFUND' || tx.type === 'CREDIT' || tx.type === 'DISPUTE') {
      // Refunds without an orderId can't be deduped against the Hub's
      // importId scheme (`auto_refund:${orderId}`) — skipping them matches
      // useSyncAll.js:469 and prevents duplicate Returns & Refunds rows on
      // cross-device sync. The raw event still lands in finances_events
      // for diagnostics; only the bookkeeping-row write is suppressed.
      if (!orderId) continue;
      refundEvents.push({
        ebayTxnId: tx.id,
        orderId,
        amount: amt,
        date: tx.date,
        type: tx.type,
        reason: tx.memo || tx.feeType || tx.type,
      });
      stats.refunds++;
    } else {
      // Default: ad fees / promoted listings / regulatory
      if (!orderId) continue;
      const bucket = adFeesByOrderId[orderId] ||= {};
      const key = FEE_KEY_FROM_RAW(tx.feeType || tx.type);
      bucket[key] = Math.round(((bucket[key] || 0) + amt) * 100) / 100;
      stats.adFees++;
    }
  }

  return { labelCostByOrderId, adFeesByOrderId, refundEvents, stats };
}

// Merge a Finances ad-fee bucket into an existing fee breakdown. Finances
// values are authoritative — REPLACE, don't ADD (preventing double-counting
// when the Trading API already returned a partial breakdown).
// Returns { totalFees, breakdown } so the caller can write a fresh sale row.
export function applyAdFees(baseFees, baseBreakdown, bucket) {
  if (!bucket) return { totalFees: baseFees, breakdown: baseBreakdown };
  const breakdown = { ...(baseBreakdown || {}) };
  let netDelta = 0;
  for (const [k, v] of Object.entries(bucket)) {
    const prev = Number(breakdown[k]) || 0;
    const next = Math.round(Number(v || 0) * 100) / 100;
    breakdown[k] = next;
    netDelta += next - prev;
  }
  return {
    totalFees: Math.round(((baseFees || 0) + netDelta) * 100) / 100,
    breakdown,
  };
}

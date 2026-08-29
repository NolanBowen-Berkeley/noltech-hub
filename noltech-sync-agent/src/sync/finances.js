// ─── eBay Finances API fetcher ───────────────────────────────────────────────
// GetOrders returns ESTIMATED labelCost (from ActualShippingCost), but the
// real amount eBay billed for the label lives in a separate SHIPPING_LABEL
// transaction. Same story for Ad Fee General (NON_SALE_CHARGE). This module
// pulls both transaction types from the Finances API (last 95 days) and
// returns lookup tables keyed by orderId — exactly the shape orders.js
// merges into each sale.
//
// Mirrors useSyncAll lines ~294-400. Returns empty maps + a soft-error log
// on any failure; callers fall back to GetOrders estimates.

const FINANCES_TIMEOUT_MS = 45000;

export async function fetchFinancesByOrder({ pipelineUrl, accessToken, logger }) {
  const empty = { adFeesByOrderId: {}, labelCostByOrderId: {}, adFeeStats: { orders: 0, total: 0 }, labelStats: { orders: 0, total: 0 }, authError: false };
  if (!accessToken) {
    logger?.warn('[finances] no access token — skipping Finances API pull');
    return empty;
  }

  const fromDate = new Date(Date.now() - 95 * 86400000).toISOString();
  const toDate   = new Date().toISOString();

  let finData;
  try {
    const finRes = await fetch(`${pipelineUrl}/api/ebay/finances/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oauthUserToken: accessToken,
        from: fromDate,
        to: toDate,
        types: ['NON_SALE_CHARGE', 'SHIPPING_LABEL'],
      }),
      signal: AbortSignal.timeout(FINANCES_TIMEOUT_MS),
    });
    finData = await finRes.json();
  } catch (err) {
    logger?.error({ err: err.message }, '[finances] network/parse failure');
    return empty;
  }

  if (!finData.success) {
    const msg = finData.error || 'Finances API call failed';
    const looksLikeAuth = /auth|oauth|401|403|token|scope|expired|unauthorized/i.test(msg);
    if (looksLikeAuth) {
      logger?.error({ msg }, '[finances] OAuth-style failure — caller should invalidate cache');
    } else {
      logger?.error({ msg }, '[finances] API failure');
    }
    return { ...empty, authError: looksLikeAuth };
  }

  const adFeesByOrderId = {};
  const labelCostByOrderId = {};
  const adFeeStats = { orders: 0, total: 0 };
  const labelStats = { orders: 0, total: 0 };

  for (const tx of finData.transactions || []) {
    if (!tx.orderId) continue;
    const amt = Math.abs(parseFloat(tx.amount) || 0);
    if (amt <= 0) continue;

    if (tx.type === 'SHIPPING_LABEL') {
      // eBay can issue multiple labels per order (returns, splits). Sum them.
      labelCostByOrderId[tx.orderId] = Math.round(
        ((labelCostByOrderId[tx.orderId] || 0) + amt) * 100,
      ) / 100;
      labelStats.total += amt;
    } else {
      // Default: ad fees / promoted listings / regulatory
      const bucket = adFeesByOrderId[tx.orderId] ||= {};
      const raw = (tx.feeType || tx.type || 'AdFeeGeneral').toString();
      const key = raw === 'AD_FEE'
        ? 'AdFeeGeneral'
        : raw.split(/[_\s]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
      bucket[key] = Math.round(((bucket[key] || 0) + amt) * 100) / 100;
      adFeeStats.total += amt;
    }
  }
  adFeeStats.orders = Object.keys(adFeesByOrderId).length;
  labelStats.orders = Object.keys(labelCostByOrderId).length;

  logger?.info({
    adFeeOrders: adFeeStats.orders,
    adFeeTotal: Math.round(adFeeStats.total * 100) / 100,
    labelOrders: labelStats.orders,
    labelTotal: Math.round(labelStats.total * 100) / 100,
  }, '[finances] Finances API pull complete');

  return { adFeesByOrderId, labelCostByOrderId, adFeeStats, labelStats, authError: false };
}

// ─── eBay Finances API — ad fees + shipping labels + refunds + credits ──────
// Port of scraper/server.js:/api/ebay/finances/transactions for the Worker.
// Uses an OAuth bearer token (NOT the legacy Trading API user token).

const FINANCES_BASE = 'https://apiz.ebay.com/sell/finances/v1/transaction';
const DEFAULT_TYPES = ['NON_SALE_CHARGE', 'SHIPPING_LABEL', 'REFUND', 'CREDIT', 'DISPUTE'];

export async function fetchFinancesTransactions({
  accessToken,
  lookbackDays = 95,
  maxPages = 10,
  types = DEFAULT_TYPES,
}) {
  if (!accessToken) throw new Error('Finances API requires accessToken');

  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 86400000);
  const filter = [
    `transactionDate:[${from.toISOString()}..${to.toISOString()}]`,
    `transactionType:{${types.join('|')}}`,
  ].join(',');

  let url = `${FINANCES_BASE}?filter=${encodeURIComponent(filter)}&limit=200`;
  const transactions = [];
  let pages = 0;
  let calls = 0;

  while (url && pages < maxPages) {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
    calls++;
    const text = await r.text();
    if (r.status === 401 || r.status === 403) {
      throw new Error(`Finances API auth ${r.status}: ${text.slice(0, 200)} — refresh token expired?`);
    }
    if (!r.ok) {
      throw new Error(`Finances API ${r.status}: ${text.slice(0, 200)}`);
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`Finances body not JSON: ${text.slice(0, 200)}`); }

    for (const t of (body.transactions || [])) {
      const orderId = t.orderId
        || (Array.isArray(t.references)
              ? (t.references.find((r) => r.referenceType === 'ORDER_ID')?.referenceId || null)
              : null);
      const orderLineItemId = Array.isArray(t.references)
        ? (t.references.find((r) => r.referenceType === 'ORDER_LINE_ITEM_ID')?.referenceId || null)
        : null;
      transactions.push({
        id:                 t.transactionId,
        type:               t.transactionType,
        memo:               t.transactionMemo || t.feeType || '',
        feeType:            t.feeType || null,
        amount:             parseFloat(t.amount?.value) || 0,
        currency:           t.amount?.currency || 'USD',
        date:               t.transactionDate,
        orderId,
        orderLineItemId,
        references:         t.references || [],
      });
    }

    url = body.next || null;
    pages++;
  }

  return { transactions, calls, pagesFetched: pages };
}

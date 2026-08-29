// ─── eBay Trading API — GetMyeBaySelling (listings) + GetOrders (orders) ─────
// Port of scraper/server.js eBay Trading API handlers using Worker-native
// fetch() + fast-xml-parser instead of axios + cheerio.

import { XMLParser } from 'fast-xml-parser';

const API_URL = 'https://api.ebay.com/ws/api.dll';
const COMPATIBILITY_LEVEL = '1349';
const SITE_ID = '0'; // US

// Defense-in-depth XML escape. EBAY_USER_TOKEN currently comes from a
// trusted env var, but stray `<`, `&`, etc. would break the body parse
// and produce confusing eBay error responses. One helper, two call sites.
function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
});

// When an OAuth access token is supplied, send it via X-EBAY-API-IAF-TOKEN.
// eBay accepts the same Trading API XML body with NO RequesterCredentials
// element when IAF is present — the bearer token IS the auth, eliminating
// the legacy ~18-month User Token rotation. EBAY_DEV_ID stays optional.
function buildHeaders(callName, env, { accessToken } = {}) {
  const h = {
    'Content-Type': 'text/xml; charset=utf-8',
    'X-EBAY-API-CALL-NAME':            callName,
    'X-EBAY-API-COMPATIBILITY-LEVEL':  COMPATIBILITY_LEVEL,
    'X-EBAY-API-SITEID':               SITE_ID,
    'X-EBAY-API-APP-NAME':             env.EBAY_APP_ID || '',
    'X-EBAY-API-DEV-NAME':             env.EBAY_DEV_ID || '',
    'X-EBAY-API-CERT-NAME':            env.EBAY_CERT_ID || '',
  };
  if (accessToken) h['X-EBAY-API-IAF-TOKEN'] = accessToken;
  return h;
}

// Coerce a value that may be {ParameterValue / nested struct} into a single value.
const v = (x) => (x == null ? null : (typeof x === 'object' ? x['#text'] ?? x : x));
const num = (x) => {
  const n = Number(v(x));
  return Number.isFinite(n) ? n : 0;
};
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

// ── GetMyeBaySelling — paginated active listings ──
// Authenticates via OAuth IAF Bearer token. Falls back to legacy
// EBAY_USER_TOKEN in the XML body if no accessToken is supplied (kept for
// rollback safety — the OAuth path is the default).
export async function fetchActiveListings(env, { accessToken } = {}) {
  const userToken = env.EBAY_USER_TOKEN;
  if (!accessToken && !userToken) {
    throw new Error('No OAuth accessToken AND no EBAY_USER_TOKEN — cannot authenticate Trading API');
  }

  let calls = 0;
  let pageNumber = 1;
  const out = [];
  const PER_PAGE = 200; // eBay max

  while (pageNumber <= 25) { // hard cap — 5000 listings before forced stop
    const credentialsBlock = accessToken
      ? '' // IAF header carries the auth; RequesterCredentials is omitted
      : `<RequesterCredentials><eBayAuthToken>${escapeXml(userToken)}</eBayAuthToken></RequesterCredentials>`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentialsBlock}
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>${PER_PAGE}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const r = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders('GetMyeBaySelling', env, { accessToken }),
      body: xml,
    });
    calls++;
    const text = await r.text();
    if (!r.ok) throw new Error(`GetMyeBaySelling HTTP ${r.status}: ${text.slice(0, 200)}`);
    const parsed = xmlParser.parse(text);
    const root = parsed?.GetMyeBaySellingResponse;
    if (!root) throw new Error('GetMyeBaySelling: no response root');
    const ack = root.Ack;
    if (ack !== 'Success' && ack !== 'Warning') {
      const msg = root.Errors?.LongMessage || root.Errors?.ShortMessage || 'GetMyeBaySelling failed';
      throw new Error(`GetMyeBaySelling ${ack}: ${msg}`);
    }

    const items = arr(root.ActiveList?.ItemArray?.Item);
    for (const it of items) {
      out.push({
        itemId:        String(v(it.ItemID) || ''),
        sku:           v(it.SKU) || '',
        title:         v(it.Title) || '',
        quantity:      num(it.Quantity),
        quantitySold:  num(it.SellingStatus?.QuantitySold),
        currentPrice:  num(it.SellingStatus?.CurrentPrice),
        startTime:     v(it.ListingDetails?.StartTime) || null,
        endTime:       v(it.ListingDetails?.EndTime) || null,
        watchCount:    num(it.WatchCount),
        hitCount:      num(it.HitCount),
        condition:     v(it.ConditionDisplayName) || '',
        conditionId:   v(it.ConditionID) || '',
        category:      v(it.PrimaryCategory?.CategoryName) || '',
      });
    }

    const totalPages = num(root.ActiveList?.PaginationResult?.TotalNumberOfPages);
    if (pageNumber >= totalPages) break;
    pageNumber++;
  }

  return { listings: out, calls, pagesFetched: pageNumber };
}

// ── GetOrders — paginated completed orders ──
// Same auth pattern as fetchActiveListings — prefers OAuth IAF, falls back
// to legacy user token if accessToken is missing.
export async function fetchOrders(env, { accessToken, lookbackDays = 89, maxPages = 10 } = {}) {
  const userToken = env.EBAY_USER_TOKEN;
  if (!accessToken && !userToken) {
    throw new Error('No OAuth accessToken AND no EBAY_USER_TOKEN — cannot authenticate Trading API');
  }

  const to = new Date();
  const from = new Date(to.getTime() - lookbackDays * 86400000);
  let calls = 0;
  let pageNumber = 1;
  const orders = [];
  const PER_PAGE = 100;

  while (pageNumber <= maxPages) {
    const credentialsBlock = accessToken
      ? ''
      : `<RequesterCredentials><eBayAuthToken>${escapeXml(userToken)}</eBayAuthToken></RequesterCredentials>`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentialsBlock}
  <OrderStatus>Completed</OrderStatus>
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${to.toISOString()}</CreateTimeTo>
  <Pagination><EntriesPerPage>${PER_PAGE}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination>
  <DetailLevel>ReturnAll</DetailLevel>
</GetOrdersRequest>`;

    const r = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders('GetOrders', env, { accessToken }),
      body: xml,
    });
    calls++;
    const text = await r.text();
    if (!r.ok) throw new Error(`GetOrders HTTP ${r.status}: ${text.slice(0, 200)}`);
    const parsed = xmlParser.parse(text);
    const root = parsed?.GetOrdersResponse;
    if (!root) throw new Error('GetOrders: no response root');
    const ack = root.Ack;
    if (ack !== 'Success' && ack !== 'Warning') {
      const msg = root.Errors?.LongMessage || root.Errors?.ShortMessage || 'GetOrders failed';
      throw new Error(`GetOrders ${ack}: ${msg}`);
    }

    for (const orderXml of arr(root.OrderArray?.Order)) {
      // eBay flattens MULTI-line orders as one Order with multiple Transaction
      // children. Emit one record per Transaction so each line item gets its
      // own matching pass (mirrors scraper/server.js behavior).
      const orderId       = String(v(orderXml.OrderID) || '');
      const createdTime   = v(orderXml.CreatedTime);
      const buyer         = v(orderXml.BuyerUserID) || '';
      const orderTotal    = num(orderXml.Total);
      const buyerShipping = num(orderXml.ShippingServiceSelected?.ShippingServiceCost);
      const salesTax      = num(orderXml.ShippingDetails?.SalesTax?.SalesTaxAmount);
      const subtotal      = num(orderXml.Subtotal);
      const shipToName    = v(orderXml.ShippingAddress?.Name) || '';
      const shipToStreet2 = v(orderXml.ShippingAddress?.Street2) || '';
      const isInternationalForwarding =
        /eIS/i.test(shipToName) || /^evtn:/i.test(shipToStreet2);

      for (const tx of arr(orderXml.TransactionArray?.Transaction)) {
        const ebayItemId = String(v(tx.Item?.ItemID) || '');
        const sku        = v(tx.Item?.SKU) || v(tx.Variation?.SKU) || '';
        const title      = v(tx.Item?.Title) || '';
        const qty        = num(tx.QuantityPurchased) || 1;
        const price      = num(tx.TransactionPrice);
        // ActualShippingCost may be missing — fall back to order-level value.
        const labelCost  = num(tx.ActualShippingCost) || buyerShipping;
        const labelCostKnown = !!v(tx.ActualShippingCost);
        const feeBreakdown = {};
        let ebayFees = 0;
        for (const f of arr(tx.FinalValueFeeArray?.FinalValueFee)
          .concat(arr(tx.ExtendedOrderID))) {
          // Trading API rarely returns the breakdown — Finances API is the
          // authoritative source. Leave blank and let the Worker's aggregate
          // step layer Finances data on top.
        }
        ebayFees = num(tx.FinalValueFee);
        orders.push({
          orderId, transactionId: String(v(tx.TransactionID) || ''),
          ebayItemId, sku, title,
          qty, price, buyerShipping, labelCost, labelCostKnown,
          subtotal, salesTax, orderTotal,
          totalRevenue: price * qty + buyerShipping,
          ebayFees, feeBreakdown,
          date: createdTime,
          buyer, shipTo: { name: shipToName, street2: shipToStreet2 },
          isInternationalForwarding,
        });
      }
    }

    const totalPages = num(root.PaginationResult?.TotalNumberOfPages);
    if (pageNumber >= totalPages) break;
    pageNumber++;
  }

  return { orders, calls, pagesFetched: pageNumber };
}

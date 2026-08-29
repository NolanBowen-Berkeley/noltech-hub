// ─── eBay Browse API comps provider ──────────────────────────────────────────
// A real, usable pricing source built on eBay's official Browse API, reached
// with your own developer credentials over the documented endpoint. No HTML
// parsing, no proxy, nothing that circumvents an access control.
//
// ── The caveat that matters ──────────────────────────────────────────────────
// Browse API returns ACTIVE listings — what sellers are ASKING. It is not sold
// data. Asking prices skew high: unsold inventory is, by definition, the
// inventory nobody paid that price for. Treat the numbers as an upper bound.
//
// eBay's sold/completed data is served by the Marketplace Insights API, which
// is limited-release — you apply for access per application. If you are
// granted it, the cleanest path is a custom provider wrapping that API:
// it returns genuine sold prices in the same shape this file produces. See
// docs/DATA-SOURCES.md.
//
// ── Setup ────────────────────────────────────────────────────────────────────
//   1. Create an app keyset at https://developer.ebay.com/my/keys
//   2. Put the App ID (Client ID) and Cert ID (Client Secret) in .env as
//      EBAY_APP_ID / EBAY_CERT_ID
//   3. Set COMPS_PROVIDER=ebay-browse
//
// Rate limits: the default application token allows a few thousand Browse
// calls per day. The pipeline's own caching (sold_comps table, 14d TTL) is
// what keeps a manifest run inside that budget.

import { recordEbayCall } from '../services/pricing/callStats.js';
import { stripSellerJunk } from '../services/pricing/textUtils.js';

const OAUTH_URL  = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const MARKETPLACE = 'EBAY_US';

// Titles that are navigation chrome or promotional rows rather than listings.
const JUNK_RE = /(opens in a new window|see (more|details)|sponsored|certified pre-?owned|amazon renewed)/i;

// Browse API condition IDs. Mirrors the working/for-parts split the rest of
// the pipeline uses. https://developer.ebay.com/devzone/finding/callref/enums/conditionIdList.html
const COND_WORKING   = ['1000', '1500', '2000', '2500', '3000'];
const COND_FOR_PARTS = ['7000'];

// ─── OAuth ───────────────────────────────────────────────────────────────────
// Application-token flow (client credentials). Cached in module scope and
// refreshed a minute before expiry; `inFlight` collapses the thundering herd
// when a manifest run fires many lookups at once.

let tokenCache = { token: null, expiresAt: 0 };
let inFlight = null;

async function getAppToken(appId, certId) {
  if (tokenCache.token && tokenCache.expiresAt - Date.now() > 60_000) return tokenCache.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const creds = Buffer.from(`${appId}:${certId}`).toString('base64');
      const res = await fetch(OAUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': `Basic ${creds}`,
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`eBay OAuth ${res.status}: ${t.slice(0, 120)}`);
      }
      const data = await res.json();
      tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
      };
      return data.access_token;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const compsProvider = {
  id:          'ebay-browse',
  label:       'eBay Browse API (active listings — asking prices, not sold)',
  sourceLabel: 'ebay-browse-api',

  async lookup(env, { query, condition = 'any', maxResults = 60, log } = {}) {
    const appId  = env.EBAY_APP_ID;
    const certId = env.EBAY_CERT_ID;
    if (!appId || !certId) {
      return { ok: false, error: 'ebay_credentials_missing', items: [], total: 0 };
    }
    const q = String(query || '').trim();
    if (!q) return { ok: true, items: [], total: 0 };

    const limit = Math.max(1, Math.min(200, Number(maxResults) || 60));
    const filters = ['priceCurrency:USD'];
    if (condition === 'working')        filters.push(`conditionIds:{${COND_WORKING.join('|')}}`);
    else if (condition === 'for_parts') filters.push(`conditionIds:{${COND_FOR_PARTS.join('|')}}`);

    const params = new URLSearchParams({
      q:      q.slice(0, 100),
      filter: filters.join(','),
      sort:   'price',
      limit:  String(Math.min(200, limit)),
    });

    let token;
    try {
      token = await getAppToken(appId, certId);
    } catch (e) {
      log?.warn?.('ebay_oauth_failed', { message: e?.message });
      return { ok: false, error: e?.message || 'ebay_oauth_failed', items: [], total: 0 };
    }

    // Counted before the await — a call that times out still consumed quota.
    recordEbayCall(env).catch(() => {});

    let res;
    try {
      res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        headers: {
          'Authorization':            `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID':  MARKETPLACE,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return { ok: false, error: e?.message || 'ebay_browse_failed', items: [], total: 0 };
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = body?.errors?.[0]?.longMessage || body?.errors?.[0]?.message || `HTTP ${res.status}`;
      log?.warn?.('ebay_browse_error', { status: res.status, message: msg.slice(0, 160) });
      return { ok: false, error: msg, items: [], total: 0 };
    }

    const data = await res.json().catch(() => ({}));
    const nowIso = new Date().toISOString();

    const items = (data.itemSummaries || [])
      .map((s) => {
        const price = Number(s.price?.value);
        if (!Number.isFinite(price) || price <= 0) return null;
        const title = stripSellerJunk(s.title || '');
        if (!title || JUNK_RE.test(title)) return null;
        const shippingCost = Number(s.shippingOptions?.[0]?.shippingCost?.value);
        const ship = Number.isFinite(shippingCost) ? shippingCost : null;
        return {
          itemId:         s.itemId || null,
          title,
          conditionLabel: s.condition || null,
          price:          round2(price),
          currency:       s.price?.currency || 'USD',
          shippingCost:   ship,
          totalPrice:     round2(price + (ship || 0)),
          // Browse API listings are ACTIVE — there is no sale date. Null here
          // is honest; a fabricated timestamp would let recency weighting
          // downstream treat an asking price as a fresh sale.
          soldAt:         null,
          observedAt:     nowIso,
          imageUrl:       s.image?.imageUrl || null,
          itemUrl:        s.itemWebUrl || null,
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    log?.info?.('ebay_browse_done', { query: q.slice(0, 60), count: items.length });
    return { ok: true, items, total: items.length, activeListings: true };
  },
};

function round2(n) { return Math.round(n * 100) / 100; }

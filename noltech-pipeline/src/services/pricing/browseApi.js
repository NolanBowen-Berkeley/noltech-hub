// ─── eBay Browse API fallback ────────────────────────────────────────────────
// Port of priceOneItem() / searchEbaySold() / getOAuthToken() from
// scraper/server.js. Used as a second-chance pricer when the sold-comps
// Lambda returns no results — Browse API queries eBay's live active-listing
// catalog for asking prices.
//
// Returns same shape as priceItemViaSoldComps so the enrich pipeline can
// drop in either result.

import { getUpcCacheEntry, putUpcCacheEntry } from './upcCache.js';
import { recordEbayCall } from './callStats.js';
import { cleanKeyword, stripSellerJunk, simpleHash } from './textUtils.js';

const JUNK_RE = /(opens in a new window|see (more|details)|sponsored|certified pre-?owned|amazon renewed)/i;

// Module-scope OAuth cache — per-isolate, but Workers reuse isolates across
// requests so this saves OAuth round-trips most of the time.
let oauthCache = { token: null, expiresAt: 0 };
let oauthInFlight = null;

async function getOAuthToken(appId, certId) {
  if (oauthCache.token && oauthCache.expiresAt - Date.now() > 60000) return oauthCache.token;
  if (oauthInFlight) return oauthInFlight;
  oauthInFlight = (async () => {
    try {
      const creds = btoa(`${appId}:${certId}`);
      const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${creds}`,
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`eBay OAuth ${res.status}: ${t.slice(0, 80)}`);
      }
      const data = await res.json();
      oauthCache = {
        token: data.access_token,
        expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000,
      };
      return data.access_token;
    } finally {
      oauthInFlight = null;
    }
  })();
  return oauthInFlight;
}

// Strip junk titles, pick the median-length surviving title as bestTitle.
function pickBestTitle(items) {
  const clean = items
    .map((i) => stripSellerJunk(i.title))
    .filter((t) => t && t.length > 8 && !JUNK_RE.test(t))
    .sort((a, b) => a.length - b.length);
  if (!clean.length) return '';
  return clean[Math.floor(clean.length / 2)];
}

// `env` is threaded in solely so the quota counter can be updated — this is
// the one function every quota-consuming Browse API call passes through.
async function searchEbaySold(keywords, appId, certId, env) {
  try {
    const token = await getOAuthToken(appId, certId);
    const params = new URLSearchParams({
      q: keywords,
      filter: 'priceCurrency:USD,buyingOptions:{FIXED_PRICE}',
      sort: 'price',
      limit: '50',
    });
    // Counted before the await: a call that times out still consumed quota.
    if (env) recordEbayCall(env).catch(() => {});
    const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const msg = body?.errors?.[0]?.longMessage || body?.errors?.[0]?.message || `HTTP ${res.status}`;
      return { items: [], error: msg };
    }
    const data = await res.json();
    const items = (data.itemSummaries || [])
      .map((s) => ({ title: s.title, price: Number(s.price?.value) }))
      .filter((i) => i.title && Number.isFinite(i.price) && i.price > 0);
    return { items, bestTitle: pickBestTitle(items), source: 'browse_api' };
  } catch (e) {
    return { items: [], error: e?.message || 'browse_api_failed' };
  }
}

// Median + Q1 + Q3 + count. Drops outliers outside [0.3×median, 3×median]
// when ≥3 samples remain.
function extractPriceStats(items, bestTitle) {
  if (!items || items.length === 0) return null;
  let prices = items.map((i) => i.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const med0 = prices[Math.floor(prices.length / 2)];
  const filtered = prices.filter((p) => p >= med0 * 0.3 && p <= med0 * 3);
  if (filtered.length >= 3) prices = filtered;
  const med = prices[Math.floor(prices.length / 2)];
  const q1  = prices[Math.floor(prices.length * 0.25)];
  const q3  = prices[Math.floor(prices.length * 0.75)];
  return {
    title:    bestTitle || null,
    avgPrice: Math.round(med * 100) / 100,
    lowPrice: Math.round(q1  * 100) / 100,
    highPrice:Math.round(q3  * 100) / 100,
    numSales: prices.length,
  };
}

function rateLimited(err) {
  const m = (err || '').toLowerCase();
  return m.includes('exceeded') || m.includes('ratelimiter') || m.includes('rate limit');
}

// Three-phase pricing. Returns null if no results found OR no creds.
// Throws Error('RATE_LIMITED') if eBay rate-limited — caller can halt batch.
export async function priceItemViaBrowseApi(item, opts, env) {
  const { appId, certId, enableKeywordSearch } = opts;
  if (!appId || !certId) return null;

  const upc = String(item.upc || '').replace(/\D/g, '');
  const validUpc = /^\d{12,13}$/.test(upc);
  const cacheKey = validUpc ? upc : `kw:${simpleHash(`${item.brand || ''}|${item.title || ''}`)}`;

  // Cache check — Browse API cache entries marked priceSource:'browse-api'.
  const cached = await getUpcCacheEntry(env, cacheKey);
  if (cached && cached.priceSource === 'browse-api') {
    return {
      ...cached,
      cacheKey,
      found: cached.numSales > 0 && Number.isFinite(cached.avgPrice),
      source: 'cached-browse-api',
    };
  }

  let allItems = [];
  let bestTitle = '';

  // Phase 1: UPC search
  if (validUpc) {
    const r = await searchEbaySold(upc, appId, certId, env);
    if (r.error) {
      if (rateLimited(r.error)) throw new Error('RATE_LIMITED');
      // Other errors — fall through to keyword if enabled
    } else {
      allItems = r.items || [];
      bestTitle = r.bestTitle || '';
    }
  }

  // Phase 2: bestTitle broaden when partial hit
  if (enableKeywordSearch !== false && allItems.length > 0 && allItems.length < 10 && bestTitle) {
    const refined = stripSellerJunk(bestTitle).slice(0, 80);
    if (refined.length > 5) {
      const r = await searchEbaySold(refined, appId, certId, env);
      if (!r.error && r.items?.length) {
        const seen = new Set(allItems.map((i) => Math.round(i.price * 100)));
        for (const it of r.items) {
          const k = Math.round(it.price * 100);
          if (!seen.has(k)) { allItems.push(it); seen.add(k); }
        }
      }
    }
  }

  // Phase 3: cleanKeyword fallback when nothing
  if (enableKeywordSearch !== false && allItems.length === 0) {
    const kw = cleanKeyword(item.brand, item.title);
    if (kw.length > 5) {
      const r = await searchEbaySold(kw, appId, certId, env);
      if (r.error) {
        if (rateLimited(r.error)) throw new Error('RATE_LIMITED');
      } else {
        allItems = r.items || [];
        bestTitle = r.bestTitle || '';
      }
    }
  }

  const stats = extractPriceStats(allItems, bestTitle);
  if (!stats) {
    return { cacheKey, found: false, priceSource: 'browse-api', avgPrice: null, lowPrice: null, highPrice: null, numSales: 0, title: null };
  }
  const result = {
    ...stats,
    priceSource: 'browse-api',
    upc: validUpc ? upc : null,
    cacheKey,
    found: true,
    source: 'live-browse-api',
    cachedAt: new Date().toISOString(),
  };
  await putUpcCacheEntry(env, cacheKey, result);
  return result;
}

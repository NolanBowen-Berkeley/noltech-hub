// ─── UPC cache + eBay call-stat routes ───────────────────────────────────────
// Both endpoints existed on the old local Express scraper and were dropped in
// the Cloudflare port, which left two Hub features quietly broken:
//
//   GET /upc-cache        BrowseLotsView pulls this after every enrich batch
//                         and merges it into the Hub's IndexedDB UPC cache, so
//                         pricing learned on one lot carries to the next.
//   GET /ebay/call-stats  the Browse API quota gauge in the browse header.
//
// Restored here against the same response shapes the Hub already parses.

import { json } from '../lib/response.js';
import { getEbayCallStats } from '../services/pricing/callStats.js';

// The Hub merges this into local storage via utils/upcCacheMerge.js, which
// expects { success: true, cache: { [cacheKey]: entry } }.
export async function upcCacheRoute(request, env, _ctx, log) {
  const url = new URL(request.url);
  const limit = Math.min(20000, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 5000));

  const kv = env.PIPELINE_CACHE || env.SCRAPER_CACHE;
  if (!kv) return json({ success: false, error: 'cache_not_configured', cache: {} }, 503);

  const cache = {};
  let scanned = 0;
  let cursor = null;

  try {
    do {
      const page = await kv.list({ prefix: 'upc:', cursor });
      for (const { name } of page.keys) {
        if (scanned >= limit) break;
        scanned += 1;
        // Keys are `upc:<cacheKey>`; the Hub indexes by the bare cacheKey.
        const cacheKey = name.slice(4);
        if (!cacheKey) continue;
        const entry = await kv.get(name, { type: 'json' });
        // A null here means the entry expired between list and get. Skip it
        // rather than writing a tombstone into the Hub's cache.
        if (entry) cache[cacheKey] = entry;
      }
      cursor = scanned >= limit || page.list_complete ? null : page.cursor;
    } while (cursor);
  } catch (e) {
    log?.error?.('upc_cache_read_failed', { message: e?.message });
    return json({ success: false, error: e?.message || 'read_failed', cache: {} }, 500);
  }

  log?.info?.('upc_cache_served', { entries: Object.keys(cache).length, scanned });
  return json({ success: true, count: Object.keys(cache).length, truncated: scanned >= limit, cache });
}

export async function ebayCallStatsRoute(_request, env, _ctx, _log) {
  return json(await getEbayCallStats(env));
}

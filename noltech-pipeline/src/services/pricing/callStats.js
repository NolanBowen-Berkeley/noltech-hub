// ─── eBay API call counter ───────────────────────────────────────────────────
// The old local Express scraper tracked eBay Browse API usage against the
// 5,000/day application quota and surfaced it in BrowseLotsView's header. The
// Cloudflare port dropped the counter, so /api/ebay/call-stats 404'd and the
// Hub silently showed nothing.
//
// Counts are bucketed per UTC day in the disk KV store under
// `ebay:calls:<YYYY-MM-DD>`, with a 3-day TTL — enough for the Hub to render
// today's usage without accumulating unbounded history.
//
// Only counts calls that consume the quota: Browse API item_summary/search.
// The OAuth token endpoint is exempt from the quota and is not counted.

import { cacheGetJson, cachePutJson } from './cache.js';

const TTL_SECONDS = 3 * 86400;

// eBay's default application quota for the Browse API. Overridable via .env
// when an increased limit has been granted.
const DEFAULT_DAILY_LIMIT = 5000;

export function todayKey(now = new Date()) {
  return `ebay:calls:${now.toISOString().slice(0, 10)}`;
}

// Increments the day's counter. Best-effort: a failed write must never break
// the pricing call it is measuring, so all errors are swallowed.
//
// Not atomic — a read-modify-write race between two concurrent enrich batches
// can lose an increment. That is acceptable for a usage gauge, and the
// alternative (a lock per increment) would serialize the pricing path.
export async function recordEbayCall(env, count = 1) {
  try {
    const key = todayKey();
    const current = (await cacheGetJson(env, key)) || { calls: 0 };
    const next = { calls: (Number(current.calls) || 0) + count, updatedAt: new Date().toISOString() };
    await cachePutJson(env, key, next, TTL_SECONDS);
  } catch {
    // Counter is diagnostic only.
  }
}

export async function getEbayCallStats(env) {
  const date = new Date().toISOString().slice(0, 10);
  const limit = Number(env.EBAY_DAILY_CALL_LIMIT) || DEFAULT_DAILY_LIMIT;
  let calls = 0;
  try {
    const rec = await cacheGetJson(env, todayKey());
    calls = Number(rec?.calls) || 0;
  } catch {
    calls = 0;
  }
  return {
    calls,
    limit,
    remaining: Math.max(0, limit - calls),
    date,
  };
}

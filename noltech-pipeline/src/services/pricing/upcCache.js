// ─── KV-backed UPC pricing cache ─────────────────────────────────────────────
// Cloud equivalent of scraper/utils/upcCache.js. Same key/value semantics so
// entries written here are forward-compatible with the Hub's IndexedDB cache
// (the Hub already merges UPC entries by cachedAt newest-wins).
//
// Key shape:   `upc:${upcOrKwHash}`  e.g. upc:012345678901 or upc:kw:abc12
// Value shape: { title, avgPrice, lowPrice, highPrice, numSales, priceSource,
//                upc, cacheKey, cachedAt }

import { cacheGetJson, cachePutJson } from './cache.js';

// Local TTL — only used for refresh decisions on cached sold-comps entries.
// Mirrors SOLD_COMPS_LOCAL_TTL_MS = 60 days in scraper/server.js.
export const SOLD_COMPS_LOCAL_TTL_MS = 60 * 86400000;

export async function getUpcCacheEntry(env, key) {
  if (!key) return null;
  return cacheGetJson(env, `upc:${key}`);
}

export async function putUpcCacheEntry(env, key, value, ttlSeconds) {
  if (!key || !value) return;
  const stamped = { ...value, cachedAt: value.cachedAt || new Date().toISOString() };
  // KV TTL is a hard expiry — set it well past SOLD_COMPS_LOCAL_TTL_MS so
  // entries survive long enough for callers to enforce their own staleness
  // policy. 180 days default.
  await cachePutJson(env, `upc:${key}`, stamped, ttlSeconds || 180 * 86400);
}

// Returns true when the cached entry is still considered fresh by the
// 60-day refresh-check policy. Callers can short-circuit on hit.
export function isEntryFresh(entry, ttlMs = SOLD_COMPS_LOCAL_TTL_MS) {
  if (!entry?.cachedAt) return false;
  const at = Date.parse(entry.cachedAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < ttlMs;
}

// ─── UPC cache merge ────────────────────────────────────────────────────────
// When the scraper finishes an enrichment batch it returns its full file-
// backed cache via /api/upc-cache. Naively `window.storage.set(KEY, server)`
// would clobber any client-side modifications the user has made (Gemini-
// cleaned titles, manual edits, manual category overrides, manually-added
// UPCs that haven't been priced yet).
//
// This helper merges the two: server-authoritative for pricing fields
// (avgPrice, lowPrice, highPrice, numSales, cachedAt, priceSource, title
// when freshly fetched); client-preferred for user-modified fields
// (cleanTitle, cleanedAt, category override). UPCs that exist only locally
// (e.g., user-added entries) are preserved entirely.

const CLIENT_PRESERVED_FIELDS = ['cleanTitle', 'cleanedAt', 'category'];

/**
 * Merge a server-side UPC cache snapshot into the local cache.
 *
 * @param {Record<string, object>} local   The current local IndexedDB cache.
 * @param {Record<string, object>} server  Fresh /api/upc-cache snapshot.
 * @returns {Record<string, object>}       Merged cache to persist locally.
 */
export function mergeUpcCache(local, server) {
  const localMap  = local  && typeof local  === 'object' ? local  : {};
  const serverMap = server && typeof server === 'object' ? server : {};

  // Start with everything the client already had — this preserves UPCs that
  // never reached the server (e.g., manually added via "Add UPC").
  const merged = { ...localMap };

  for (const [upc, serverEntry] of Object.entries(serverMap)) {
    const localEntry = localMap[upc];
    if (!localEntry) {
      // New UPC the server has but client doesn't — take it as-is.
      merged[upc] = serverEntry;
      continue;
    }

    // Both sides have this UPC. Server wins for everything by default,
    // EXCEPT the client-preserved fields. If the client had cleaned the
    // title (cleanedAt is set), also keep the cleaned title in `title`
    // so it stays the displayed value across the app.
    const next = { ...serverEntry };
    for (const field of CLIENT_PRESERVED_FIELDS) {
      if (localEntry[field] != null && localEntry[field] !== '') {
        next[field] = localEntry[field];
      }
    }
    // If user has Gemini-cleaned the title locally, the cleaned version is
    // already in `title` (ComponentDB writes there directly). Preserve it
    // over the server's raw title so the user's cleanup work isn't lost.
    if (localEntry.cleanedAt && localEntry.title) {
      next.title = localEntry.title;
    }
    merged[upc] = next;
  }

  return merged;
}

// ── Pruning ──────────────────────────────────────────────────────────────────
// The UPC cache grows unbounded — every priced manifest item adds an entry,
// and entries that haven't been re-priced in months still cost storage. Two
// bounded-decay rules:
//   1. Hard age cap: anything `cachedAt` older than MAX_AGE_DAYS gets dropped,
//      UNLESS it has user-curated content (cleanedAt, manual category, etc.)
//      — those entries stay forever because they represent real human work.
//   2. Size cap: when the cache exceeds MAX_ENTRIES, evict oldest-cachedAt
//      first until back under cap. User-curated entries again skip eviction.
//
// Called from saveUpcCache() so every write site stays bounded — no separate
// scheduler needed.

const MAX_ENTRIES = 50000;
const MAX_AGE_DAYS = 180;
// Age-based pruning is heavy enough (full scan of the cache) that running it
// on every write is wasteful — entries don't suddenly become stale, so a
// 6-month cadence is plenty. The size cap stays per-write since it's cheap
// and keeps the cache bounded between age prunes.
const AGE_PRUNE_INTERVAL_MS = 180 * 86400 * 1000;
const PRUNE_TIMESTAMP_KEY = 'noltech:arbitrage:upc-cache-pruned-at';

function hasCuratedContent(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return !!(entry.cleanedAt || entry.cleanTitle || entry.categoryOverride);
}

/**
 * Apply the LRU + age-cap pruning rules to a UPC cache snapshot. Returns the
 * pruned object — does not mutate the input. Safe to chain after mergeUpcCache.
 */
export function pruneUpcCache(cache, { maxEntries = MAX_ENTRIES, maxAgeDays = MAX_AGE_DAYS } = {}) {
  if (!cache || typeof cache !== 'object') return cache;
  const now = Date.now();
  const ageCutoffMs = maxAgeDays * 86400 * 1000;
  const out = {};
  const evictable = [];   // [{ upc, ts }] for size-cap eviction
  for (const [upc, entry] of Object.entries(cache)) {
    if (!entry || typeof entry !== 'object') continue;
    const curated = hasCuratedContent(entry);
    const ts = entry.cachedAt ? Date.parse(entry.cachedAt) : 0;
    const ageMs = ts > 0 ? now - ts : 0;
    // Age cap — drop if too old AND not curated.
    if (!curated && ts > 0 && ageMs > ageCutoffMs) continue;
    out[upc] = entry;
    if (!curated) evictable.push({ upc, ts });
  }
  // Size cap — evict oldest non-curated until under maxEntries.
  const overflow = Object.keys(out).length - maxEntries;
  if (overflow > 0) {
    evictable.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < overflow && i < evictable.length; i++) {
      delete out[evictable[i].upc];
    }
  }
  return out;
}

// Has it been long enough since the last age-based prune to run another one?
// Defaults to true (run) when the timestamp is missing — first save after a
// restore or fresh install does the initial sweep.
async function isAgePruneDue() {
  try {
    const last = await window.storage.get(PRUNE_TIMESTAMP_KEY);
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return true;
    return Date.now() - lastMs > AGE_PRUNE_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * Convenience wrapper: prune + persist. Every UPC-cache write should go
 * through this so the cache never grows unbounded (the daily-backup
 * RangeError that took down snapshots was driven in part by this cache).
 *
 * Size cap runs on every save (cheap). Age cap runs at most once every 6
 * months, gated by `noltech:arbitrage:upc-cache-pruned-at` — old entries
 * aren't actively harmful, just a slow background cleanup.
 */
export async function saveUpcCache(cache) {
  const runAgePrune = await isAgePruneDue();
  const pruned = pruneUpcCache(cache, {
    maxAgeDays: runAgePrune ? MAX_AGE_DAYS : Infinity,   // Infinity disables the age check inside prune
  });
  if (runAgePrune) {
    try { await window.storage.set(PRUNE_TIMESTAMP_KEY, new Date().toISOString()); } catch {}
  }
  try {
    await window.storage.set('noltech:arbitrage:upc-cache', pruned);
  } catch (e) {
    // Surface via console + the global error log. Don't throw — caller is
    // typically a fire-and-forget sync.
    // eslint-disable-next-line no-console
    console.error('[upcCache] save failed:', e?.message || e);
  }
  return pruned;
}

// ─── Locked months ──────────────────────────────────────────────────────────
// User-managed list of YYYY-MM strings where auto-generated bookkeeping rows
// (eBay sync, Finance API ad-fee splits, label-cost backfills, sale:recorded
// listeners) should be SKIPPED — the user has already imported a manual
// monthly summary from eBay's official statement and doesn't want auto rows
// piling on top.
//
// Storage:
//   noltech:books:locked-months → string[] (e.g. ["2026-01", "2026-02"])
//
// In-memory cache is hydrated on import so the synchronous `isMonthLocked`
// check used inside the event bridge stays fast and doesn't await storage.

const KEY = 'noltech:books:locked-months';

let _cache = null;
const _listeners = new Set();

function notify() {
  for (const fn of _listeners) {
    try { fn([..._cache]); } catch (e) {
      // Swallow so one bad listener can't break the others, but log so the
      // bug is findable. Silent catches here previously masked listener bugs.
      console.error('[lockedMonths] subscriber threw:', e);
    }
  }
}

async function hydrate() {
  if (_cache) return _cache;
  try {
    const raw = await window.storage.get(KEY);
    _cache = Array.isArray(raw) ? raw.filter((s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s)) : [];
  } catch {
    _cache = [];
  }
  return _cache;
}

// Synchronous check used in hot paths (sale:recorded handler, useSyncAll).
// Returns false until hydrate() finishes, then accurate. Hydrate is fired
// at module load so the gap is small.
export function isMonthLocked(date) {
  if (!_cache) return false;
  if (!date) return false;
  const ym = String(date).slice(0, 7);
  return _cache.includes(ym);
}

export async function getLockedMonths() {
  await hydrate();
  return [..._cache];
}

export async function lockMonth(yearMonth) {
  await hydrate();
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return _cache;
  if (!_cache.includes(yearMonth)) {
    _cache.push(yearMonth);
    _cache.sort();
    await window.storage.set(KEY, _cache).catch(console.error);
    notify();
  }
  return [..._cache];
}

export async function unlockMonth(yearMonth) {
  await hydrate();
  _cache = _cache.filter((m) => m !== yearMonth);
  await window.storage.set(KEY, _cache).catch(console.error);
  notify();
  return [..._cache];
}

export function subscribeLockedMonths(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// Fire-and-forget hydration on module load so isMonthLocked is reliable
// shortly after app start. Components that need certainty can still await
// getLockedMonths().
hydrate().catch(() => {});

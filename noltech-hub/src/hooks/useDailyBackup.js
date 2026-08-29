// ─── Daily automated backup ──────────────────────────────────────────────────
// Once per calendar day, captures a snapshot of all backup-key data. Keeps
// the last 30 days. NOT a substitute for off-device backup — IndexedDB
// corruption takes it with — but useful for "I deleted X last week, undo".
//
// Storage shape (post-rewrite):
//   noltech:backup:daily-snapshots → metadata index ONLY
//     { snapshots: [{ date, capturedAt, sizeKb, keyCount, failedKeys }],
//       lastSuccessAt: ISO | null,
//       lastError:     { at: ISO, message: string } | null }
//   noltech:backup:daily:<YYYY-MM-DD> → that day's actual data blob
//
// This split fixes the v8 string-length blow-up that took out the old
// implementation: previously the entire 30-day history + all backed-up keys
// were JSON.stringified into a single value, which RangeError'd once the
// merged blob crossed ~512MB (browse-lots + upc-cache + ai-summaries got
// big). Per-day keys keep each write small and the index tiny.

import { useEffect } from 'react';
import { BACKUP_KEYS } from '../utils/backupKeys';
import eventBus from '../services/eventBus';

const KEY_INDEX = 'noltech:backup:daily-snapshots';
const KEY_PER_DAY_PREFIX = 'noltech:backup:daily:';
const MAX_DAYS = 30;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const perDayKey = (date) => `${KEY_PER_DAY_PREFIX}${date}`;

// ── Index (metadata only) ────────────────────────────────────────────────────

async function readIndex() {
  try {
    const v = await window.storage.get(KEY_INDEX);
    if (!v || typeof v !== 'object') return { snapshots: [], lastSuccessAt: null, lastError: null };
    // Tolerate the legacy shape where snapshots[i].data was embedded —
    // strip it so the index stays small. Legacy entries had to be smaller
    // than the v8 limit to land here, so they're at most a few hundred MB.
    const snapshots = Array.isArray(v.snapshots)
      ? v.snapshots.map((s) => {
          if (!s || typeof s !== 'object') return null;
          const { data, ...meta } = s;
          return meta;
        }).filter(Boolean)
      : [];
    return {
      snapshots,
      lastSuccessAt: typeof v.lastSuccessAt === 'string' ? v.lastSuccessAt : null,
      lastError:     v.lastError && typeof v.lastError === 'object' ? v.lastError : null,
    };
  } catch {
    return { snapshots: [], lastSuccessAt: null, lastError: null };
  }
}

async function writeIndex(index) {
  try {
    await window.storage.set(KEY_INDEX, index);
  } catch (e) {
    // If even the metadata-only index can't write, log + give up — there's
    // nothing we can do from inside the snapshot subsystem.
    console.error('[dailyBackup] index write failed:', e);
  }
}

// ── Notifications ────────────────────────────────────────────────────────────

function notifyError(message) {
  try {
    eventBus.emit('notification:push', {
      type: 'error',
      title: 'Daily backup failed',
      message: String(message || 'Unknown error — see console for details.').slice(0, 240),
    });
  } catch {}
}

async function recordError(e) {
  const message = e?.message || String(e);
  console.error('[dailyBackup]', message);
  notifyError(message);
  const index = await readIndex();
  await writeIndex({
    ...index,
    lastError: { at: new Date().toISOString(), message },
  });
}

// ── Capture ─────────────────────────────────────────────────────────────────

async function captureSnapshot() {
  const data = {};
  let bytes = 0;
  const failedKeys = [];
  for (const key of BACKUP_KEYS) {
    let v;
    try {
      v = await window.storage.get(key);
    } catch (e) {
      failedKeys.push({ key, error: e?.message || String(e) });
      continue;
    }
    if (v === null || v === undefined) continue;
    data[key] = v;
    // Per-key size accumulation. A single giant key MIGHT still exceed the
    // v8 string limit on stringify — wrap in try/catch and accept "size
    // unknown" rather than failing the whole snapshot.
    try { bytes += JSON.stringify(v).length; } catch {}
  }
  return {
    meta: {
      date: todayKey(),
      capturedAt: new Date().toISOString(),
      sizeKb: Math.round(bytes / 1024),
      keyCount: Object.keys(data).length,
      failedKeys: failedKeys.length > 0 ? failedKeys : undefined,
    },
    data,
  };
}

export async function captureNow() {
  let snapshot;
  try {
    snapshot = await captureSnapshot();
  } catch (e) {
    await recordError(e);
    throw e;
  }

  // Write the per-day data to its own key first. This is the only write that
  // can blow up if a single key is enormous (e.g. browse-lots after a huge
  // scrape). If it fails, the index isn't touched and the user gets a toast.
  try {
    await window.storage.set(perDayKey(snapshot.meta.date), snapshot.data);
  } catch (e) {
    await recordError(e);
    throw e;
  }

  // Update the index (small) and prune the oldest per-day keys outside the
  // 30-day window.
  const index = await readIndex();
  const today = snapshot.meta.date;
  const next = [snapshot.meta, ...index.snapshots.filter((s) => s.date !== today)]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_DAYS);
  const keptDates = new Set(next.map((s) => s.date));
  const droppedDates = index.snapshots
    .filter((s) => !keptDates.has(s.date))
    .map((s) => s.date);
  for (const d of droppedDates) {
    try { await window.storage.set(perDayKey(d), null); } catch {}
  }
  await writeIndex({
    snapshots: next,
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
  });
  return snapshot.meta;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function listSnapshots() {
  const { snapshots } = await readIndex();
  return snapshots;
}

export async function getSnapshot(date) {
  const { snapshots } = await readIndex();
  const meta = snapshots.find((s) => s.date === date);
  // New shape: read the per-day key, combine with index metadata
  try {
    const data = await window.storage.get(perDayKey(date));
    if (data && typeof data === 'object') {
      return {
        date,
        capturedAt: meta?.capturedAt || null,
        sizeKb:     meta?.sizeKb || 0,
        keyCount:   meta?.keyCount || Object.keys(data).length,
        data,
      };
    }
  } catch {}
  // Legacy shape fallback: data was embedded in the index
  try {
    const v = await window.storage.get(KEY_INDEX);
    const legacy = Array.isArray(v?.snapshots)
      ? v.snapshots.find((s) => s?.date === date && s?.data)
      : null;
    if (legacy) {
      return {
        date,
        capturedAt: legacy.capturedAt || null,
        sizeKb:     legacy.sizeKb || 0,
        keyCount:   legacy.keyCount || (legacy.data ? Object.keys(legacy.data).length : 0),
        data:       legacy.data,
      };
    }
  } catch {}
  return null;
}

export async function deleteSnapshot(date) {
  try { await window.storage.set(perDayKey(date), null); } catch {}
  const index = await readIndex();
  await writeIndex({
    ...index,
    snapshots: index.snapshots.filter((s) => s.date !== date),
  });
}

// Exposed for a Settings indicator — "Daily backup: last success Mar 5, 2026
// — 12.3 MB / 38 keys" / "FAILED 2 days ago: <reason>".
export async function getBackupStatus() {
  const { snapshots, lastSuccessAt, lastError } = await readIndex();
  return {
    snapshotCount: snapshots.length,
    lastSuccessAt,
    lastError,
    latestSnapshot: snapshots[0] || null,
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────

export default function useDailyBackup() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { snapshots } = await readIndex();
      const today = todayKey();
      if (snapshots.some((s) => s.date === today)) return; // already captured today
      // Wait a few seconds after launch so we don't compete with sync activity.
      setTimeout(async () => {
        if (cancelled) return;
        try {
          await captureNow();
        } catch (e) {
          // recordError() already logged + notified; nothing else to do.
        }
      }, 30000);
    })();
    return () => { cancelled = true; };
  }, []);
}

// ─── Error log service ──────────────────────────────────────────────────────
// Rolling buffer of recent errors, persisted under noltech:errors:recent.
// Three consumers: ModuleErrorBoundary (React crashes), background workers
// (sync, scrape, listing push), and the Settings → Errors panel which reads
// it for diagnosis.
//
// Also bridges to the global notification:push event so anywhere that emits
// a kind:'error' notification automatically lands here too — no need for
// callers to remember both.

import eventBus from './eventBus';

const KEY = 'noltech:errors:recent';
const MAX_ENTRIES = 200;

/**
 * Append an error to the rolling log.
 * @param {string} source short label like 'bid-poll' / 'enrich' / 'settings:save'
 * @param {Error|string|unknown} err
 * @param {object} [meta] optional structured context
 */
export async function logError(source, err, meta = undefined) {
  const message = err?.message || (typeof err === 'string' ? err : 'Unknown error');
  const stack = err?.stack ? String(err.stack).slice(0, 2000) : undefined;
  const entry = {
    at: new Date().toISOString(),
    source: String(source || 'unknown').slice(0, 80),
    message: String(message).slice(0, 500),
    stack,
    meta,
  };
  try {
    const log = (await window.storage.get(KEY)) || [];
    log.unshift(entry);
    if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES;
    await window.storage.set(KEY, log);
  } catch (e) {
    // Last resort if even the log write fails.
    // eslint-disable-next-line no-console
    console.error('[errorLog] write failed:', e?.message || e, '| original:', entry);
  }
  // Best-effort console mirror for live debugging.
  // eslint-disable-next-line no-console
  console.error(`[${entry.source}]`, message, stack ? `\n${stack.split('\n').slice(0, 5).join('\n')}` : '');
}

export async function getRecentErrors() {
  try {
    const v = await window.storage.get(KEY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function clearErrors() {
  try { await window.storage.set(KEY, []); } catch {}
}

// Bridge: every notification:push with kind 'error' is also captured here, so
// a single emit lights up both the toast UI and the persistent error log.
// Idempotent — late imports of this module won't double-register because we
// guard with a one-shot module-level flag.
let _bridgeInstalled = false;
export function installErrorBridge() {
  if (_bridgeInstalled) return;
  _bridgeInstalled = true;
  try {
    eventBus.on('notification:push', (payload) => {
      if (!payload || payload.kind !== 'error') return;
      // Don't await — fire-and-forget so the event handler stays fast.
      logError(payload.title || 'notification', new Error(payload.message || ''), payload.meta);
    });
  } catch {}
}

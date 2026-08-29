// ─── Cron registry ───────────────────────────────────────────────────────────
// Task names, default schedules, and live run-state. Kept in its own module
// with no imports of its own so both the router (src/index.js) and the health
// route can read it without creating an import cycle back through the
// scheduler, which necessarily depends on the router.

export const CRON_TASKS = ['discovery', 'analysis', 'refresh', 'alerts', 'ebay-sync'];

// Defaults preserve the effective cadence of the old wrangler.toml triggers.
// Cloudflare required unique cron strings, so five logical jobs had to share
// three triggers and be demultiplexed by inspecting controller.cron. Locally
// each job gets its own independent schedule.
export const CRON_SCHEDULES = {
  analysis:    '*/5 * * * *',
  alerts:      '*/5 * * * *',
  refresh:     '*/15 * * * *',
  discovery:   '*/30 * * * *',
  'ebay-sync': '*/30 * * * *',
};

// .env override key per task, e.g. CRON_DISCOVERY='*/15 * * * *'.
export const CRON_ENV_KEYS = {
  analysis:    'CRON_ANALYSIS',
  alerts:      'CRON_ALERTS',
  refresh:     'CRON_REFRESH',
  discovery:   'CRON_DISCOVERY',
  'ebay-sync': 'CRON_EBAY_SYNC',
};

const status  = new Map();
const running = new Set();

export function markRegistered(name, schedule, enabled, error = null) {
  const prev = status.get(name) || {};
  status.set(name, { ...prev, schedule, enabled, lastError: error ?? prev.lastError ?? null });
}

export function isRunning(name) { return running.has(name); }
export function markStart(name) { running.add(name); }
export function markEnd(name)   { running.delete(name); }

export function recordRun(name, { startedAt, ok, ms, error }) {
  const prev = status.get(name) || {};
  status.set(name, {
    ...prev,
    lastRunAt: new Date(startedAt).toISOString(),
    lastOk:    ok,
    lastMs:    ms,
    lastError: ok ? null : (error || 'failed'),
    runs:      (prev.runs || 0) + 1,
    failures:  (prev.failures || 0) + (ok ? 0 : 1),
  });
}

// Shape consumed by /health and, through it, the Hub's SystemHealthCard —
// which needs to distinguish "never ran" from "ran and failed".
export function getCronStatus() {
  const out = {};
  for (const name of CRON_TASKS) {
    const s = status.get(name) || {};
    out[name] = {
      schedule:  s.schedule  ?? null,
      enabled:   s.enabled   ?? false,
      running:   running.has(name),
      lastRunAt: s.lastRunAt ?? null,
      lastOk:    s.lastOk    ?? null,
      lastMs:    s.lastMs    ?? null,
      lastError: s.lastError ?? null,
      runs:      s.runs      ?? 0,
      failures:  s.failures  ?? 0,
    };
  }
  return out;
}

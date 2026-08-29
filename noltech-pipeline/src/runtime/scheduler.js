// ─── Cron scheduler ──────────────────────────────────────────────────────────
// Replaces Cloudflare's scheduled() handler with node-cron timers.
//
// Task names, default schedules and run-state live in cronRegistry.js so the
// health route can read them without importing this module (which depends on
// the router, which the health route is part of).
//
// Overlap guard: node-cron will happily start a second run while the first is
// still going. A discovery pass can exceed 30s and an analysis drain can run
// for minutes, so each task refuses to start while its previous run is still
// in flight — this is what Cloudflare's per-invocation isolation gave us for
// free.

import cron from 'node-cron';
import { runCronTask } from '../index.js';
import { createLogger, newTraceId } from '../lib/logger.js';
import { createExecutionContext } from './ctx.js';
import {
  CRON_TASKS, CRON_SCHEDULES, CRON_ENV_KEYS,
  markRegistered, recordRun, isRunning, markStart, markEnd,
} from './cronRegistry.js';

const jobs = [];

async function invoke(name, env, parentLog) {
  if (isRunning(name)) {
    parentLog?.warn?.('cron_overlap_skipped', { cron_name: name });
    return { ok: false, error: 'overlap_skipped' };
  }
  markStart(name);

  const ctx = createExecutionContext(`cron:${name}`);
  const log = createLogger(env, ctx, { traceId: newTraceId(), kind: 'cron', cron_name: name });
  const startedAt = Date.now();

  try {
    const result = await runCronTask(name, env, ctx, log);
    recordRun(name, {
      startedAt,
      ok: result?.ok !== false,
      ms: Date.now() - startedAt,
      error: result?.error,
    });
    return result;
  } catch (e) {
    // runCronTask catches internally; this is the belt-and-braces path so a
    // scheduler-level throw can never take the process down.
    recordRun(name, { startedAt, ok: false, ms: Date.now() - startedAt, error: e?.message || 'threw' });
    log.error('cron_scheduler_threw', { message: e?.message });
    return { ok: false, error: e?.message || 'threw' };
  } finally {
    markEnd(name);
    // Let fire-and-forget cache writes finish before the tick is considered
    // over, so a shutdown right after a cron doesn't truncate them.
    await ctx.drain(5000);
  }
}

export function startScheduler(env, log) {
  // CRONS_ENABLED=false runs the service as a pure HTTP scraper with no
  // background work — useful when the Hub is open on two machines and you
  // only want one of them driving discovery.
  const cronsEnabled = String(env.CRONS_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!cronsEnabled) log?.warn?.('crons_disabled_globally');

  for (const name of CRON_TASKS) {
    const schedule = env[CRON_ENV_KEYS[name]] || CRON_SCHEDULES[name];

    // A schedule of 'off' disables just that one job.
    if (!cronsEnabled || String(schedule).toLowerCase() === 'off') {
      markRegistered(name, null, false);
      log?.info?.('cron_disabled', { cron_name: name });
      continue;
    }

    if (!cron.validate(schedule)) {
      markRegistered(name, null, false, `invalid schedule: ${schedule}`);
      log?.error?.('cron_invalid_schedule', { cron_name: name, schedule });
      continue;
    }

    jobs.push(cron.schedule(schedule, () => { invoke(name, env, log); }));
    markRegistered(name, schedule, true);
    log?.info?.('cron_registered', { cron_name: name, schedule });
  }

  return { stop: stopScheduler };
}

export function stopScheduler() {
  for (const job of jobs) {
    try { job.stop(); } catch { /* already stopped */ }
  }
  jobs.length = 0;
}

// Used by the server's --run-once mode. Goes through the same overlap guard
// and status bookkeeping as a scheduled firing.
export async function runTaskNow(name, env, log) {
  return invoke(name, env, log);
}

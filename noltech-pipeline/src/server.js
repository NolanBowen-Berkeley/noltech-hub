#!/usr/bin/env node
// ─── noltech-pipeline local server ───────────────────────────────────────────
// Entrypoint for the pipeline as a long-lived Node service. Replaces the
// Cloudflare Worker runtime: node:http instead of the Workers fetch handler,
// node-cron instead of scheduled(), disk-backed KV/R2 shims instead of
// Cloudflare bindings.
//
//   npm start                    serve HTTP + run crons
//   npm start -- --no-crons      serve HTTP only
//   npm start -- --run-once discovery
//                                run one cron task, print the result, exit
//                                (exit 1 if the task failed)
//
// Binds 127.0.0.1 by default. Bind a LAN address only with SHARED_AUTH_SECRET
// set — see README.

import http from 'node:http';
import 'dotenv/config';

import { handleRequest } from './index.js';
import { buildEnv, describeEnvGaps } from './runtime/env.js';
import { createExecutionContext } from './runtime/ctx.js';
import { toWebRequest, sendWebResponse } from './runtime/httpAdapter.js';
import { startScheduler, stopScheduler, runTaskNow } from './runtime/scheduler.js';
import { CRON_TASKS } from './runtime/cronRegistry.js';
import { createLogger, newTraceId } from './lib/logger.js';

// ─── CLI args ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const runOnce   = opt('run-once');
const noCrons   = flag('no-crons');
const port      = Number(opt('port') || process.env.PIPELINE_PORT || 3001);
const host      = opt('host') || process.env.PIPELINE_BIND_HOST || '127.0.0.1';

// ─── Boot ───────────────────────────────────────────────────────────────────

const env = buildEnv(noCrons ? { CRONS_ENABLED: 'false' } : {});
const bootCtx = createExecutionContext('boot');
const log = createLogger(env, bootCtx, { traceId: newTraceId(), kind: 'server' });

const gaps = describeEnvGaps(env);
for (const gap of gaps) log.warn('env_gap', gap);

// --run-once: execute a single cron task and exit. Used by the Hub's manual
// triggers, ad-hoc debugging, and Task Scheduler / cron entries on a box that
// doesn't keep the service resident.
if (runOnce) {
  if (!CRON_TASKS.includes(runOnce)) {
    console.error(`unknown task '${runOnce}' — expected one of: ${CRON_TASKS.join(', ')}`);
    process.exit(2);
  }
  const result = await runTaskNow(runOnce, env, log);
  console.log(JSON.stringify({ task: runOnce, ...result }, null, 2));
  await bootCtx.drain(5000);
  process.exit(result?.ok === false ? 1 : 0);
}

// ─── HTTP server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const traceId = req.headers['x-trace-id'] || newTraceId();
  const reqCtx = createExecutionContext(`req:${traceId}`);
  const reqLog = createLogger(env, reqCtx, { traceId, kind: 'http' });

  try {
    const request = toWebRequest(req, port);
    const response = await handleRequest(request, env, reqCtx, reqLog);
    await sendWebResponse(res, response);
  } catch (e) {
    reqLog.error('request_failed', { message: e?.message, stack: e?.stack?.slice(0, 1000) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'internal', error: e?.message || 'unknown', traceId }));
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    // Background work (cache writes, log shipping) outlives the response, as
    // it did under ctx.waitUntil on Workers. Not awaited — that would defeat
    // the point — but drained on shutdown.
    reqCtx.drain(10000).catch(() => {});
  }
});

// Scrapes routinely run past 60s (a full /lots/all fan-out through Bright Data
// can take 90s+). Node's 2-minute default header timeout and 5-second
// keep-alive are both too tight for that.
server.requestTimeout = 0;
server.headersTimeout = 185000;
server.keepAliveTimeout = 75000;
server.timeout = 0;

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    log.error('port_in_use', { port, host });
    console.error(
      `\n  Port ${port} is already in use.\n` +
      `  Another copy of the pipeline is probably already running.\n` +
      `  Use --port to pick a different one, or stop the other process.\n`,
    );
    process.exit(1);
  }
  log.error('server_error', { message: e?.message, code: e?.code });
});

server.listen(port, host, () => {
  log.info('listening', { host, port, dataDir: env.DATA_DIR });
  banner();
  if (!noCrons) startScheduler(env, log);
});

function banner() {
  const authNote = env.SHARED_AUTH_SECRET
    ? 'bearer auth ENABLED'
    : 'no auth (loopback only — set SHARED_AUTH_SECRET before binding a LAN address)';

  // Crons can be off for two independent reasons — the --no-crons flag or
  // CRONS_ENABLED=false in .env. Reporting only the flag made an .env-disabled
  // setup print "crons: enabled", which is exactly backwards.
  const envDisabled = String(env.CRONS_ENABLED ?? 'true').toLowerCase() === 'false';
  const cronNote = noCrons     ? 'disabled (--no-crons)'
                 : envDisabled ? 'disabled (CRONS_ENABLED=false)'
                 : 'enabled';

  console.log(
    `\n  noltech-pipeline (local)\n` +
    `  http://${host}:${port}\n` +
    `  data: ${env.DATA_DIR}\n` +
    `  ${authNote}\n` +
    `  crons: ${cronNote}\n` +
    (gaps.length ? `  ${gaps.length} config gap(s) — see warnings above\n` : ''),
  );
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────
// Electron sends SIGTERM when the Hub quits. Draining rather than hard-exiting
// keeps a half-written cache entry from surviving on disk.

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown_start', { signal });

  stopScheduler();
  server.close();

  const timer = setTimeout(() => {
    log.warn('shutdown_forced');
    process.exit(0);
  }, 8000);
  timer.unref();

  await bootCtx.drain(5000);
  log.info('shutdown_done');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Windows has no real SIGTERM for child processes, so Electron signals a clean
// stop by closing stdin instead (see electron/main.cjs).
if (process.env.PIPELINE_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.on('close', () => shutdown('stdin-close'));
  process.stdin.on('end',   () => shutdown('stdin-end'));
  process.stdin.resume();
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandled_rejection', { message: reason?.message || String(reason) });
});
process.on('uncaughtException', (e) => {
  log.error('uncaught_exception', { message: e?.message, stack: e?.stack?.slice(0, 1000) });
  // Keep serving: a single bad scrape parse shouldn't take down the crons.
});

export { server, env };

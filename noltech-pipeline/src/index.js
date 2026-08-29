// ─── noltech-pipeline ───────────────────────────────────────────────────────
// Router + cron dispatch for the manifest-scoring pipeline.
//
// Route handlers use the Web Fetch signature — (Request, env, ctx, log) →
// Response — because src/runtime/httpAdapter.js translates node:http at the
// edge. Nothing under routes/, services/, providers/, or shared/ knows the
// difference, which is what lets the same handlers run under a serverless
// runtime if you ever want them to.
//
// Five cron tasks and their HTTP counterparts:
//   - 'analysis'   + routes/analyze.js    score queued lots
//   - 'discovery'  + routes/discover.js   find and enqueue new lots
//   - 'refresh'    + routes/refresh.js    keep bid/end-time fresh
//   - 'alerts'                            fire phone alerts (no HTTP surface)
//   - 'ebay-sync'  + routes/ebay.js       pull orders/listings from eBay
//
// Every cron handler invokes the same route function HTTP traffic uses — no
// duplicate logic between the two paths.
//
// All outside data — lots, manifests, prices — arrives through the provider
// interface in src/providers/. See docs/DATA-SOURCES.md.

import { corsPreflight } from './lib/cors.js';
import { errors } from './lib/response.js';
import { checkAuth } from './lib/auth.js';

// Implemented routes
import { health }              from './routes/health.js';
import { compsLookup }         from './routes/comps.js';
import { fetchManifest }       from './routes/manifest.js';
import { analyzeLotRoute }     from './routes/analyze.js';
import { refreshLotRoute, refreshStaleLots } from './routes/refresh.js';
import { discoverLotsRoute, runDiscoveryCron as discoveryCron } from './routes/discover.js';
import { runBidAlerts }        from './routes/alerts.js';
import { ebaySyncRoute, runEbaySync } from './routes/ebay.js';
import {
  lotsAll, lotsAllStream, sampleLotsRoute,
  lotManifest, lotImage, lotClosingPrice,
  enrichLotRoute,
} from './routes/lots.js';
import { flushCaches, diagProviders } from './routes/admin.js';
import { upcCacheRoute, ebayCallStatsRoute } from './routes/upcCacheRoute.js';
import { CRON_TASKS } from './runtime/cronRegistry.js';

const analyzeLot   = analyzeLotRoute;
const refreshLot   = refreshLotRoute;
const discoverLots = discoverLotsRoute;
const ebaySync     = ebaySyncRoute;
const imageProxy   = lotImage;

// ─── Path normalization ─────────────────────────────────────────────────────
// The Hub was originally written against a local Express scraper that served
// everything under /api/*, then repointed at the Worker's bare paths. Both
// shapes are accepted here so either client generation works without a
// rewrite layer.

function normalizePath(rawPath) {
  const trimmed = rawPath.replace(/\/+$/, '') || '/';
  if (trimmed === '/api') return '/';
  if (trimmed.startsWith('/api/')) return trimmed.slice(4);
  return trimmed;
}

// ─── HTTP entry ─────────────────────────────────────────────────────────────

export async function handleRequest(request, env, ctx, log) {
  if (request.method === 'OPTIONS') return corsPreflight();

  const traceId = log?.traceId || request.headers.get('x-trace-id') || 'no-trace';
  const url  = new URL(request.url);
  const path = normalizePath(url.pathname);

  log?.info?.('request', { method: request.method, path });

  // Public routes — no auth required.
  if (path === '/health') return health(request, env, ctx, log);
  // Image proxy is public because browsers can't attach an Authorization
  // header to an <img src>; bearer-gating it would break every lot thumbnail
  // in the Hub. It serves only what the configured provider hands back.
  if (path === '/lots/image' && request.method === 'GET') {
    return lotImage(request, env, ctx, log);
  }
  // Read-only provider diagnostics. Public alongside /health — reports which
  // providers are configured and what they support. Never returns secrets.
  if (path === '/diag/providers' && request.method === 'GET') {
    return diagProviders(request, env, ctx, log);
  }

  // Everything else requires bearer auth — when a secret is configured.
  // Unset SHARED_AUTH_SECRET means "trusted loopback", the default for a
  // desktop install where the service binds 127.0.0.1 only. Setting a secret
  // is what you do when binding to a LAN address (see README).
  if (env.SHARED_AUTH_SECRET && !checkAuth(request, env)) {
    log?.warn?.('unauthorized', { path });
    return errors.unauthorized(traceId);
  }

  try {
    const handler = matchRoute(request.method, path);
    if (!handler) return errors.notFound(traceId, path);
    return await handler(request, env, ctx, log);
  } catch (e) {
    log?.error?.('handler_threw', { path, message: e?.message, stack: e?.stack?.slice(0, 1000) });
    return errors.internal(traceId, e?.message || 'unknown');
  }
}

// ─── Route table ────────────────────────────────────────────────────────────

function matchRoute(method, path) {
  // Exact matches first.
  const exact = ROUTES[`${method} ${path}`];
  if (exact) return exact;
  // Then dynamic.
  for (const { method: m, pattern, handler } of DYNAMIC_ROUTES) {
    if (m !== method) continue;
    if (pattern.test(path)) return handler;
  }
  return null;
}

const ROUTES = {
  // Sold-comps
  'POST /comps/lookup':            compsLookup,

  // Lot discovery + manifest
  'GET  /lots/discover':           discoverLots,
  'POST /lots/discover':           discoverLots,

  // eBay sync (manual trigger)
  'POST /ebay/sync':               ebaySync,

  // ── Lot routes (provider-backed) ──
  'GET  /lots/all':                lotsAll,
  'GET  /lots/all/stream':         lotsAllStream,
  'GET  /lots/sample':             sampleLotsRoute,
  'GET  /lots/manifest':           lotManifest,
  'GET  /lots/image':              lotImage,
  'POST /lots/closing-price':      lotClosingPrice,
  'POST /lots/enrich':             enrichLotRoute,

  // ── Caches the Hub reads directly ──
  'GET  /upc-cache':               upcCacheRoute,
  'GET  /ebay/call-stats':         ebayCallStatsRoute,

  // Manual cron trigger (debugging + Hub "run now" buttons)
  'POST /run':                     runCronRoute,

  // Admin — bearer-gated cache wipe used by Hub's "Reset scraper caches".
  'POST /admin/flush-caches':      flushCaches,
};
// Normalize keys (the literal map above includes 'POST ' / 'GET  ' spacing
// for readability — strip extra spaces).
for (const k of Object.keys(ROUTES)) {
  const collapsed = k.replace(/\s+/g, ' ');
  if (collapsed !== k) { ROUTES[collapsed] = ROUTES[k]; delete ROUTES[k]; }
}

const DYNAMIC_ROUTES = [
  // /lots/:lotId/manifest
  { method: 'GET',  pattern: /^\/lots\/[^/]+\/manifest$/,  handler: fetchManifest },
  // /lots/:lotId/analyze
  { method: 'POST', pattern: /^\/lots\/[^/]+\/analyze$/,   handler: analyzeLot },
  // /lots/:lotId/refresh
  { method: 'POST', pattern: /^\/lots\/[^/]+\/refresh$/,   handler: refreshLot },
  // /lots/:lotId/image  (disk-cached proxy)
  { method: 'GET',  pattern: /^\/lots\/[^/]+\/image$/,     handler: imageProxy },
];

// ─── Cron dispatch ──────────────────────────────────────────────────────────
// Cloudflare's scheduled() handler is gone; src/runtime/scheduler.js drives
// these on node-cron timers instead. The task names and their semantics are
// unchanged.

export async function runCronTask(name, env, ctx, log) {
  const child = log?.child?.({ cron_name: name }) || log;
  child?.info?.('cron_start');
  const startedAt = Date.now();
  try {
    switch (name) {
      case 'analysis':
        await runAnalysisCron(env, ctx, child);
        break;
      case 'discovery':
        await runDiscoveryCron(env, ctx, child);
        break;
      case 'refresh':
        await runRefreshCron(env, ctx, child);
        break;
      case 'alerts':
        await runAlertsCron(env, ctx, child);
        break;
      case 'ebay-sync':
        await runEbaySyncCron(env, ctx, child);
        break;
      default:
        child?.warn?.('cron_unknown', { name });
        return { ok: false, error: `unknown cron task: ${name}` };
    }
  } catch (e) {
    child?.error?.('cron_threw', { message: e?.message, stack: e?.stack?.slice(0, 1000) });
    return { ok: false, error: e?.message || 'threw', ms: Date.now() - startedAt };
  }
  child?.info?.('cron_done', { ms: Date.now() - startedAt });
  return { ok: true, ms: Date.now() - startedAt };
}

// POST /run  { task: 'discovery' }  — manual trigger for debugging.
async function runCronRoute(request, env, ctx, log) {
  const traceId = log?.traceId || 'no-trace';
  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  const task = body?.task || new URL(request.url).searchParams.get('task');
  if (!task) return errors.badRequest(traceId, `missing 'task' (one of: ${CRON_TASKS.join(', ')})`);
  if (!CRON_TASKS.includes(task)) {
    return errors.badRequest(traceId, `unknown task '${task}' (expected one of: ${CRON_TASKS.join(', ')})`);
  }

  const result = await runCronTask(task, env, ctx, log);
  const { json } = await import('./lib/response.js');
  return json({ task, ...result, traceId }, result.ok ? 200 : 500);
}

// ─── Cron handlers ──────────────────────────────────────────────────────────
// Each handler loops through whatever work the corresponding HTTP route would
// process, invoking the route function directly (no fetch hop).

async function runAnalysisCron(env, ctx, log) {
  // Drain lot_analysis_queue rows whose status='pending', invoking the
  // analyze route handler for each.
  const { getSupabase } = await import('./services/supabase.js');
  const supabase = getSupabase(env);
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) { log?.warn?.('no_workspace_id'); return; }

  const lotsPerTick = Math.max(0, Number(env.ANALYSIS_LOTS_PER_TICK) || 0);
  let q = supabase
    .from('lot_analysis_queue')
    .select('lot_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .order('enqueued_at', { ascending: true });
  if (lotsPerTick > 0) q = q.limit(lotsPerTick);

  const { data: queue, error } = await q;
  if (error) { log?.error?.('queue_read_failed', { message: error.message }); return; }
  if (!queue || queue.length === 0) { log?.info?.('queue_empty'); return; }

  log?.info?.('queue_drain_start', { count: queue.length });

  // Mark all picked rows processing before scoring, so a concurrent tick
  // doesn't double-pick them.
  await supabase
    .from('lot_analysis_queue')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .in('lot_id', queue.map((r) => r.lot_id))
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending');

  let done = 0;
  let errored = 0;
  for (const row of queue) {
    const headers = env.SHARED_AUTH_SECRET
      ? { authorization: `Bearer ${env.SHARED_AUTH_SECRET}` }
      : {};
    const req = new Request(`http://internal/lots/${row.lot_id}/analyze`, {
      method: 'POST',
      headers,
    });
    try {
      const res = await analyzeLot(req, env, ctx, log);
      if (res.status >= 400) errored += 1;
      else done += 1;
    } catch (e) {
      errored += 1;
      log?.error?.('analyze_threw', { lotId: row.lot_id, message: e?.message });
    }
  }
  log?.info?.('queue_drain_done', { processed: queue.length, done, errored });
}

async function runDiscoveryCron(env, ctx, log) {
  const result = await discoveryCron(env, ctx, log);
  log?.info?.('discovery_result', { ok: result?.ok, enqueued: result?.enqueued, dismissed: result?.dismissed });
}

async function runRefreshCron(env, ctx, log) {
  const result = await refreshStaleLots(env, ctx, log);
  log?.info?.('refresh_result', { ok: result?.ok, refreshed: result?.refreshed, ended: result?.ended });
}

async function runAlertsCron(env, ctx, log) {
  const result = await runBidAlerts(env, ctx, log);
  log?.info?.('alerts_result', { ok: result?.ok, bidsChecked: result?.bidsChecked, alertsSent: result?.alertsSent });
}

async function runEbaySyncCron(env, ctx, log) {
  const result = await runEbaySync(env, ctx, log);
  log?.info?.('ebay_sync_result', { ok: result?.ok });
}

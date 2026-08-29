// NolTech sync agent — main entry point.
//
// Boot sequence:
//   1. Load + validate config (fails fast on missing env).
//   2. Init logger and supabase client.
//   3. Print startup banner.
//   4. Schedule cron jobs (heartbeat, listings, orders/finances).
//   5. Wire signal handlers + global error traps.
//
// The actual sync logic (eBay listings/orders/finances → Supabase) is built by
// a sibling agent. We expose `runListingsSync` / `runOrdersSync` placeholders
// here so the cron wiring is in place; the sibling will replace the bodies.

import cron from 'node-cron';
import config from './config.js';
import logger from './logger.js';
import supabase from './supabaseClient.js';
import {
  writeHeartbeat,
  markRunStarted,
  markRunComplete,
  markRunFailed,
  AGENT_VERSION,
} from './heartbeat.js';
import { syncListings } from './sync/listings.js';
import { syncOrders } from './sync/orders.js';
import { prewarmSoldComps } from './sync/sold-comps-warmer.js';
import { runManifestPricer } from './sync/manifest-pricer.js';
import { syncBrowseLots } from './sync/browse-lots.js';
import { runLotClosesCron } from './sync/lot-closes.js';

// ---------------------------------------------------------------------------
// Sync wrappers — bind shared deps (supabase client, workspace, pipeline URL,
// eBay creds, logger) once so the cron callbacks stay tiny.
// ---------------------------------------------------------------------------

const syncDeps = {
  supabase,
  workspaceId: config.workspaceId,
  pipelineUrl:  config.pipelineUrl,
  ebayCreds:   config.ebay,
  logger,
};

async function runListingsSync() {
  return syncListings(syncDeps);
}

async function runOrdersSync() {
  return syncOrders(syncDeps);
}

async function runSoldCompsWarmer() {
  return prewarmSoldComps({
    supabase,
    workspaceId: config.workspaceId,
    soldComps: config.soldComps,
    logger,
  });
}

async function runManifestPricerJob() {
  return runManifestPricer({
    pipelineUrl: config.pipelineUrl,
    logger,
    maxLotsPerRun: config.manifestPricer.maxLotsPerRun,
  });
}

async function runBrowseLotsRefresh() {
  return syncBrowseLots({
    supabase,
    workspaceId: config.workspaceId,
    pipelineUrl: config.pipelineUrl,
    logger,
  });
}

async function runLotClosesJob() {
  return runLotClosesCron({
    supabase,
    workspaceId: config.workspaceId,
    pipelineUrl: config.pipelineUrl,
    logger,
  });
}

// ---------------------------------------------------------------------------
// Cron wrappers — wrap each scheduled run with start/complete/fail heartbeats
// and a try/catch so a failure in one run doesn't kill the process.
// ---------------------------------------------------------------------------

// Per-cron mutex. node-cron has no built-in concurrency protection; if a
// run is still going when the next tick fires, both run in parallel and can
// duplicate work / race on shared resources (Lambda concurrency, IndexedDB
// writes, Bright Data cost). This map tracks which jobs are in-flight so we
// can skip a tick rather than overlap.
const _runningJobs = new Set();

async function safeRun(label, fn) {
  if (_runningJobs.has(label)) {
    logger.warn({ job: label }, 'Skipping cron tick — previous run still in progress');
    return;
  }
  _runningJobs.add(label);
  logger.info({ job: label }, 'Sync run starting');
  try {
    await markRunStarted();
    const summary = await fn();
    await markRunComplete({ job: label, ...summary, finishedAt: new Date().toISOString() });
    logger.info({ job: label, summary }, 'Sync run complete');
  } catch (err) {
    logger.error({ job: label, err: err.message, stack: err.stack }, 'Sync run failed');
    await markRunFailed(err).catch((hbErr) =>
      logger.error({ err: hbErr.message }, 'Failed to record run failure heartbeat'),
    );
  } finally {
    _runningJobs.delete(label);
  }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner() {
  const lines = [
    '────────────────────────────────────────────────────────────',
    ' NolTech Sync Agent',
    '────────────────────────────────────────────────────────────',
    ` agent_id     : ${config.heartbeat.agentId}`,
    ` hostname     : ${config.heartbeat.hostname}`,
    ` version      : ${AGENT_VERSION}`,
    ` workspace    : ${config.workspaceId}`,
    ` supabase     : ${config.supabaseUrl}`,
    ` pipeline     : ${config.pipelineUrl}`,
    ` log level    : ${config.logLevel}`,
    ` log dir      : ${config.logDir}`,
    ` cron:listings: ${config.cron.listings}`,
    ` cron:orders  : ${config.cron.orders}`,
    ` cron:heart   : ${config.cron.heartbeat}`,
    ` cron:scwarm  : ${config.cron.soldCompsWarmer}`,
    ` cron:pricer  : ${config.cron.manifestPricer}`,
    ` cron:lots    : ${config.cron.browseLotsRefresh}`,
    ` cron:closes  : ${config.cron.lotCloses}`,
    ` sold-comps   : ${config.soldComps.enabled ? 'enabled' : 'disabled (no lambda configured)'}`,
    ` pricer       : ${config.manifestPricer.disabled ? 'disabled (DISABLE_MANIFEST_PRICER=1)' : `enabled (max ${config.manifestPricer.maxLotsPerRun} lots/run)`}`,
    '────────────────────────────────────────────────────────────',
  ];
  for (const line of lines) logger.info(line);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  printBanner();

  // Touch supabase to surface obvious config issues at boot rather than at
  // the first cron tick. This is a no-op call that just proves the client
  // constructed cleanly.
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('Supabase client failed to initialize');
  }

  // Initial heartbeat so the dashboard flips to "online" immediately.
  await writeHeartbeat({ status: 'idle', summary: { event: 'boot' } }).catch((err) =>
    logger.warn({ err: err.message }, 'Initial heartbeat failed (will retry on cron tick)'),
  );

  // Heartbeat job — every minute by default.
  cron.schedule(config.cron.heartbeat, () => {
    writeHeartbeat({ status: 'idle' }).catch((err) =>
      logger.warn({ err: err.message }, 'Scheduled heartbeat failed'),
    );
  });

  // Listings sync — hourly by default.
  cron.schedule(config.cron.listings, () => {
    safeRun('listings', runListingsSync);
  });

  // Orders + finances sync — every 15 minutes by default.
  cron.schedule(config.cron.orders, () => {
    safeRun('orders+finances', runOrdersSync);
  });

  // Sold-comps cache pre-warmer — every 30 minutes by default. Only scheduled
  // if a Lambda URL + secret are configured; otherwise we log once at boot
  // and stay quiet so deployments without the feature don't see noise.
  if (config.soldComps.enabled) {
    cron.schedule(config.cron.soldCompsWarmer, () => {
      safeRun('sold-comps-warmer', runSoldCompsWarmer);
    });
    logger.info(
      { schedule: config.cron.soldCompsWarmer, prewarmLimit: config.soldComps.prewarmLimit },
      'Sold-comps pre-warmer scheduled',
    );
  } else {
    logger.info('Sold-comps pre-warmer disabled (SOLD_COMPS_LAMBDA_URL not set) — skipping schedule');
  }

  // Manifest pricer — every 2 hours by default. Triggers the pipeline to
  // re-fetch browse-lots and price each manifest via sold-comps so the lot
  // data on the Pi stays fresh without the desktop Hub being open. Skipped
  // entirely when DISABLE_MANIFEST_PRICER=1.
  if (config.manifestPricer.disabled) {
    logger.info('Manifest pricer disabled (DISABLE_MANIFEST_PRICER=1) — skipping schedule');
  } else {
    cron.schedule(config.cron.manifestPricer, () => {
      safeRun('manifest-pricer', runManifestPricerJob);
    });
    logger.info(
      {
        schedule: config.cron.manifestPricer,
        maxLotsPerRun: config.manifestPricer.maxLotsPerRun,
      },
      'Manifest pricer scheduled',
    );
  }

  // Browse-lots refresh — every N hours by default. Hits the pipeline
  // for fresh techliquidators / liquidation lots and upserts them into the
  // browse_lots Supabase table. The Hub subscribes to that table via
  // Realtime so newly-fetched lots appear without a manual Refresh.
  if (config.browseLotsRefresh.disabled) {
    logger.info('Browse-lots refresh disabled (DISABLE_BROWSE_LOTS_REFRESH=1) — skipping schedule');
  } else {
    cron.schedule(config.cron.browseLotsRefresh, () => {
      safeRun('browse-lots-refresh', runBrowseLotsRefresh);
    });
    logger.info(
      { schedule: config.cron.browseLotsRefresh },
      'Browse-lots refresh scheduled',
    );
  }

  // Lot closes — captures final winning bids for ended auctions and
  // auto-resolves user bids (won/lost). Disabled when DISABLE_LOT_CLOSES=1.
  if (config.lotCloses.disabled) {
    logger.info('Lot closes cron disabled (DISABLE_LOT_CLOSES=1) — skipping schedule');
  } else {
    cron.schedule(config.cron.lotCloses, () => {
      safeRun('lot-closes', runLotClosesJob);
    });
    logger.info(
      { schedule: config.cron.lotCloses },
      'Lot closes cron scheduled',
    );
  }

  logger.info('Cron jobs scheduled — agent is live');
}

// ---------------------------------------------------------------------------
// Signal + error handling
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received — writing final heartbeat');
  try {
    await writeHeartbeat({
      status: 'shutting-down',
      summary: { signal, at: new Date().toISOString() },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to write shutdown heartbeat');
  }
  // Give pino transports a moment to flush to disk.
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
  try {
    await writeHeartbeat({ status: 'error', lastError: `uncaughtException: ${err.message}` });
  } catch (_) {
    /* swallow — already crashing */
  }
  setTimeout(() => process.exit(1), 250);
});

process.on('unhandledRejection', async (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.fatal({ err: message }, 'Unhandled promise rejection');
  try {
    await writeHeartbeat({ status: 'error', lastError: `unhandledRejection: ${message}` });
  } catch (_) {
    /* swallow */
  }
  setTimeout(() => process.exit(1), 250);
});

// Top-level await would also work, but a .catch keeps Node 20 happy without
// requiring the file to be treated as a module entry-point only.
main().catch(async (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Boot failed');
  try {
    await writeHeartbeat({ status: 'error', lastError: `boot: ${err.message}` });
  } catch (_) {
    /* swallow */
  }
  setTimeout(() => process.exit(1), 250);
});

// Loads `.env` and exposes a frozen, validated `config` object to the rest of
// the agent. Importing this module has the side-effect of calling
// dotenv.config() exactly once — do it before anything else in src/index.js.

import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .env lives at the package root, one level above src/
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// Required vars — agent refuses to start if any are blank/missing.
const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'WORKSPACE_ID',
  'EBAY_USER_TOKEN',
  'EBAY_REFRESH_TOKEN',
  'EBAY_APP_ID',
  'EBAY_CERT_ID',
  'EBAY_DEV_ID',
];

const missing = REQUIRED.filter((key) => {
  const v = process.env[key];
  return v === undefined || v === null || String(v).trim() === '';
});

if (missing.length > 0) {
  // Use a plain Error rather than the logger — config has to load before logging.
  const list = missing.map((k) => `  - ${k}`).join('\n');
  throw new Error(
    `[sync-agent] Missing required environment variable(s):\n${list}\n` +
      `Copy .env.example to .env and fill in the blanks before starting the agent.`,
  );
}

const config = Object.freeze({
  // Supabase
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  workspaceId: process.env.WORKSPACE_ID,

  // eBay
  ebay: Object.freeze({
    userToken: process.env.EBAY_USER_TOKEN,
    refreshToken: process.env.EBAY_REFRESH_TOKEN,
    appId: process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    devId: process.env.EBAY_DEV_ID,
  }),

  // Local services
  pipelineUrl: process.env.PIPELINE_URL || 'http://localhost:3001',

  // Logging
  logDir: process.env.LOG_DIR || './logs',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Heartbeat identity
  heartbeat: Object.freeze({
    agentId: process.env.HEARTBEAT_AGENT_ID || 'pi-home',
    hostname: process.env.HEARTBEAT_HOSTNAME || os.hostname(),
  }),

  // Cron
  cron: Object.freeze({
    listings: process.env.CRON_LISTINGS || '0 * * * *',
    orders: process.env.CRON_ORDERS || '*/15 * * * *',
    heartbeat: process.env.CRON_HEARTBEAT || '* * * * *',
    soldCompsWarmer: process.env.CRON_SOLD_COMPS_WARMER || '*/30 * * * *',
    // Manifest pricer — every 2 hours, offset by 15 min so it doesn't collide
    // with the on-the-hour listings sync.
    manifestPricer: process.env.CRON_MANIFEST_PRICER || '15 */2 * * *',
    // Browse-lots refresh — every 2 hours at :30 so it offsets all the others
    // (heart on :00, pricer on :15, this on :30). Fresh enough to keep the
    // Hub showing recent auctions without burning through provider quota.
    browseLotsRefresh: process.env.CRON_BROWSE_LOTS_REFRESH || '30 */2 * * *',
    // Lot closes — every 30 min. Auctions mostly end at predictable times
    // (top of hour for TL), so a 30-min cron catches each within ~30 min
    // of settling. Cheap operation: only checks lots not already captured.
    lotCloses: process.env.CRON_LOT_CLOSES || '*/30 * * * *',
  }),

  // Sold-comps pre-warmer (optional). When the lambda URL + secret are unset,
  // `enabled` is false and the warmer cron job is never scheduled.
  soldComps: Object.freeze({
    lambdaUrl: process.env.SOLD_COMPS_LAMBDA_URL || null,
    authSecret: process.env.SOLD_COMPS_AUTH_SECRET || null,
    prewarmLimit: parseInt(process.env.SOLD_COMPS_PREWARM_LIMIT, 10) || 20,
    enabled: !!(process.env.SOLD_COMPS_LAMBDA_URL && process.env.SOLD_COMPS_AUTH_SECRET),
  }),

  // Manifest pricer — periodically asks the pipeline to refresh + price
  // browse-lots. Disabled when DISABLE_MANIFEST_PRICER=1.
  // Default cap: 9999 (effectively unlimited). The mutex in index.js prevents
  // overlapping runs, so a long pricing pass is safe — it just blocks the
  // next tick, which then resumes whatever's left after the previous finishes.
  // Most lots after the first run are cache hits and finish in seconds.
  manifestPricer: Object.freeze({
    maxLotsPerRun: parseInt(process.env.MANIFEST_PRICER_MAX_LOTS_PER_RUN, 10) || 9999,
    disabled: process.env.DISABLE_MANIFEST_PRICER === '1',
  }),

  // Browse-lots refresh — periodically scrapes lots from techliquidators /
  // liquidation.com and upserts to the Supabase browse_lots table. The Hub
  // subscribes to that table via Realtime. Disabled when
  // DISABLE_BROWSE_LOTS_REFRESH=1.
  browseLotsRefresh: Object.freeze({
    disabled: process.env.DISABLE_BROWSE_LOTS_REFRESH === '1',
  }),

  // Lot closes — captures final winning bids for ended auctions and
  // auto-resolves user bids. Disabled when DISABLE_LOT_CLOSES=1.
  lotCloses: Object.freeze({
    disabled: process.env.DISABLE_LOT_CLOSES === '1',
  }),
});

export default config;
export { config };

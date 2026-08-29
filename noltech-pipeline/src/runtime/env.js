// ─── Env builder ─────────────────────────────────────────────────────────────
// Cloudflare synthesized the `env` object from wrangler.toml [vars], secrets,
// and bindings, then threaded it through every handler. This rebuilds the same
// object shape from a .env file plus local disk-backed bindings, so no route or
// service needs to know it is no longer running on a Worker.
//
// The defaults below are lifted verbatim from the old wrangler.toml [vars]
// block — that file is gone, so this is now the single source of truth for
// pipeline tuning knobs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKvStore } from './kv.js';
import { createR2Bucket } from './r2.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PIPELINE_ROOT = path.resolve(HERE, '..', '..');

// Non-secret tuning defaults (formerly wrangler.toml [vars]).
const DEFAULTS = {
  PUBLIC_BASE_URL:              'http://localhost:3001',

  // Sold-comps pricing
  SOLD_COMPS_DAYS:              '90',
  SOLD_COMPS_MAX_RESULTS:       '60',
  SOLD_COMPS_EMPTY_TTL_HRS:     '6',
  SOLD_COMPS_FULL_TTL_DAYS:     '14',

  // Per-lot analysis
  ANALYSIS_PER_LOT_CONCURRENCY: '20',
  ANALYSIS_MAX_PRICED_ITEMS:    '40',
  ANALYSIS_LOTS_PER_TICK:       '0',
  ANALYSIS_DAILY_COST_CAP_USD:  '0',

  // Discovery
  DISCOVERY_MAX_LOTS_PER_TICK:  '30',
  DISCOVERY_BID_CEILING_RATIO:  '0.8',

  // Data providers — see src/providers/ and docs/DATA-SOURCES.md.
  // 'sample' generates plausible data offline so a fresh clone runs; it tells
  // you nothing true about the market. Point these at a real source before
  // trusting any number the pipeline produces.
  LOT_PROVIDER:                 'sample',
  COMPS_PROVIDER:               'sample',
  LOT_SOURCES:                  'sample',

  // Cache TTLs (seconds)
  CACHE_TTL_SEARCH:             '600',
  CACHE_TTL_MANIFEST:           '86400',
  CACHE_TTL_IMAGE:              '604800',

  CRON_LOG_LEVEL:               'info',
};

// Nothing is hard-required. The service is useful in degraded configurations —
// the sample providers mean it boots and serves lots with no credentials at
// all — so instead of refusing to start we warn about exactly which features
// are dark. Each entry: the capability, the vars it needs, and what breaks.
const CAPABILITIES = [
  {
    feature: 'discovery / analysis / refresh / alerts crons',
    vars:    ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'WORKSPACE_ID'],
    impact:  'background jobs error out; HTTP lot routes still work',
  },
  {
    feature: 'eBay pricing (COMPS_PROVIDER=ebay-browse) and order sync',
    vars:    ['EBAY_APP_ID', 'EBAY_CERT_ID', 'EBAY_REFRESH_TOKEN'],
    impact:  'manifests fall back to MSRP estimates; ebay-sync cron fails',
  },
  {
    feature: 'AI desktop part-out',
    vars:    ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY'],
    impact:  'part-out estimates unavailable',
    anyOf:   true,   // either key is sufficient
  },
];

export function buildEnv(overrides = {}) {
  const dataDir = process.env.PIPELINE_DATA_DIR
    ? path.resolve(process.env.PIPELINE_DATA_DIR)
    : path.join(PIPELINE_ROOT, '.data');

  const env = { ...DEFAULTS };

  // process.env wins over defaults, but only when non-empty — an unset var in
  // a .env file shows up as '' and should fall back rather than blank out a
  // tuning default.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && v.trim() !== '') env[k] = v;
  }
  Object.assign(env, overrides);

  // Bindings. PIPELINE_CACHE and SCRAPER_CACHE were two separate KV namespaces
  // in the original design but always held disjoint key prefixes
  // (liq:/tl:/upc:), and routes/admin.js already treats them as interchangeable
  // via `env.PIPELINE_CACHE || env.SCRAPER_CACHE`. One store backs both here.
  const kv = createKvStore(path.join(dataDir, 'kv'));
  env.PIPELINE_CACHE = kv;
  env.SCRAPER_CACHE  = kv;
  env.IMAGE_CACHE    = createR2Bucket(path.join(dataDir, 'images'));

  env.DATA_DIR = dataDir;
  return env;
}

// Returns one entry per capability that can't work with the current config,
// so the caller can print them all at once at boot instead of the operator
// discovering them one failed cron at a time.
export function describeEnvGaps(env) {
  const isSet = (k) => Boolean(env[k]) && String(env[k]).trim() !== '';
  const gaps = [];

  for (const cap of CAPABILITIES) {
    const missing = cap.vars.filter((k) => !isSet(k));
    // anyOf capabilities only count as missing when *every* alternative is unset.
    const broken = cap.anyOf ? missing.length === cap.vars.length : missing.length > 0;
    if (broken) gaps.push({ feature: cap.feature, missing, impact: cap.impact });
  }

  return gaps;
}

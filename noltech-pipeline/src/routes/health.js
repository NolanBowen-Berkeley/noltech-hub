// GET /health — public route, no auth. The Hub's SystemHealthCard polls this.

import { ok } from '../lib/response.js';
import { CRON_TASKS, getCronStatus } from '../runtime/cronRegistry.js';
import { getLotProvider, getCompsProvider, describeProvider } from '../providers/index.js';

const STARTED_AT = Date.now();

export async function health(_request, env, _ctx, log) {
  // Provider resolution can fail (a bad name, a custom module that won't
  // import). /health must still answer in that case — a monitoring endpoint
  // that goes down with the thing it monitors is useless — so the error is
  // reported as data.
  let lotProvider, compsProvider;
  try { lotProvider   = describeProvider(await getLotProvider(env)); }
  catch (e) { lotProvider   = { error: e?.message || 'unavailable' }; }
  try { compsProvider = describeProvider(await getCompsProvider(env)); }
  catch (e) { compsProvider = { error: e?.message || 'unavailable' }; }

  return ok({
    service:                'noltech-pipeline',
    version:                '1.0.0',
    mode:                   'local',
    uptimeSeconds:          Math.round((Date.now() - STARTED_AT) / 1000),
    pid:                    process.pid,
    node:                   process.version,

    // Where lots and prices come from. `usingSampleData` is the one to watch:
    // true means every number this service returns is generated, not real.
    lotProvider,
    compsProvider,
    usingSampleData:        lotProvider?.id === 'sample' || compsProvider?.id === 'sample',

    supabaseConfigured:     Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY),
    geminiConfigured:       Boolean(env.GEMINI_API_KEY),
    ebayConfigured:         Boolean(env.EBAY_APP_ID && env.EBAY_CERT_ID && env.EBAY_REFRESH_TOKEN),
    workspaceConfigured:    Boolean(env.WORKSPACE_ID),
    authRequired:           Boolean(env.SHARED_AUTH_SECRET),

    // Disk-backed replacements for the old KV namespace and R2 bucket.
    cacheConfigured:        Boolean(env.PIPELINE_CACHE),
    imageBucketConfigured:  Boolean(env.IMAGE_CACHE),
    dataDir:                env.DATA_DIR || null,

    cronsScheduled:         CRON_TASKS,
    crons:                  getCronStatus(),
  }, log?.traceId);
}

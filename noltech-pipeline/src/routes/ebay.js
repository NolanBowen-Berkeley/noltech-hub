// ─── eBay sync route + cron driver ──────────────────────────────────────────
// Pulls eBay orders + finances. Verbatim port of ebay-sync-worker
// (services/ebay/*.js) — those 7 files are self-contained and Worker-
// compatible. This module is the thin HTTP route + cron wrapper.

import { ok, errors } from '../lib/response.js';
import { getSupabase } from '../services/supabase.js';
import { runSync } from '../services/ebay/pipeline.js';

// HTTP — POST /ebay/sync — manual trigger
export async function ebaySyncRoute(_request, env, _ctx, log) {
  const traceId = log?.baseFields?.traceId;
  if (!env.WORKSPACE_ID) return errors.badRequest(traceId, 'WORKSPACE_ID missing');

  log = log.child({ route: 'ebay.sync' });
  log.info('start');

  const supabase = getSupabase(env);
  try {
    const result = await runSync({ env, supabase });
    log.info('done', { result });
    return ok(result, traceId);
  } catch (e) {
    log.error('threw', { message: e?.message });
    return errors.upstream(traceId, e?.message || 'ebay sync failed');
  }
}

// Cron driver — identical body, just called from scheduled()
export async function runEbaySync(env, _ctx, log) {
  if (!env.WORKSPACE_ID) { log.warn('no_workspace_id'); return { ok: false }; }
  const supabase = getSupabase(env);
  try {
    return await runSync({ env, supabase });
  } catch (e) {
    log.error('cron_threw', { message: e?.message });
    return { ok: false, error: e?.message };
  }
}

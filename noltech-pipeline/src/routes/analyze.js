// ─── POST /lots/:lotId/analyze ─────────────────────────────────────────────
// Score a single lot end-to-end. Reads its manifest from
// liquidation_manifests, runs the analyzeLot pipeline (sold-comps lookups,
// part-out, scenarios, recommendation, red flags), upserts the result to
// lot_analyses, marks the queue row done.
//
// Called by:
//   - Hub UI (when user clicks "Deep Analyze" on a lot card)
//   - The analysis cron (drains lot_analysis_queue every 5 min)
//
// Both paths share this single handler, so cron and HTTP can't diverge.

import { matchPath } from '../lib/path.js';
import { ok, errors } from '../lib/response.js';
import { getSupabase, mustOk, mustReturnRow } from '../services/supabase.js';
import { analyzeLot } from '../shared/scoring.js';

export async function analyzeLotRoute(request, env, ctx, log) {
  const traceId = log?.baseFields?.traceId;
  const url = new URL(request.url);

  const lotIdMatch = matchPath(url, /^\/lots\/([^/]+)\/analyze$/);
  if (!lotIdMatch) return errors.badRequest(traceId, 'invalid path');
  const lotId = lotIdMatch[1];

  log = log.child({ route: 'analyze.lot', lotId });

  const supabase = getSupabase(env);
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) return errors.badRequest(traceId, 'WORKSPACE_ID env missing');

  // Synthesize a queue row shape so analyzeLot can be invoked uniformly
  // whether the trigger was HTTP or cron.
  const queueRow = { lot_id: lotId };

  // External cost tracker — survives a throw inside analyzeLot so we can
  // still account for partial Bright Data spend.
  const costTracker = { usd: 0, calls: 0, claudeCalls: 0 };

  let analysis;
  try {
    analysis = await analyzeLot({
      env, ctx, log, supabase, workspaceId, queueRow,
      externalCostTracker: costTracker,
    });
  } catch (e) {
    log.error('analyze_failed', {
      message: e?.message,
      orphanedSpend: costTracker.usd,
      orphanedCalls: costTracker.calls,
    });
    // Persist whatever cost we incurred so the daily meter stays truthful.
    await persistRunCost(supabase, env, workspaceId, costTracker.usd, 0, log).catch(() => {});
    return errors.upstream(traceId, e?.message || 'analyze failed');
  }

  // Upsert the analysis row (verified — throws on either Postgres error
  // OR no-row-returned).
  try {
    await mustReturnRow('lot_analyses upsert', supabase
      .from('lot_analyses')
      .upsert({
        workspace_id: workspaceId,
        lot_id:       lotId,
        scored_at:    new Date().toISOString(),
        ...analysis,
      }, { onConflict: 'workspace_id,lot_id' }));
  } catch (e) {
    log.error('upsert_failed', { message: e?.message });
    await persistRunCost(supabase, env, workspaceId, costTracker.usd, 0, log).catch(() => {});
    return errors.upstream(traceId, `lot_analyses upsert failed: ${e?.message}`);
  }

  // Mark queue row done (best-effort — if the row doesn't exist that's
  // fine, this was an HTTP-triggered analyze).
  await supabase
    .from('lot_analysis_queue')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('lot_id', lotId)
    .neq('status', 'done');

  // Update daily meter.
  await persistRunCost(supabase, env, workspaceId, costTracker.usd, 1, log).catch((e) => {
    log.warn('cost_meter_update_failed', { message: e?.message });
  });

  log.info('analyze_done', {
    recommendation: analysis.recommendation,
    marginPct:      analysis.scenarios?.[analysis.recommendation]?.margin_pct,
    soldcompsCalls: analysis.soldcomps_calls,
    cost:           analysis.total_cost_to_score_usd,
  });

  return ok({
    lotId,
    recommendation: analysis.recommendation,
    scenarios:      analysis.scenarios,
    itemsTotal:     analysis.items_total,
    itemsPricedLive: analysis.items_priced_live,
    itemsEstimated: analysis.items_estimated,
    redFlags:       analysis.red_flags,
    costUsd:        analysis.total_cost_to_score_usd,
  }, traceId);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function persistRunCost(supabase, env, workspaceId, addUsd, addLotsAnalyzed, log) {
  if (!(addUsd > 0)) return;
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('analysis_costs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('date', today)
    .maybeSingle();

  const newTotalUsd      = Number(existing?.total_usd      || 0) + Number(addUsd);
  const newLotsAnalyzed  = Number(existing?.lots_analyzed  || 0) + addLotsAnalyzed;

  await mustOk('analysis_costs upsert', supabase
    .from('analysis_costs')
    .upsert({
      workspace_id: workspaceId,
      date:         today,
      total_usd:    newTotalUsd,
      lots_analyzed: newLotsAnalyzed,
      last_updated: new Date().toISOString(),
    }, { onConflict: 'workspace_id,date' }));
}

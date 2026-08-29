// ─── POST /lots/:lotId/refresh + cron driver ───────────────────────────────
// Re-reads a lot's current_bid + ends_at so auto-analyze always reads
// fresh state. The HTTP route updates one lot; the cron handler picks the
// staleest N active lots and calls the same logic for each.

import { matchPath } from '../lib/path.js';
import { ok, errors } from '../lib/response.js';
import { getSupabase, mustOk } from '../services/supabase.js';
import { getLotState } from '../services/lotState.js';

// HTTP route — refresh ONE lot by id
export async function refreshLotRoute(request, env, ctx, log) {
  const traceId = log?.baseFields?.traceId;
  const url = new URL(request.url);
  const lotIdMatch = matchPath(url, /^\/lots\/([^/]+)\/refresh$/);
  if (!lotIdMatch) return errors.badRequest(traceId, 'invalid path');
  const lotId = lotIdMatch[1];

  const supabase = getSupabase(env);
  const workspaceId = env.WORKSPACE_ID;

  const { data: lot, error: readErr } = await supabase
    .from('liquidation_lots_newegg')
    .select('id, lot_id, url, current_bid, ends_at, scraped_at')
    .eq('workspace_id', workspaceId)
    .eq('lot_id', lotId)
    .maybeSingle();
  if (readErr) return errors.upstream(traceId, `read failed: ${readErr.message}`);
  if (!lot)     return errors.badRequest(traceId, `lot not found: ${lotId}`);
  if (!lot.url) return errors.badRequest(traceId, 'lot has no url');

  log = log.child({ route: 'refresh.lot', lotId });
  log.info('start');

  const result = await refreshOne(supabase, lot, env, log);
  return ok(result, traceId);
}

// Cron driver — refresh the staleest N active lots
export async function refreshStaleLots(env, ctx, log) {
  const supabase = getSupabase(env);
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) { log.warn('no_workspace_id'); return { ok: false, error: 'no_workspace_id' }; }

  const lotsPerRun  = Math.max(1, Math.min(50, Number(env.REFRESH_LOTS_PER_RUN) || Number(env.LOTS_PER_RUN) || 10));
  const staleMs     = (Number(env.REFRESH_STALE_AFTER_MIN) || Number(env.STALE_AFTER_MIN) || 20) * 60 * 1000;
  const staleCutoff = new Date(Date.now() - staleMs).toISOString();
  const nowIso      = new Date().toISOString();

  const { data: lots, error: readErr } = await supabase
    .from('liquidation_lots_newegg')
    .select('id, lot_id, url, current_bid, ends_at, scraped_at')
    .eq('workspace_id', workspaceId)
    .gt('ends_at', nowIso)
    .lt('scraped_at', staleCutoff)
    .order('ends_at', { ascending: true })
    .limit(lotsPerRun);

  if (readErr)                    { log.error('queue_read_failed', { message: readErr.message }); return { ok: false }; }
  if (!lots || lots.length === 0) { log.info('queue_empty'); return { ok: true, status: 'idle', refreshed: 0 }; }

  log.info('refresh_start', { count: lots.length });

  const results = [];
  for (const lot of lots) {
    results.push(await refreshOne(supabase, lot, env, log));
  }
  const refreshed = results.filter((r) => r.status === 'refreshed').length;
  const ended     = results.filter((r) => r.status === 'ended').length;
  const failed    = results.filter((r) => r.status?.includes('failed')).length;
  log.info('refresh_done', { refreshed, ended, failed });
  return { ok: true, status: 'completed', refreshed, ended, failed, results };
}

async function refreshOne(supabase, lot, env, log) {
  const nowIso = new Date().toISOString();
  const state  = await getLotState(lot.url, env, { lotId: lot.lot_id, log });

  if (!state.ok) {
    // Bump scraped_at so we don't pick this same lot again immediately.
    await supabase
      .from('liquidation_lots_newegg')
      .update({ scraped_at: nowIso })
      .eq('id', lot.id);
    return { lotId: lot.lot_id, status: 'state_failed', error: state.error };
  }

  const update = { scraped_at: nowIso };
  if (Number.isFinite(state.currentPrice)) update.current_bid = state.currentPrice;
  if (state.endsAt)                        update.ends_at     = state.endsAt;
  if (state.ended)                         update.ends_at     = nowIso;

  try {
    await mustOk('liquidation_lots_newegg refresh', supabase
      .from('liquidation_lots_newegg')
      .update(update)
      .eq('id', lot.id));
  } catch (e) {
    return { lotId: lot.lot_id, status: 'update_failed', error: e?.message };
  }

  return {
    lotId: lot.lot_id,
    status: state.ended ? 'ended' : 'refreshed',
    from:  { currentBid: lot.current_bid, endsAt: lot.ends_at },
    to:    { currentBid: update.current_bid ?? lot.current_bid, endsAt: update.ends_at ?? lot.ends_at },
  };
}

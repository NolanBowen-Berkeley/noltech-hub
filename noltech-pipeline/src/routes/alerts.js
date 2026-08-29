// ─── Bid alerts (cron-only) ─────────────────────────────────────────────────
// Every 5 min, scan the user's active bids and fire phone alerts when:
//   - the lot is in its final ALERT_WINDOW_MIN window (preset-dependent)
//   - the current asking is at-or-below bid_ceiling (preset-dependent)
//   - we haven't alerted on this bid within REALERT_COOLDOWN_MIN
//
// Per-bid alert presets:
//   - 'muted'      — skip entirely
//   - 'early'      — 60 min window, ceiling-gated
//   - 'last_call'  — 10 min window, ceiling-gated
//   - 'any_price'  — default window, NOT ceiling-gated
//   - 'standard'   — default window, ceiling-gated (default)
//
// No HTTP route — purely cron-driven. The Hub doesn't need to poke this
// since the cron fires every 5 min.

import { getSupabase } from '../services/supabase.js';
import { getLotState } from '../services/lotState.js';
import { sendPhoneAlert } from '../services/phoneAlert.js';

function resolveAlertRule(preset, envWindowMin) {
  const fallbackWindow = Number(envWindowMin) || 30;
  switch (preset) {
    case 'muted':     return { skip: true };
    case 'early':     return { windowMin: 60,             requireUnderCeiling: true };
    case 'last_call': return { windowMin: 10,             requireUnderCeiling: true };
    case 'any_price': return { windowMin: fallbackWindow, requireUnderCeiling: false };
    case 'standard':
    default:          return { windowMin: fallbackWindow, requireUnderCeiling: true };
  }
}

export async function runBidAlerts(env, ctx, log) {
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) { log.warn('no_workspace_id'); return { ok: false, error: 'no_workspace_id' }; }

  const supabase = getSupabase(env);

  // 1. Phone webhook
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('phone_webhook_url')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const webhookUrl = prefs?.phone_webhook_url || null;
  if (!webhookUrl) { log.info('no_webhook_configured'); return { ok: true, status: 'no_webhook_configured' }; }

  // 2. Active bids
  const { data: bids, error: bidsErr } = await supabase
    .from('bids')
    .select('id, lot_id, source, lot_url, lot_title, bid_ceiling, status, alert_conditions')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');
  if (bidsErr) { log.error('bids_read_failed', { message: bidsErr.message }); return { ok: false, error: bidsErr.message }; }
  if (!bids || bids.length === 0) { log.info('no_active_bids'); return { ok: true, status: 'no_active_bids' }; }

  // 3. Recent sent-alerts (cooldown dedup)
  const cooldownMs = (Number(env.REALERT_COOLDOWN_MIN) || 20) * 60 * 1000;
  const cooldownCutoff = new Date(Date.now() - cooldownMs).toISOString();
  const { data: recentSent } = await supabase
    .from('bid_alerts_sent')
    .select('bid_id, sent_at')
    .eq('workspace_id', workspaceId)
    .gte('sent_at', cooldownCutoff);
  const recentlyAlerted = new Set((recentSent || []).map((r) => r.bid_id));

  // 4. Lot image lookup (Liquidation.com only — TechLiquidators bids never
  // appear in this table and gracefully degrade to no thumbnail). Single
  // batch query avoids N+1; results stay in-memory for the concurrency loop.
  const liqLotIds = bids
    .filter((b) => /liquidation/i.test(b.source || '') && b.lot_id)
    .map((b) => b.lot_id);
  const imageByLotId = new Map();
  if (liqLotIds.length > 0) {
    const { data: lotRows } = await supabase
      .from('liquidation_lots_newegg')
      .select('lot_id, image_url')
      .eq('workspace_id', workspaceId)
      .in('lot_id', liqLotIds);
    for (const row of lotRows || []) {
      if (row.image_url) imageByLotId.set(row.lot_id, row.image_url);
    }
  }
  // Base for the proxied image links in alert bodies. Must be reachable by
  // whatever renders the alert — a localhost default only works for
  // notifications shown on this same machine.
  const publicBase = (env.PUBLIC_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

  const concurrency = Math.max(1, Math.min(50, Number(env.ALERTS_CONCURRENCY) || Number(env.CONCURRENCY) || 10));

  log.info('alerts_start', { activeBids: bids.length, cooldownCount: recentlyAlerted.size });

  async function processBid(bid) {
    const rule = resolveAlertRule(bid.alert_conditions, env.ALERT_WINDOW_MIN);
    if (rule.skip)                      return { bidId: bid.id, status: 'muted',         preset: bid.alert_conditions };
    if (recentlyAlerted.has(bid.id))    return { bidId: bid.id, status: 'in_cooldown' };
    if (!bid.lot_url)                   return { bidId: bid.id, status: 'no_url' };

    const state = await getLotState(bid.lot_url, env, { log });
    if (!state.ok)                      return { bidId: bid.id, status: 'state_failed', error: state.error };
    if (state.ended)                    return { bidId: bid.id, status: 'already_ended' };
    if (!state.endsAt)                  return { bidId: bid.id, status: 'no_endsAt' };

    const windowMs = rule.windowMin * 60 * 1000;
    const endTs    = Date.parse(state.endsAt);
    const msLeft   = endTs - Date.now();
    if (!Number.isFinite(msLeft) || msLeft <= 0 || msLeft > windowMs) {
      return { bidId: bid.id, status: 'outside_window', minutesLeft: Math.round(msLeft / 60000), preset: bid.alert_conditions };
    }

    const ceiling = Number(bid.bid_ceiling);
    const asking  = Number(state.currentPrice);
    if (rule.requireUnderCeiling && Number.isFinite(ceiling) && ceiling > 0 && Number.isFinite(asking) && asking > ceiling) {
      return { bidId: bid.id, status: 'over_ceiling', asking, ceiling, preset: bid.alert_conditions };
    }

    const minutesLeft = Math.max(1, Math.round(msLeft / 60000));

    // Map time-to-close → urgency tier. Drives Discord embed color,
    // ntfy priority, and whether @here gets attached.
    const urgency = minutesLeft <= 5  ? 'imminent'
                  : minutesLeft <= 15 ? 'soon'
                  : minutesLeft <= 60 ? 'early'
                  : 'neutral';

    // Build a proxied image URL for Liq.com lots — Discord can't fetch the
    // raw CDN URL (hotlink blocked). The /liquidation/image route is public
    // and R2-cached, so Discord's image crawler picks it up cleanly.
    const rawImage = imageByLotId.get(bid.lot_id) || null;
    const imageUrl = rawImage
      ? `${publicBase}/liquidation/image?url=${encodeURIComponent(rawImage)}`
      : null;

    const send = await sendPhoneAlert(webhookUrl, {
      title:       `Bid closing in ${minutesLeft}m`,
      lotTitle:    bid.lot_title || 'Lot',
      lotUrl:      bid.lot_url || null,
      lotId:       bid.lot_id || null,
      source:      bid.source || null,
      asking,
      ceiling,
      minutesLeft,
      urgency,
      imageUrl,
    });
    if (!send.ok) return { bidId: bid.id, status: 'webhook_failed', error: send.error };

    try {
      await supabase
        .from('bid_alerts_sent')
        .insert({
          workspace_id: workspaceId,
          bid_id:       bid.id,
          lot_id:       bid.lot_id,
          sent_at:      new Date().toISOString(),
          minutes_left: minutesLeft,
          asking, ceiling,
        });
    } catch (e) {
      log.warn('sent_row_insert_failed', { message: e?.message });
    }

    return { bidId: bid.id, status: 'alerted', minutesLeft, asking, ceiling };
  }

  // Process in concurrent chunks
  const results = [];
  for (let i = 0; i < bids.length; i += concurrency) {
    const chunk = bids.slice(i, i + concurrency);
    const chunkResults = await Promise.all(chunk.map(processBid));
    results.push(...chunkResults);
  }
  const alertsSent = results.filter((r) => r.status === 'alerted').length;
  log.info('alerts_done', { bidsChecked: bids.length, alertsSent });
  return { ok: true, status: 'completed', bidsChecked: bids.length, alertsSent, results };
}

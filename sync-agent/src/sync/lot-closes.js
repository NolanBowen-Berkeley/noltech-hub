// ─── Lot Closes Cron (sync-agent → Supabase) ────────────────────────────────
// Polls the pipeline for closing prices on auctions that have ended, then
// auto-resolves the user's bids (won/lost) based on bidCeiling vs. the
// closing price.
//
// Strategy:
//   1. Query browse_lots for rows where data.auction.endsAt is in the past
//      AND there is no matching lot_closes row yet.
//   2. For each lot (capped per run + throttled), POST it to the pipeline's
//      /api/lots/closing-price. Whether that source can actually be checked
//      is the pipeline provider's call, not ours.
//   3. Upsert into lot_closes.
//   4. After upsert, find any user `bids` rows for that lotId whose status
//      is still 'active' or 'pending' and update them:
//        - bidCeiling >= closing_price → status='won', wonPrice=closing_price
//        - bidCeiling <  closing_price → status='lost'
//        - closing_price is null (no_bids/pulled) → status='lost' (auction never sold)
//
// Returns `{ checked, captured, won, lost, errors }` for the heartbeat.

import { withPipelineAuth } from '../lib/pipelineAuth.js';

const PIPELINE_TIMEOUT_MS = 30000;
const THROTTLE_MS        = parseInt(process.env.LOT_CLOSES_THROTTLE_MS, 10) || 1500;
const MAX_LOTS_PER_RUN   = parseInt(process.env.LOT_CLOSES_MAX_PER_RUN, 10) || 50;
// Wait this long after auction end before checking close — gives the source
// site time to finalize the winning bid display.
const SETTLE_DELAY_MS    = 15 * 60 * 1000;  // 15 min

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pull closing-price request shape out of a browse_lots row. One endpoint for
// every source — the pipeline's lot provider resolves the lot.
const CLOSING_PRICE_ENDPOINT = '/api/lots/closing-price';

function buildCloseRequest(lot) {
  if (!lot || !lot.data) return null;
  const d = lot.data;
  const lotId  = lot.lot_id || d.lotId || null;
  const lotUrl = d.lotUrl || d.url || null;
  if (!lotId && !lotUrl) return null;
  return {
    kind: lot.source || d.source || 'unknown',
    endpoint: CLOSING_PRICE_ENDPOINT,
    body: { lotId, lotUrl },
  };
}

async function fetchClose(pipelineUrl, req, logger) {
  const url = `${pipelineUrl.replace(/\/$/, '')}${req.endpoint}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: withPipelineAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(PIPELINE_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      return { ok: false, error: data?.error || `HTTP ${res.status}` };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Normalize the pipeline's closing-price response into our schema.
function normalizeClose(req, data) {
  // Provider response shape: { finalBid, status, numBids, endsAt, ... }
  const closingPrice = data?.finalBid ?? data?.winningBid ?? data?.closingPrice ?? null;
  const numBids = data?.numBids ?? null;
  const endedAt = data?.endsAt || data?.endTime || null;
  let status = 'unknown';
  if (closingPrice && Number(closingPrice) > 0) status = 'sold';
  else if (data?.status === 'no_bids' || (numBids != null && numBids === 0)) status = 'no_bids';
  else if (data?.status === 'pulled' || data?.status === 'cancelled') status = 'pulled';
  return {
    closing_price: closingPrice ? Number(closingPrice) : null,
    closing_status: status,
    num_bids: numBids != null ? Number(numBids) : null,
    ended_at: endedAt || new Date().toISOString(),
    raw: data || {},
  };
}

// Find user bids on this lot, mark won/lost based on bidCeiling vs closing_price.
async function resolveBidsForLot({ supabase, workspaceId, lotId, closingPrice, logger }) {
  const { data: bids, error } = await supabase
    .from('bids')
    .select('id, bid_ceiling, bid_amount, status')
    .eq('workspace_id', workspaceId)
    .eq('lot_id', lotId)
    .in('status', ['active', 'pending']);

  if (error) {
    logger?.warn({ err: error.message, lotId }, 'lot-closes: bid lookup failed');
    return { won: 0, lost: 0 };
  }
  if (!bids?.length) return { won: 0, lost: 0 };

  let won = 0;
  let lost = 0;
  for (const b of bids) {
    const ceiling = parseFloat(b.bid_ceiling) || parseFloat(b.bid_amount) || 0;
    let newStatus, wonPrice = null;
    if (closingPrice == null) {
      newStatus = 'lost'; // auction had no winning bid
    } else if (ceiling >= closingPrice) {
      newStatus = 'won';
      wonPrice = closingPrice;
      won++;
    } else {
      newStatus = 'lost';
      lost++;
    }
    const { error: upErr } = await supabase
      .from('bids')
      .update({
        status: newStatus,
        won_price: wonPrice,
        updated_at: new Date().toISOString(),
      })
      .eq('id', b.id)
      .eq('workspace_id', workspaceId);
    if (upErr) {
      logger?.warn({ err: upErr.message, bidId: b.id }, 'lot-closes: bid update failed');
    }
  }
  return { won, lost };
}

export async function runLotClosesCron({ supabase, workspaceId, pipelineUrl, logger }) {
  const now = new Date();
  const settleCutoffIso = new Date(now.getTime() - SETTLE_DELAY_MS).toISOString();

  // 1. Find ended browse_lots that don't have a close yet.
  //    We use a left-anti-join via two queries: pull recent ended lots,
  //    then filter out those already in lot_closes.
  const { data: endedLots, error: selErr } = await supabase
    .from('browse_lots')
    .select('id, source, data, scraped_at')
    .eq('workspace_id', workspaceId);
  if (selErr) {
    throw new Error(`browse_lots select failed: ${selErr.message}`);
  }

  const candidates = (endedLots || []).filter((l) => {
    const endsAt = l.data?.auction?.endsAt || l.data?.endsAt;
    if (!endsAt) return false;
    return new Date(endsAt).getTime() < new Date(settleCutoffIso).getTime();
  });

  if (!candidates.length) {
    logger?.info('lot-closes: no ended lots awaiting capture');
    return { checked: 0, captured: 0, won: 0, lost: 0, errors: 0 };
  }

  const candidateIds = candidates.map((l) => l.id);
  const { data: existing, error: exErr } = await supabase
    .from('lot_closes')
    .select('id, closing_status, detected_at')
    .eq('workspace_id', workspaceId)
    .in('id', candidateIds);
  if (exErr) {
    logger?.warn({ err: exErr.message }, 'lot-closes: existing-closes lookup failed');
  }

  // Skip rows that are already conclusively captured (sold / no_bids / pulled).
  // Retry 'unknown' rows for up to 24h after detection — TL sometimes posts the
  // final price hours after the auction ends, or our parser may need updating.
  const RETRY_UNKNOWN_MS = 24 * 60 * 60 * 1000;
  const retryCutoff = Date.now() - RETRY_UNKNOWN_MS;
  const skipIds = new Set(
    (existing || [])
      .filter((r) => {
        if (r.closing_status === 'unknown') {
          const detectedMs = r.detected_at ? new Date(r.detected_at).getTime() : 0;
          return detectedMs < retryCutoff; // gave up — too old
        }
        return true; // conclusive close, don't retry
      })
      .map((r) => r.id),
  );
  const toCheck = candidates.filter((l) => !skipIds.has(l.id)).slice(0, MAX_LOTS_PER_RUN);

  if (!toCheck.length) {
    logger?.info({ candidatesEnded: candidates.length }, 'lot-closes: all ended lots already captured');
    return { checked: candidates.length, captured: 0, won: 0, lost: 0, errors: 0 };
  }

  logger?.info({ toCheck: toCheck.length, totalEnded: candidates.length }, 'lot-closes: starting');

  let captured = 0;
  let won = 0;
  let lost = 0;
  let errors = 0;

  for (const lot of toCheck) {
    const req = buildCloseRequest(lot);
    if (!req) {
      logger?.warn({ lotId: lot.id, source: lot.source }, 'lot-closes: skip — no close endpoint');
      continue;
    }

    const result = await fetchClose(pipelineUrl, req, logger);
    if (!result.ok) {
      errors++;
      logger?.warn({ lotId: lot.id, err: result.error }, 'lot-closes: fetch failed');
      await sleep(THROTTLE_MS);
      continue;
    }

    const norm = normalizeClose(req, result.data);
    const { error: upErr } = await supabase
      .from('lot_closes')
      .upsert({
        id: lot.id,
        workspace_id: workspaceId,
        source: lot.source,
        ...norm,
      }, { onConflict: 'workspace_id,id' });

    if (upErr) {
      errors++;
      logger?.warn({ lotId: lot.id, err: upErr.message }, 'lot-closes: upsert failed');
    } else {
      captured++;
      // Resolve any user bids on this lot now that we know the outcome.
      const resolved = await resolveBidsForLot({
        supabase, workspaceId, lotId: lot.id,
        closingPrice: norm.closing_price,
        logger,
      });
      won += resolved.won;
      lost += resolved.lost;
      if (resolved.won > 0 || resolved.lost > 0) {
        logger?.info({
          lotId: lot.id,
          closingPrice: norm.closing_price,
          won: resolved.won,
          lost: resolved.lost,
        }, 'lot-closes: bid resolved');
      }
    }

    await sleep(THROTTLE_MS);
  }

  const summary = { checked: toCheck.length, captured, won, lost, errors };
  logger?.info(summary, 'lot-closes: run complete');
  return summary;
}

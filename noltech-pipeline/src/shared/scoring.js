// ─── Lot scoring pipeline ───────────────────────────────────────────────────
// Port of auto-analyze-worker/src/pipeline.js. Reads a lot's manifest from
// `liquidation_manifests`, prices each item via sold-comps, aggregates into
// a single resell-whole-lot scenario + red flags, returns the row that
// callers persist to `lot_analyses`.
//
// Single important deviation from the source pipeline.js:
//   - callSoldComps() now invokes the in-Worker /comps/lookup route via
//     a direct function call (NOT a fetch hop). This eliminates:
//       (a) the AWS Lambda dependency entirely
//       (b) the bearer-token round-trip cost
//       (c) one of the 6 ways IP-block emails could be triggered
//     The compsLookup() route in routes/comps.js is identical to the old
//     Lambda's handler; we just call it directly with a synthetic Request
//     so all the auth + cache + Bright Data + parser logic flows through.

import { compsLookup } from '../routes/comps.js';

// ─── Tunable constants ────────────────────────────────────────────────────

const DEFAULT_PER_LOT_CONCURRENCY = 20;
const COST_PER_SOLDCOMPS_CALL_USD = 0.012;
const COST_PER_GEMINI_CALL_USD    = 0;        // free tier
const EBAY_FEE_RATE               = 0.0935;
const REALIZATION_RATE            = 0.85;
const DEFAULT_MAX_PRICED_ITEMS    = 40;
const PARSER_VERSION              = 'v4-2026-05';

const SHIPPING_ESTIMATES = {
  gpu: 12, cpu: 6, ram: 5, desktop: 18, storage: 6, motherboard: 12,
  psu: 10, monitor: 22, keyboard: 7, mouse: 5, laptop: 15, other: 8,
};
const ESTIMATE_MULTIPLIER = { working: 0.50, for_parts: 0.25, unknown: 0.40 };

// ─── Concurrency limiter ──────────────────────────────────────────────────

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const n = Math.min(limit, items.length);
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) {
        // Per-item failures don't poison the whole lot — record null and
        // continue. The caller filters nulls out before aggregation.
        out[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Sold-comps lookup via in-Worker /comps/lookup ────────────────────────
// Invokes the compsLookup() route handler directly with a synthetic Request.
// Same code path the Hub hits over HTTP — no external network hop, no
// bearer-token round-trip, no extra latency.

async function callSoldComps(env, ctx, log, { query, category, condition, soldDays, workspaceId }) {
  const req = new Request('https://internal/comps/lookup', {
    method: 'POST',
    headers: {
      'content-type':  'application/json',
      authorization:   `Bearer ${env.SHARED_AUTH_SECRET || ''}`,
    },
    body: JSON.stringify({
      workspaceId,
      query,
      category,
      condition,
      soldDays: soldDays || Number(env.SOLD_COMPS_DAYS) || 90,
      requestedBy: 'pipeline.scoring',
    }),
  });
  const res = await compsLookup(req, env, ctx, log);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    return { ok: false, error: body?.error || `HTTP ${res.status}` };
  }
  return {
    ok:             true,
    count:          body.count || 0,
    rawCount:       body.rawCount || 0,
    medianPrice:    body.medianPrice,
    avgPrice:       body.avgPrice,
    rawAvgPrice:    body.rawAvgPrice,
    lowPrice:       body.lowPrice,
    highPrice:      body.highPrice,
    droppedTitle:   body.droppedTitle || 0,
    droppedOutlier: body.droppedOutlier || 0,
    fromCache:      !!body.fromCache,
  };
}

// ─── Query construction ────────────────────────────────────────────────────

function buildQuery(item) {
  if (item.model_guess) return item.model_guess;
  if (item.brand && item.description) {
    return `${item.brand} ${item.description}`.slice(0, 80);
  }
  return (item.description || '').slice(0, 80);
}

// ─── Score one item ───────────────────────────────────────────────────────

async function scoreItem(env, ctx, log, workspaceId, item, costTracker) {
  const query = buildQuery(item);
  if (!query || query.length < 4) {
    return {
      item_index:  item.item_index,
      description: item.description,
      category:    item.category_refined,
      condition:   item.condition,
      qty:         item.quantity,
      priced:      false,
      reason:      'no_query',
    };
  }

  // Always 'any' — see condition.js compsQueryCondition() for rationale.
  const condition = 'any';

  const comps = await callSoldComps(env, ctx, log, {
    workspaceId,
    query,
    category:  item.category_refined || 'other',
    condition,
  });
  if (!comps.fromCache) {
    costTracker.usd   += COST_PER_SOLDCOMPS_CALL_USD;
    costTracker.calls += 1;
  }

  if (!comps.ok || comps.count === 0) {
    // Sold-comps had nothing. Fall back to MSRP estimator.
    const fallback = estimateItem(item);
    if (fallback.priced) {
      return { ...fallback, red_flag: 'no_sold_comps', reason: comps.error || 'no_comps' };
    }
    return {
      item_index:  item.item_index,
      description: item.description,
      category:    item.category_refined,
      condition:   item.condition,
      qty:         item.quantity,
      priced:      false,
      reason:      comps.error || 'no_comps',
      red_flag:    'no_sold_comps',
    };
  }

  const unitMarket          = comps.medianPrice || comps.avgPrice || 0;
  const unitExpectedRevenue = unitMarket * REALIZATION_RATE;
  const shipping            = SHIPPING_ESTIMATES[item.category_refined] ?? SHIPPING_ESTIMATES.other;
  const ebayFee             = unitExpectedRevenue * EBAY_FEE_RATE;
  const unitNet             = unitExpectedRevenue - ebayFee - shipping;
  const total               = unitNet * (item.quantity || 1);

  const redFlags = [];
  if (item.category_refined === 'gpu' && comps.droppedTitle > Math.max(2, comps.rawCount * 0.3)) {
    redFlags.push('gpu_high_noise');
  }
  if (item.condition === 'for_parts' && unitMarket < (comps.rawAvgPrice ?? unitMarket) * 0.7) {
    redFlags.push('for_parts_low_price');
  }

  return {
    item_index:            item.item_index,
    description:           item.description,
    category:              item.category_refined,
    condition:             item.condition,
    qty:                   item.quantity,
    priced:                true,
    unit_market_price:     round2(unitMarket),
    unit_low_price:        Number.isFinite(comps.lowPrice)  ? round2(comps.lowPrice)  : null,
    unit_high_price:       Number.isFinite(comps.highPrice) ? round2(comps.highPrice) : null,
    unit_expected_revenue: round2(unitExpectedRevenue),
    unit_net:              round2(unitNet),
    total_net:             round2(total),
    comp_count:            comps.count,
    raw_comp_count:        comps.rawCount,
    dropped_title:         comps.droppedTitle,
    red_flags:             redFlags,
  };
}

// ─── MSRP-based estimate (no comps call) ──────────────────────────────────

function estimateItem(item) {
  const msrp = Number(item.msrp) || 0;
  if (msrp <= 0) {
    return {
      item_index:  item.item_index,
      description: item.description,
      category:    item.category_refined,
      condition:   item.condition,
      qty:         item.quantity,
      priced:      false,
      estimated:   true,
      reason:      'no_msrp',
    };
  }
  const mult = ESTIMATE_MULTIPLIER[item.condition] ?? ESTIMATE_MULTIPLIER.unknown;
  const unitMarket          = msrp * mult;
  const unitExpectedRevenue = unitMarket * REALIZATION_RATE;
  const shipping            = SHIPPING_ESTIMATES[item.category_refined] ?? SHIPPING_ESTIMATES.other;
  const ebayFee             = unitExpectedRevenue * EBAY_FEE_RATE;
  const unitNet             = unitExpectedRevenue - ebayFee - shipping;
  const total               = unitNet * (item.quantity || 1);
  return {
    item_index:            item.item_index,
    description:           item.description,
    category:              item.category_refined,
    condition:             item.condition,
    qty:                   item.quantity,
    priced:                true,
    estimated:             true,
    unit_market_price:     round2(unitMarket),
    unit_expected_revenue: round2(unitExpectedRevenue),
    unit_net:              round2(unitNet),
    total_net:             round2(total),
  };
}

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * Score a single lot end-to-end.
 *
 * @param {object} args
 * @param {object} args.env
 * @param {object} args.ctx
 * @param {object} args.log
 * @param {object} args.supabase
 * @param {string} args.workspaceId
 * @param {{ lot_id: string }} args.queueRow
 * @param {object} [args.externalCostTracker] — mutated for catch-block read
 * @returns {Promise<object>} — row ready for lot_analyses upsert
 */
export async function analyzeLot({ env, ctx, log, supabase, workspaceId, queueRow, externalCostTracker }) {
  const lotId = queueRow.lot_id;
  const costTracker = externalCostTracker || { usd: 0, calls: 0, claudeCalls: 0 };

  // 1. Load manifest + lot
  const [{ data: manifest }, { data: lot }] = await Promise.all([
    supabase
      .from('liquidation_manifests')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('lot_id', lotId)
      .order('item_index', { ascending: true }),
    supabase
      .from('liquidation_lots_newegg')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('lot_id', lotId)
      .maybeSingle(),
  ]);

  if (!manifest || manifest.length === 0) throw new Error('manifest_empty');

  // 2. Rank + split
  const maxPriced = Math.max(1, Number(env.ANALYSIS_MAX_PRICED_ITEMS) || Number(env.MAX_PRICED_ITEMS_PER_LOT) || DEFAULT_MAX_PRICED_ITEMS);
  const extMsrp = (i) => (Number(i.msrp) || 0) * (i.quantity || 1);
  const ranked = [...manifest].sort((a, b) => extMsrp(b) - extMsrp(a));
  const toPriceLive = ranked.slice(0, maxPriced);
  const toEstimate  = ranked.slice(maxPriced);

  log?.info('scoring_split', {
    lotId,
    manifestSize: manifest.length,
    liveCount: toPriceLive.length,
    estimateCount: toEstimate.length,
  });

  const estimatedResults = toEstimate.map(estimateItem);

  // 3. Score top-N items in parallel
  const perLotConcurrency = Math.max(1, Math.min(50,
    Number(env.ANALYSIS_PER_LOT_CONCURRENCY) || Number(env.PER_LOT_CONCURRENCY) || DEFAULT_PER_LOT_CONCURRENCY));

  const wholeResults = await mapWithConcurrency(toPriceLive, perLotConcurrency, (item) =>
    scoreItem(env, ctx, log, workspaceId, item, costTracker),
  );

  const itemResults = [
    ...wholeResults.filter(Boolean),
    ...estimatedResults,
  ];

  // 4. Scenarios — only the whole-lot resale path remains. The desktop
  // part-out decomposer was removed; downstream readers that referenced
  // scenarios.part_out_desktops / full_part_out fall back to resell_whole_lot.
  const resellWholeTotal = itemResults
    .filter((it) => it.priced)
    .reduce((acc, it) => acc + (it.total_net || 0), 0);

  // 5. Cost basis
  const lotPrice     = Number(lot?.current_bid || 0);
  const buyerPremium = lotPrice * 0.10;
  const estShipping  = 150;
  const estLabor     = manifest.length * 0.25 * 20;
  const costBasis    = lotPrice + buyerPremium + estShipping + estLabor;

  function scenario(revenue) {
    const profit = revenue - costBasis;
    const margin = costBasis > 0 ? (profit / costBasis) * 100 : null;
    return {
      revenue:    round2(revenue),
      cost_basis: round2(costBasis),
      profit:     round2(profit),
      margin_pct: margin != null ? round2(margin) : null,
    };
  }

  const scenarios = {
    resell_whole_lot: scenario(resellWholeTotal),
  };

  const recommendation = 'resell_whole_lot';

  // 6. Red flags
  const allRedFlags = new Set();
  for (const it of itemResults) {
    (it.red_flags || []).forEach((rf) => allRedFlags.add(rf));
    if (it.priced === false) allRedFlags.add(`no_comps_for_${it.category || 'unknown'}`);
  }
  const estimatedCount = estimatedResults.length;
  if (estimatedCount > 0 && estimatedCount > itemResults.length * 0.4) {
    allRedFlags.add('mostly_estimated');
  }

  // 7. Degraded guard — bail if nothing priced.
  const reallyPricedLive    = itemResults.filter((it) => it.priced && !it.estimated).length;
  const anyContributingItem = itemResults.some((it) => it.priced && (it.unit_market_price || 0) > 0);
  if (manifest.length > 0 && !anyContributingItem) {
    throw new Error(`degraded_no_items_priced: 0 of ${manifest.length} items produced revenue — likely a manifest with unparseable descriptions or items with no eBay sold-history`);
  }

  return {
    raw_lot_price:              round2(lotPrice),
    items_total_estimated_msrp: round2(manifest.reduce((a, i) => a + (Number(i.msrp) || 0), 0)),
    scenarios,
    recommendation,
    red_flags:                  Array.from(allRedFlags),
    item_results:               itemResults,
    items_total:                manifest.length,
    items_priced_live:          reallyPricedLive,
    items_estimated:            itemResults.filter((it) => it.estimated).length,
    total_cost_to_score_usd:    round2(costTracker.usd),
    soldcomps_calls:            costTracker.calls,
    // claude_calls is the legacy column name on lot_analyses. Even though
    // we're using Gemini now, we write into the existing column to avoid
    // a schema migration — the counter just tracks "AI part-out calls."
    claude_calls:               costTracker.claudeCalls,
    parser_version:             PARSER_VERSION,
  };
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

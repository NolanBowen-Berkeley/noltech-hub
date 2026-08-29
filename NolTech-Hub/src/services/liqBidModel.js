// ─── Liquidation.com close-ratio bid model ───────────────────────────────────
// Data-driven replacement for the static MSRP×condition-multiplier heuristic on
// Liquidation.com lots. The idea:
//
//   1. We already track every scraped lot + its final winning bid in
//      lotHistory.js (captureScrapedLots → pollClosingPrices → recordClosingState).
//   2. For each CLOSED lot we know the title MSRP (parsed from "$18K" in the
//      title) and the final bid. ratio = finalBid / titleMSRP.
//   3. Group those ratios by item category. The median ratio per category tells
//      us "GPU lots close at ~22% of title MSRP, appliance lots at ~6%", etc.
//   4. For a NEW open lot, estimate the bid as titleMSRP × that category ratio.
//
// The aggregated ratios are persisted to `noltech:arbitrage:liq-close-ratios`
// so they accumulate as a reusable model. Until a category has enough closed
// samples, the estimator falls back to the global ratio, then to the legacy
// heuristic — so it degrades gracefully on a cold dataset.
//
// TechLiquidators is untouched — this only applies to source === 'liquidation.com'.

import { getLotHistory } from './lotHistory';

export const KEY_LIQ_RATIOS = 'noltech:arbitrage:liq-close-ratios';

// Minimum closed samples before a category's own ratio is trusted over the
// global blended ratio.
const MIN_CATEGORY_SAMPLES = 3;
// Global fallback ratio used before ANY closes are recorded (rough industry
// prior for electronics returns/liquidation: ~15% of retail).
const COLD_START_RATIO = 0.15;

// ── Category classifier ──────────────────────────────────────────────────────
// Liquidation.com titles are comma-separated item-type lists
// (e.g. "iPhone 17Pro, RTX 5070, Gaming Desktop, Tablet"). We bucket each lot
// into a single PRIMARY category by first keyword match (most specific first),
// which is enough to segment close behavior.
const CATEGORY_RULES = [
  ['gpu',        /\b(rtx|gtx|radeon|geforce|rx\s?\d{3,}|graphics?\s*card|gpu)\b/i],
  ['desktop',    /\b(gaming\s*(desktop|pc|computer)|desktop\s*pc|tower|sff|prebuilt|workstation)\b/i],
  ['laptop',     /\b(laptop|notebook|macbook|chromebook|thinkpad|ultrabook)\b/i],
  ['phone',      /\b(iphone|galaxy\s*s\d|pixel|smartphone|cell\s*phone)\b/i],
  ['tablet',     /\b(ipad|tablet|galaxy\s*tab)\b/i],
  ['networking', /\b(networking|server|switch|router|firewall|rackmount|enterprise)\b/i],
  ['cooling',    /\b(liquid\s*cool|water\s*cool|\baio\b|cpu\s*cooler|case\s*fan)\b/i],
  ['components', /\b(motherboard|\bcpu\b|\bram\b|ddr[45]|power\s*supp|\bpsu\b|memory)\b/i],
  ['storage',    /\b(\bssd\b|\bhdd\b|nvme|hard\s*drive|m\.2|solid\s*state)\b/i],
  ['audio',      /\b(headset|headphone|earbud|speaker|soundbar|microphone)\b/i],
  ['appliance',  /\b(appliance|grooming|kitchen|vacuum|home|treadmill|massage)\b/i],
  ['accessories',/\b(accessor|cable|adapter|keyboard|mouse|charger|case\b|cover)\b/i],
];

export function classifyLiqCategory(title) {
  const t = String(title || '');
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(t)) return cat;
  }
  return 'other';
}

// ── Title MSRP parser (mirrors scraper/scrapers/liquidation.js parseMsrp) ─────
// Pulls the "$18K" / "$28.5K" / "$1,200" retail figure out of the lot title.
export function parseTitleMsrp(title) {
  if (!title) return null;
  const patterns = [
    /\$\s*([\d,]+\.?\d*)\s*([KkMm]?)/,
    /([\d,]+\.?\d*)\s*([KkMm])-\d+qty/i,
  ];
  for (const pat of patterns) {
    const m = title.match(pat);
    if (m) {
      let val = parseFloat(m[1].replace(/,/g, ''));
      const mult = (m[2] || '').toUpperCase();
      if (mult === 'K') val *= 1000;
      if (mult === 'M') val *= 1_000_000;
      if (Number.isFinite(val) && val > 10) return val;
    }
  }
  return null;
}

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

// ── Compute + persist per-category close ratios ───────────────────────────────
// Reads lot history, keeps closed Liquidation.com lots that have both a parsed
// title MSRP and a real final bid, computes ratio per lot, aggregates by
// category. Persists and returns the model.
export async function computeLiqCloseRatios() {
  const history = await getLotHistory();
  const buckets = {};   // category → number[] of ratios
  const allRatios = [];

  for (const h of history) {
    if (!(h.source || '').toLowerCase().includes('liquidation')) continue;
    if (h.finalBidStatus !== 'sold') continue;       // only real closes
    const finalBid = Number(h.finalBid);
    if (!Number.isFinite(finalBid) || finalBid <= 0) continue;
    const titleMsrp = Number(h.titleMsrp) || parseTitleMsrp(h.title);
    if (!titleMsrp || titleMsrp <= 0) continue;
    const ratio = finalBid / titleMsrp;
    // Drop absurd outliers (data errors): a lot won't close above its own MSRP
    // and a $0.01 close is noise.
    if (ratio <= 0 || ratio > 1.0) continue;
    const cat = h.category || classifyLiqCategory(h.title);
    (buckets[cat] = buckets[cat] || []).push(ratio);
    allRatios.push(ratio);
  }

  const globalSorted = [...allRatios].sort((a, b) => a - b);
  const globalMedian = median(globalSorted);
  const globalRatio = globalMedian != null ? globalMedian : COLD_START_RATIO;

  const categories = {};
  for (const [cat, ratios] of Object.entries(buckets)) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const med = median(sorted);
    const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    categories[cat] = {
      count: ratios.length,
      medianRatio: Math.round(med * 10000) / 10000,
      meanRatio: Math.round(mean * 10000) / 10000,
      low: Math.round(sorted[0] * 10000) / 10000,
      high: Math.round(sorted[sorted.length - 1] * 10000) / 10000,
    };
  }

  const model = {
    updatedAt: new Date().toISOString(),
    totalCloses: allRatios.length,
    globalRatio: Math.round(globalRatio * 10000) / 10000,
    categories,
  };

  try {
    await window.storage.set(KEY_LIQ_RATIOS, model);
  } catch (e) {
    console.error('[liqBidModel] persist failed:', e);
  }
  return model;
}

// Read the persisted model (or null if never computed).
export async function getLiqCloseRatios() {
  try {
    const v = await window.storage.get(KEY_LIQ_RATIOS);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ── Estimate the bid/close for an open lot ────────────────────────────────────
// Returns null when the lot isn't a Liquidation.com lot with a parseable title
// MSRP — caller should then fall back to the legacy estimate. Otherwise returns:
//   { estimatedClose, ratioUsed, category, source, sampleCount, titleMsrp }
//   source: 'category' | 'global' | 'cold_start'
export function estimateLiqBidSync(lot, model) {
  if (!lot || !(lot.source || '').toLowerCase().includes('liquidation')) return null;
  const titleMsrp = Number(lot.estimation?.totalMsrp) || parseTitleMsrp(lot.title);
  if (!titleMsrp || titleMsrp <= 0) return null;

  const category = classifyLiqCategory(lot.title);
  const cat = model?.categories?.[category];

  let ratioUsed, source, sampleCount;
  if (cat && cat.count >= MIN_CATEGORY_SAMPLES) {
    ratioUsed = cat.medianRatio;
    source = 'category';
    sampleCount = cat.count;
  } else if (model && model.totalCloses >= MIN_CATEGORY_SAMPLES) {
    ratioUsed = model.globalRatio;
    source = 'global';
    sampleCount = model.totalCloses;
  } else {
    ratioUsed = COLD_START_RATIO;
    source = 'cold_start';
    sampleCount = model?.totalCloses || 0;
  }

  return {
    estimatedClose: Math.round(titleMsrp * ratioUsed),
    ratioUsed,
    ratioPct: Math.round(ratioUsed * 1000) / 10,   // e.g. 22.4 (%)
    category,
    source,
    sampleCount,
    titleMsrp: Math.round(titleMsrp),
  };
}

// Async convenience: loads the persisted model then estimates.
export async function estimateLiqBid(lot) {
  const model = await getLiqCloseRatios();
  return estimateLiqBidSync(lot, model);
}

// ── Bid simulator ────────────────────────────────────────────────────────────
// "If I bid $X on this lot, what's my probability of winning?"
//
// Reads the per-lot ratio distribution from history (not just the median),
// turns the user's bid into a ratio (= bid / titleMSRP), and counts the
// fraction of historical closes that finished AT OR BELOW that ratio. If the
// market clears below my bid, I would have won it.
//
// Requires:
//   - lot has parseable title MSRP
//   - history has ≥ MIN_SIM_SAMPLES closes in the lot's category (else falls
//     back to the global distribution, then to null if neither is populated)
//
// Returns:
//   { winProbability, percentile, sampleCount, scope: 'category'|'global'|null,
//     bidRatio, distribution: { p10, p25, median, p75, p90 } } | null
//
// Used by the DealAnalyzer / lot card "what if I bid X" widget.

const MIN_SIM_SAMPLES = 5;

function quantile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function buildRatioPool(history, predicate) {
  const out = [];
  for (const h of history) {
    if (!(h.source || '').toLowerCase().includes('liquidation')) continue;
    if (h.finalBidStatus !== 'sold') continue;
    const finalBid = Number(h.finalBid);
    if (!Number.isFinite(finalBid) || finalBid <= 0) continue;
    const titleMsrp = Number(h.titleMsrp) || parseTitleMsrp(h.title);
    if (!titleMsrp || titleMsrp <= 0) continue;
    const ratio = finalBid / titleMsrp;
    if (ratio <= 0 || ratio > 1.0) continue;
    if (!predicate(h, ratio)) continue;
    out.push(ratio);
  }
  return out.sort((a, b) => a - b);
}

export async function simulateLiqBid(lot, bidUsd) {
  if (!lot || !Number.isFinite(bidUsd) || bidUsd <= 0) return null;
  const titleMsrp = Number(lot.estimation?.totalMsrp) || parseTitleMsrp(lot.title);
  if (!titleMsrp || titleMsrp <= 0) return null;

  const bidRatio = bidUsd / titleMsrp;
  const history = await getLotHistory();
  const category = classifyLiqCategory(lot.title);

  // Prefer in-category samples; fall back to the global liquidation pool when
  // the category bucket is thin.
  let pool = buildRatioPool(history, (h) => classifyLiqCategory(h.title) === category);
  let scope = 'category';
  if (pool.length < MIN_SIM_SAMPLES) {
    pool = buildRatioPool(history, () => true);
    scope = pool.length >= MIN_SIM_SAMPLES ? 'global' : null;
  }
  if (!scope) return null;

  // P(win) = P(market close ≤ my bid ratio) — fraction of historical closes
  // that finished at-or-below the user's bid ratio.
  let belowOrEqual = 0;
  for (const r of pool) if (r <= bidRatio) belowOrEqual += 1;
  const winProbability = belowOrEqual / pool.length;

  // Where does the user's bid sit in the distribution? (higher percentile =
  // more aggressive bid relative to history).
  const percentile = Math.round(winProbability * 1000) / 10;   // e.g. 73.4

  return {
    winProbability,
    percentile,
    sampleCount: pool.length,
    scope,
    bidRatio: Math.round(bidRatio * 10000) / 10000,
    distribution: {
      p10:    quantile(pool, 0.10),
      p25:    quantile(pool, 0.25),
      median: quantile(pool, 0.50),
      p75:    quantile(pool, 0.75),
      p90:    quantile(pool, 0.90),
    },
  };
}

// ─── Sample outlier filters ─────────────────────────────────────────────────
// Applied to eBay sold-listing samples before computing aggregate stats.
//
// Ported from scrape-sold-comps/src/forPartsFilter.js with two changes:
//   1. The category-specific GPU "no core" title filter now applies to
//      motherboards too (NO-CHIP, BROKEN PINS, NOT POSTING, etc.) — these
//      were polluting motherboard medians.
//   2. The IQR filter is now opt-out per call (default on). Caller passes
//      { iqr: false } when sample size is < 4 and trimming would over-fit.

// Title patterns that signal a junk listing regardless of condition tag.
const JUNK_TITLE_PATTERNS = {
  gpu: [
    /\bno\s+(core|chip|die|gpu)\b/i,
    /\bcore\s+(missing|removed|gone)\b/i,
    /\bpcb\s+only\b/i,
    /\bfor\s+parts\s+only\b/i,
    /\bas[-\s]?is\s+no\s+(core|die)\b/i,
    /\bdoes\s+not\s+(post|work|boot|display)\b/i,
    /\bno\s+output\b/i,
  ],
  motherboard: [
    /\bbent\s+pins?\b/i,
    /\bbroken\s+pins?\b/i,
    /\bdoes\s+not\s+(post|work|boot)\b/i,
    /\bfor\s+parts\s+only\b/i,
    /\bcpu\s+socket\s+damaged\b/i,
  ],
  cpu: [
    /\bbent\s+pins?\b/i,
    /\bdoes\s+not\s+post\b/i,
    /\bdamaged\b/i,
  ],
  default: [
    /\bfor\s+parts\s+only\b/i,
    /\bnot\s+working\b/i,
    /\bbroken\b/i,
  ],
};

/**
 * Drop samples whose title matches a known-junk pattern for this category.
 * Returns { kept, dropped }.
 */
export function filterSamplesByTitle(samples, category = 'other') {
  const patterns = JUNK_TITLE_PATTERNS[category] || JUNK_TITLE_PATTERNS.default;
  const kept = [];
  const dropped = [];
  for (const s of samples) {
    const title = String(s.title || '');
    const isJunk = patterns.some((re) => re.test(title));
    if (isJunk) dropped.push(s);
    else kept.push(s);
  }
  return { kept, dropped };
}

/**
 * Drop samples whose price is an outlier:
 *   - Below MAX(median × 0.30, Q1 × 0.5) — the "too-good-to-be-true" floor
 *   - Outside [Q1 - 1.5×IQR, Q3 + 1.5×IQR] — standard IQR fence
 *
 * Disabled when sample count < 4 (statistics aren't meaningful that small).
 */
export function filterPriceOutliers(samples) {
  if (samples.length < 4) {
    return { kept: samples, droppedLow: [], droppedHigh: [] };
  }
  const prices = samples
    .map((s) => s.totalPrice ?? s.price)
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0);
  if (prices.length < 4) {
    return { kept: samples, droppedLow: [], droppedHigh: [] };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const q1     = quantile(sorted, 0.25);
  const q3     = quantile(sorted, 0.75);
  const iqr    = q3 - q1;
  const floor  = Math.max(median * 0.30, q1 * 0.5);
  const lower  = q1 - 1.5 * iqr;
  const upper  = q3 + 1.5 * iqr;

  const kept = [];
  const droppedLow = [];
  const droppedHigh = [];
  for (const s of samples) {
    const p = s.totalPrice ?? s.price;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) continue;
    if (p < floor || p < lower) droppedLow.push(s);
    else if (p > upper)         droppedHigh.push(s);
    else                        kept.push(s);
  }
  return { kept, droppedLow, droppedHigh };
}

function quantile(sortedArr, q) {
  if (sortedArr.length === 0) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sortedArr.length) {
    return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
  }
  return sortedArr[base];
}

/**
 * Compute aggregate stats from a sample set. 3-sigma safety net for any
 * outlier that survived the IQR/TGTBT pass.
 */
export function computeAggregates(items) {
  const prices = items
    .map((it) => it.totalPrice ?? it.price)
    .filter((p) => typeof p === 'number' && Number.isFinite(p) && p > 0);
  const count = prices.length;
  if (count === 0) {
    return { count: 0, medianPrice: null, lowPrice: null, highPrice: null, avgPrice: null };
  }
  const sorted = [...prices].sort((a, b) => a - b);
  const lowPrice    = sorted[0];
  const highPrice   = sorted[sorted.length - 1];
  const medianPrice = quantile(sorted, 0.5);

  const rawMean = prices.reduce((a, b) => a + b, 0) / count;
  const variance = prices.reduce((a, b) => a + (b - rawMean) ** 2, 0) / count;
  const stdev = Math.sqrt(variance);
  const trimmed = stdev > 0 ? prices.filter((p) => Math.abs(p - rawMean) <= 3 * stdev) : prices;
  const avgPrice = trimmed.length > 0 ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length : rawMean;

  return {
    count,
    medianPrice: round2(medianPrice),
    lowPrice:    round2(lowPrice),
    highPrice:   round2(highPrice),
    avgPrice:    round2(avgPrice),
  };
}

function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

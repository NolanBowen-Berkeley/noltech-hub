// ─── Single source of truth: condition detection + Lambda mapping ───────────
// Replaces three duplicated copies of mapConditionForLambda + the variadic
// detectCondition that blindly merged item + lot text into one regex blob
// (which caused every Liq.com Customer Returns lot to tag all items as
// for_parts, halving the MSRP multiplier).
//
// CRITICAL behavioral fixes baked in:
//   1. Item-level text is checked FIRST. Only if the item makes no claim
//      do we fall back to lot-level context. This stops lot.condition=
//      'Customer Returns' from blanket-overriding individual item tags.
//   2. The broad /\breturn(?:s|ed)?\b/ pattern is GONE — it matched
//      "return policy", "high return value" etc. Replaced with
//      /\bcustomer\s+returns?\b/ which only fires on the lot tag.
//   3. The Lambda-condition mapper passes through 'any' explicitly so
//      we can opt into broadest eBay sample counts on niche SKUs.

const FOR_PARTS = [
  /\bcustomer\s+returns?\b/i,
  /\buntested\b/i,
  /\bdamaged\b/i,
  /\bdefective\b/i,
  /\bas[-\s]?is\b/i,
  /\bfor\s+parts\b/i,
  /\bnot\s+working\b/i,
  /\bnon[-\s]?functional\b/i,
  /\bsalvage\b/i,
  /\bbroken\b/i,
];

const WORKING = [
  /\bnew\b/i,
  /\bsealed\b/i,
  /\btested\b/i,
  /\bworking\b/i,
  /\bverified\b/i,
  /\brefurbished?\b/i,
  /\bcertified\b/i,
  /\bopen\s+box\b/i,
];

/**
 * Derive an item's manifest condition. Checks item-level text first; only
 * falls back to lot context if the item is silent.
 *
 * @param {string} itemText        — item's own condition cell (manifest)
 * @param {string} [lotCondition]  — auction-level condition (often "Customer Returns")
 * @param {string} [lotTitle]      — auction title
 * @returns {'working'|'for_parts'|'unknown'}
 */
export function detectItemCondition(itemText, lotCondition = '', lotTitle = '') {
  const itemBlob = String(itemText || '').toLowerCase();
  if (itemBlob) {
    for (const re of FOR_PARTS) if (re.test(itemBlob)) return 'for_parts';
    for (const re of WORKING)   if (re.test(itemBlob)) return 'working';
  }
  const lotBlob = `${lotCondition} ${lotTitle}`.toLowerCase();
  if (lotBlob.trim()) {
    for (const re of FOR_PARTS) if (re.test(lotBlob)) return 'for_parts';
    for (const re of WORKING)   if (re.test(lotBlob)) return 'working';
  }
  return 'unknown';
}

/**
 * Lambda / sold-comps query condition. We DEFAULT to 'any' because that
 * gives eBay's full sample pool and lets the outlier filter trim noise.
 * Caller can override (e.g. eBay Browse API for parts pricing of a known-
 * broken item).
 *
 * Returns one of: 'any' | 'working' | 'for_parts'
 */
export function compsQueryCondition(/* itemCondition, opts */) {
  // Always 'any'. Reasoning is documented at length in the rewrite plan;
  // briefly: narrowing to 'working' or 'for_parts' silently returns 1-2
  // samples on niche/flagship SKUs and trips low-confidence warnings.
  // 'any' gives 30-60+ samples and the outlier filter handles the bad ones.
  return 'any';
}

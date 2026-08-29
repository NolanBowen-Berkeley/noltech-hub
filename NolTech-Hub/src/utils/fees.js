// ─── eBay fee calculation ─────────────────────────────────────────────────────
// Default 9.35%. Can be overridden in Settings → eBay Fee Rate.
// Reads from a global that Settings writes to on load.
let _customRate = null;

export function setEbayFeeRate(rate) {
  _customRate = rate;
}

export function getEbayFeeRate() {
  return _customRate ?? 0.0935;
}

// ─── Resale realization rate ──────────────────────────────────────────────────
// What fraction of estimated/MSRP value you actually realize at sale. If you
// list at 20% below market to push sell-through, set this to 0.80 — every
// downstream estimation (manifest resale, MSRP-derived bid ceilings, signal
// margin) gets multiplied by this factor so the bid guidance is grounded in
// what you ACTUALLY make on average, not the theoretical full-retail value.
let _realizationRate = null;

export function setResaleRealizationRate(rate) {
  // Accept either a fraction (0.8) or a percentage (80) to be tolerant.
  if (rate == null || isNaN(rate)) { _realizationRate = null; return; }
  _realizationRate = rate > 1 ? rate / 100 : rate;
}

export function getResaleRealizationRate() {
  return _realizationRate ?? 1.0;
}

// ─── Active-listing ask buffer ────────────────────────────────────────────────
// The eBay Browse API returns ACTIVE asking prices, which skew higher than
// what items actually sell for. This factor compensates: 0.85 means asks are
// typically 15% above realized sold prices.
//
// Now supports a default rate PLUS per-category overrides — different product
// types have very different ask-vs-sold gaps (Nintendo consoles ~90%, Apple
// iPads ~75%, off-brand niche items ~70%).
//
// Storage shape: { default: number, byCategory: { [name]: number } }
// Backward-compatible: a bare number is treated as the default with empty
// overrides. Stacks multiplicatively with the user's realization rate.
const DEFAULT_ASK_BUFFER = 1.0;

let _askBufferConfig = null; // { default, byCategory }

// Normalize either a 0-1 fraction or a 1-200 percentage to a 0-2 fraction.
const toFraction = (n) => {
  if (n == null || isNaN(n)) return null;
  const num = Number(n);
  return num > 1 ? num / 100 : num;
};

export function setActiveAskBuffer(value) {
  if (value == null) { _askBufferConfig = null; return; }
  // Backward compat: a number (or numeric string) means "set the default"
  if (typeof value === 'number' || typeof value === 'string') {
    const dflt = toFraction(value);
    if (dflt == null) { _askBufferConfig = null; return; }
    _askBufferConfig = { default: dflt, byCategory: {} };
    return;
  }
  if (typeof value !== 'object') return;
  const dflt = toFraction(value.default) ?? DEFAULT_ASK_BUFFER;
  const byCategory = {};
  for (const [k, v] of Object.entries(value.byCategory || {})) {
    const f = toFraction(v);
    if (f != null && k) byCategory[k] = f;
  }
  _askBufferConfig = { default: dflt, byCategory };
}

export function getActiveAskBufferConfig() {
  return _askBufferConfig ?? { default: DEFAULT_ASK_BUFFER, byCategory: {} };
}

// Look up the buffer for an optional category. Tolerant to comma/slash-
// separated category strings and case differences. Falls back to default
// when no override matches.
export function getActiveAskBuffer(category) {
  return getActiveAskBufferDetails(category).rate;
}

// Same lookup, but returns details for UI display: the rate AND whether it
// came from a category override (and which key matched) or the default.
//
// Match priority (most specific first):
//   1. Exact match (case-sensitive)
//   2. Case-insensitive exact match
//   3. Substring match — override key contained in lot category, or vice
//      versa. Prefers the longest matching key when multiple overrides
//      could apply, so "Video Game Consoles" beats "Video".
//
// Substring matching means "Video Game" override matches a "Video Game
// Consoles" lot, "Tablet" matches "Tablets", "iPad" matches "Apple iPad
// Pro" — typically what users want when typing a short category name.
export function getActiveAskBufferDetails(category) {
  const config = getActiveAskBufferConfig();
  if (!category) return { rate: config.default, source: 'default', matchedKey: null };
  const cats = String(category).split(/[,;|/]/).map((c) => c.trim()).filter(Boolean);
  for (const cat of cats) {
    // 1. Exact match
    if (config.byCategory[cat] != null) {
      return { rate: config.byCategory[cat], source: 'override', matchedKey: cat };
    }
    // 2. Case-insensitive exact match
    const lower = cat.toLowerCase();
    for (const [key, val] of Object.entries(config.byCategory)) {
      if (key.toLowerCase() === lower) {
        return { rate: val, source: 'override', matchedKey: key };
      }
    }
    // 3. Substring match — collect all candidates, pick the longest key
    const partial = [];
    for (const [key, val] of Object.entries(config.byCategory)) {
      const keyLower = key.toLowerCase().trim();
      if (!keyLower) continue;
      if (lower.includes(keyLower) || keyLower.includes(lower)) {
        partial.push({ key, val, len: keyLower.length });
      }
    }
    if (partial.length) {
      partial.sort((a, b) => b.len - a.len);
      const best = partial[0];
      return { rate: best.val, source: 'override', matchedKey: best.key };
    }
  }
  return { rate: config.default, source: 'default', matchedKey: null };
}

// ─── Auction buyer's premium (per source) ────────────────────────────────────
// Most liquidation auctions tack a buyer's premium onto the winning bid.
// TechLiquidators charges 5%, Liquidation.com 10%, B-Stock varies.
// Bid ceilings have to account for this — if the ceiling COST is X, the
// max BID is X / (1 + premium), since you'll actually pay bid × (1 + premium).
const DEFAULT_AUCTION_FEE_RATES = {
  techliquidators: 0.05,
  liquidation: 0.10,
  bstock: 0.00,
};

let _auctionFeeRates = null;

export function setAuctionFeeRates(map) {
  if (!map || typeof map !== 'object') { _auctionFeeRates = null; return; }
  _auctionFeeRates = { ...DEFAULT_AUCTION_FEE_RATES, ...map };
}

export function getAuctionFeeRates() {
  return _auctionFeeRates ?? DEFAULT_AUCTION_FEE_RATES;
}

export { DEFAULT_AUCTION_FEE_RATES };

// Look up the buyer-premium rate for a given source string. Tolerant to
// substrings ("liquidation.com", "techliquidators.com", "bstock-supply").
// Returns 0 when no source match — no premium is the safe default.
export function getAuctionFeeRate(source) {
  if (!source) return 0;
  const map = getAuctionFeeRates();
  const s = String(source).toLowerCase();
  if (s.includes('techliq'))      return map.techliquidators ?? 0;
  if (s.includes('liquidation'))  return map.liquidation     ?? 0;
  if (s.includes('bstock'))       return map.bstock          ?? 0;
  return 0;
}

// ─── eBay-pricer condition haircut ────────────────────────────────────────────
// The Browse API returns asking prices for *active* listings — almost always
// items in working / used condition. When the lot in hand is salvage,
// for-parts, or broken, those eBay prices wildly overstate what the user can
// actually realize. This map applies a per-condition haircut to the eBay
// manifest resale total so bid guidance accounts for that gap.
//
// Defaults: working/like-new ~1.0, fair ~0.85, salvage ~0.45, for_parts/broken
// ~0.30. Stacks multiplicatively on top of realization × ask buffer.
const DEFAULT_EBAY_CONDITION_HAIRCUTS = {
  new: 1.0, sealed: 1.0, open_box: 0.95, like_new: 0.95,
  refurbished: 0.90, grade_a: 1.0, grade_b: 0.90, grade_c: 0.70, grade_d: 0.50,
  good: 1.0, used: 1.0, fair: 0.85, poor: 0.60,
  broken: 0.30, for_parts: 0.30, salvage: 0.45,
  as_is: 0.65, untested: 0.75, unknown: 0.90, mixed: 0.85,
};

let _ebayConditionHaircuts = null;

export function setEbayConditionHaircuts(map) {
  if (!map || typeof map !== 'object') { _ebayConditionHaircuts = null; return; }
  _ebayConditionHaircuts = { ...DEFAULT_EBAY_CONDITION_HAIRCUTS, ...map };
}

export function getEbayConditionHaircuts() {
  return _ebayConditionHaircuts ?? DEFAULT_EBAY_CONDITION_HAIRCUTS;
}

export { DEFAULT_EBAY_CONDITION_HAIRCUTS };

// Look up the haircut for a normalized condition string. Tolerant to spaces,
// dashes, slashes, casing, and common synonyms (e.g. "Used / Working", "For
// Parts", "Refurb"). Falls back to 1.0 (no haircut) only when the string
// genuinely matches nothing.
export function getEbayConditionHaircut(condition) {
  if (!condition) return 1.0;
  const map = getEbayConditionHaircuts();
  const raw = String(condition).toLowerCase().trim();

  // Direct key match after collapsing whitespace / dashes / slashes
  const norm = raw.replace(/[\s\-/]+/g, '_').replace(/_+/g, '_');
  if (map[norm] != null) return map[norm];

  // Word-boundary pattern matching. Order matters — most specific first so
  // "for parts" doesn't get caught by a generic "parts" later.
  const has = (re) => re.test(raw);
  if (has(/\bfor[_ ]?parts\b/) || has(/\bparts[_ ]?only\b/) || has(/\bnot[_ ]?working\b/)) return map.for_parts ?? 0.30;
  if (has(/\bsalvage\b/))                                  return map.salvage     ?? 0.45;
  if (has(/\bbroken\b|\bdefective\b|\bdamaged\b/))         return map.broken      ?? 0.30;
  if (has(/\brefurb/))                                     return map.refurbished ?? 0.90;
  if (has(/\bopen[_ ]?box\b/))                             return map.open_box    ?? 0.95;
  if (has(/\blike[_ ]?new\b/))                             return map.like_new    ?? 0.95;
  if (has(/\bsealed\b/))                                   return map.sealed      ?? 1.0;
  if (has(/\buntested\b/))                                 return map.untested    ?? 0.75;
  if (has(/\bas[_ ]?is\b/))                                return map.as_is       ?? 0.65;
  // "Used / Working", "Working", "Tested Working", "Good Working" — all should
  // be treated as no-haircut since the items are functional.
  if (has(/\bworking\b/) || has(/\btested\b/))             return map.good        ?? 1.0;
  if (has(/\bused\b/))                                     return map.used        ?? 1.0;
  if (has(/\bgood\b/))                                     return map.good        ?? 1.0;
  if (has(/\bnew\b/))                                      return map.new         ?? 1.0;
  if (has(/\bfair\b/))                                     return map.fair        ?? 0.85;
  if (has(/\bpoor\b/))                                     return map.poor        ?? 0.60;
  if (has(/\bmixed\b/))                                    return map.mixed       ?? 0.85;
  if (has(/\bunknown\b/))                                  return map.unknown     ?? 0.90;
  return 1.0;
}

// Returns the normalized condition KEY used to look up the haircut. Useful for
// display so the UI can show e.g. "Used / Working → good (100%)" rather than
// just a percentage. Mirrors the resolution logic above.
export function resolveConditionKey(condition) {
  if (!condition) return null;
  const map = getEbayConditionHaircuts();
  const raw = String(condition).toLowerCase().trim();
  const norm = raw.replace(/[\s\-/]+/g, '_').replace(/_+/g, '_');
  if (map[norm] != null) return norm;
  const has = (re) => re.test(raw);
  if (has(/\bfor[_ ]?parts\b/) || has(/\bparts[_ ]?only\b/) || has(/\bnot[_ ]?working\b/)) return 'for_parts';
  if (has(/\bsalvage\b/))                          return 'salvage';
  if (has(/\bbroken\b|\bdefective\b|\bdamaged\b/)) return 'broken';
  if (has(/\brefurb/))                             return 'refurbished';
  if (has(/\bopen[_ ]?box\b/))                     return 'open_box';
  if (has(/\blike[_ ]?new\b/))                     return 'like_new';
  if (has(/\bsealed\b/))                           return 'sealed';
  if (has(/\buntested\b/))                         return 'untested';
  if (has(/\bas[_ ]?is\b/))                        return 'as_is';
  if (has(/\bworking\b/) || has(/\btested\b/))     return 'good';
  if (has(/\bused\b/))                             return 'used';
  if (has(/\bgood\b/))                             return 'good';
  if (has(/\bnew\b/))                              return 'new';
  if (has(/\bfair\b/))                             return 'fair';
  if (has(/\bpoor\b/))                             return 'poor';
  if (has(/\bmixed\b/))                            return 'mixed';
  if (has(/\bunknown\b/))                          return 'unknown';
  return null;
}

// Combined effective multiplier applied to bid-guidance / resale estimates.
// All callers should use this rather than multiplying the factors inline.
// Pass a condition string to include the eBay-pricer condition haircut, and
// a category to use the per-category ask buffer override (when configured).
export function getEffectiveResaleMultiplier(condition, category) {
  const haircut = condition ? getEbayConditionHaircut(condition) : 1.0;
  return getResaleRealizationRate() * getActiveAskBuffer(category) * haircut;
}

export const EBAY_FEE_RATE = 0.0935; // kept for backward compat; modules should use getEbayFeeRate()

export function ebayFee(price, shipping = 0) {
  return (price + shipping) * EBAY_FEE_RATE;
}

export function netRevenue(price, shipping = 0) {
  return price - ebayFee(price, shipping) - shipping;
}

// ─── Platform fees (used by Inventory module) ────────────────────────────────
export function calcPlatformFees(platform, salePrice, shippingCost) {
  const p = parseFloat(salePrice)   || 0;
  const s = parseFloat(shippingCost)|| 0;
  switch (platform) {
    case 'ebay':     return (p + s) * EBAY_FEE_RATE;
    case 'mercari':  return p * 0.10 + p * 0.029 + 0.50;
    case 'facebook': return p * 0.05;
    default:         return 0;
  }
}

export function getItemCostBasis(item, lot) {
  // Per-item costBasis takes priority; fall back to lot cost ÷ itemCount
  if (item.costBasis != null && item.costBasis !== '') return parseFloat(item.costBasis) || 0;
  return (parseFloat(lot?.cost) || 0) / (parseInt(lot?.itemCount) || 1);
}

export function calcItemProfit(item, lot) {
  if (!item.sale || !lot) return null;
  const costBasis = getItemCostBasis(item, lot);
  const { salePrice = 0, shippingCost = 0, platformFees = 0 } = item.sale;
  const netRev  = salePrice - shippingCost - platformFees;
  const profit  = netRev - costBasis;
  const roi     = costBasis > 0 ? (profit / costBasis) * 100 : 0;
  const margin  = salePrice > 0 ? (profit / salePrice) * 100 : 0;
  return { costBasis, netRevenue: netRev, profit, roi, margin };
}

// ─── Lot-level calculations (used by AI Analyzer) ────────────────────────────
export function totalGrossRevenue(items) {
  return items.reduce((s, it) => s + (parseFloat(it.yourValue ?? it.estimatedValue) || 0), 0);
}

export function totalNetRevenue(items, avgShipping = 8) {
  return items.reduce((s, item) => {
    const price = parseFloat(item.yourValue ?? item.estimatedValue) || 0;
    const ship  = item.shippingOverride != null && item.shippingOverride !== ''
      ? parseFloat(item.shippingOverride) || 0
      : avgShipping;
    return s + netRevenue(price, ship);
  }, 0);
}

export function bidCeiling(items, avgShipping, targetMarginPct) {
  const gross   = totalGrossRevenue(items);
  const net     = totalNetRevenue(items, avgShipping);
  const ceiling = net - gross * (targetMarginPct / 100);
  return Math.max(0, ceiling);
}

export function profitAtBid(items, avgShipping, bid) {
  return totalNetRevenue(items, avgShipping) - bid;
}

export const FEE_DESCRIPTION = {
  ebay:     '9.35% of (price + ship)',
  mercari:  '10% + 2.9% + $0.50',
  facebook: '5% of price',
  local:    '0%',
  other:    '0%',
};

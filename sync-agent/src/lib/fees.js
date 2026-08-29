// ─── Fee calculation (Pi-server flavor) ──────────────────────────────────────
// Server-side variant of NolTech-Hub/src/utils/fees.js. The desktop app reads
// user-configurable rates from IndexedDB; the Pi has no IndexedDB and no
// browser, so every "user-configurable" rate falls back to a process.env
// value (parsed as a float) or a hardcoded sensible default.
//
// Setters are intentionally omitted — the agent has no UI to mutate them at
// runtime. Rotate the .env values + restart the systemd service to change
// rates.

// Helper: parse an env var as a float, accepting either a fraction (0.0935)
// or a percentage (9.35). Returns the fallback when missing or invalid.
function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  // If the user wrote "9.35" assume percentage and convert; "0.0935" stays as-is.
  return n > 1 ? n / 100 : n;
}

// ─── eBay fee rate ────────────────────────────────────────────────────────────
// Default 9.35%. Override with EBAY_FEE_RATE env var.
export function getEbayFeeRate() {
  return envFloat('EBAY_FEE_RATE', 0.0935);
}

// ─── Resale realization rate ─────────────────────────────────────────────────
// Fraction of estimated/MSRP value actually realized at sale. Override with
// RESALE_REALIZATION_RATE env var.
export function getResaleRealizationRate() {
  return envFloat('RESALE_REALIZATION_RATE', 1.0);
}

// ─── Active-listing ask buffer ───────────────────────────────────────────────
// Compensation for eBay Browse API returning ACTIVE asking prices (which skew
// higher than realized sold prices). On the Pi we only support the default
// rate — per-category overrides require the IndexedDB config blob the Pi
// doesn't have.
const DEFAULT_ASK_BUFFER = 1.0;

export function getActiveAskBufferConfig() {
  return { default: envFloat('ACTIVE_ASK_BUFFER', DEFAULT_ASK_BUFFER), byCategory: {} };
}

export function getActiveAskBuffer(_category) {
  return getActiveAskBufferConfig().default;
}

export function getActiveAskBufferDetails(_category) {
  return { rate: getActiveAskBufferConfig().default, source: 'default', matchedKey: null };
}

// ─── Auction buyer's premium (per source) ────────────────────────────────────
// Bid ceilings have to account for buyer's premium since the user actually
// pays bid × (1 + premium). On the Pi we use the static defaults; if a
// future caller needs overrides, add AUCTION_FEE_RATE_TECHLIQ /
// AUCTION_FEE_RATE_LIQUIDATION / AUCTION_FEE_RATE_BSTOCK env vars.
const DEFAULT_AUCTION_FEE_RATES = {
  techliquidators: 0.05,
  liquidation: 0.10,
  bstock: 0.00,
};

export { DEFAULT_AUCTION_FEE_RATES };

export function getAuctionFeeRates() {
  return {
    techliquidators: envFloat('AUCTION_FEE_RATE_TECHLIQ', DEFAULT_AUCTION_FEE_RATES.techliquidators),
    liquidation:     envFloat('AUCTION_FEE_RATE_LIQUIDATION', DEFAULT_AUCTION_FEE_RATES.liquidation),
    bstock:          envFloat('AUCTION_FEE_RATE_BSTOCK', DEFAULT_AUCTION_FEE_RATES.bstock),
  };
}

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
// Per-condition haircut applied to eBay manifest resale totals so bid guidance
// accounts for active-vs-sold and condition realities. Defaults below; the Pi
// uses them as-is (no env override — a 20-key map doesn't fit cleanly in env
// vars, and the agent doesn't price manifests anyway).
const DEFAULT_EBAY_CONDITION_HAIRCUTS = {
  new: 1.0, sealed: 1.0, open_box: 0.95, like_new: 0.95,
  refurbished: 0.90, grade_a: 1.0, grade_b: 0.90, grade_c: 0.70, grade_d: 0.50,
  good: 1.0, used: 1.0, fair: 0.85, poor: 0.60,
  broken: 0.30, for_parts: 0.30, salvage: 0.45,
  as_is: 0.65, untested: 0.75, unknown: 0.90, mixed: 0.85,
};

export { DEFAULT_EBAY_CONDITION_HAIRCUTS };

export function getEbayConditionHaircuts() {
  return DEFAULT_EBAY_CONDITION_HAIRCUTS;
}

export function getEbayConditionHaircut(condition) {
  if (!condition) return 1.0;
  const map = getEbayConditionHaircuts();
  const raw = String(condition).toLowerCase().trim();

  const norm = raw.replace(/[\s\-/]+/g, '_').replace(/_+/g, '_');
  if (map[norm] != null) return map[norm];

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

// Combined effective multiplier applied to bid-guidance / resale estimates.
export function getEffectiveResaleMultiplier(condition, category) {
  const haircut = condition ? getEbayConditionHaircut(condition) : 1.0;
  return getResaleRealizationRate() * getActiveAskBuffer(category) * haircut;
}

// ─── Fee math (matches NolTech-Hub semantics) ─────────────────────────────────
export const EBAY_FEE_RATE = 0.0935; // legacy constant; prefer getEbayFeeRate()

export function ebayFee(price, shipping = 0) {
  return (price + shipping) * getEbayFeeRate();
}

export function netRevenue(price, shipping = 0) {
  return price - ebayFee(price, shipping) - shipping;
}

export function calcPlatformFees(platform, salePrice, shippingCost) {
  const p = parseFloat(salePrice)   || 0;
  const s = parseFloat(shippingCost) || 0;
  switch (platform) {
    case 'ebay':     return (p + s) * getEbayFeeRate();
    case 'mercari':  return p * 0.10 + p * 0.029 + 0.50;
    case 'facebook': return p * 0.05;
    default:         return 0;
  }
}

export function getItemCostBasis(item, lot) {
  if (item?.costBasis != null && item.costBasis !== '') return parseFloat(item.costBasis) || 0;
  return (parseFloat(lot?.cost) || 0) / (parseInt(lot?.itemCount) || 1);
}

export function calcItemProfit(item, lot) {
  if (!item?.sale || !lot) return null;
  const costBasis = getItemCostBasis(item, lot);
  const { salePrice = 0, shippingCost = 0, platformFees = 0 } = item.sale;
  const netRev  = salePrice - shippingCost - platformFees;
  const profit  = netRev - costBasis;
  const roi     = costBasis > 0 ? (profit / costBasis) * 100 : 0;
  const margin  = salePrice > 0 ? (profit / salePrice) * 100 : 0;
  return { costBasis, netRevenue: netRev, profit, roi, margin };
}

export const FEE_DESCRIPTION = {
  ebay:     '9.35% of (price + ship)',
  mercari:  '10% + 2.9% + $0.50',
  facebook: '5% of price',
  local:    '0%',
  other:    '0%',
};

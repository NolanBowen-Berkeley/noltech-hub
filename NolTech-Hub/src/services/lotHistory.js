// ─── Lot history + comparable-closes service ─────────────────────────────────
// Tracks every TechLiquidators lot we've scraped, then captures the final
// winning bid after the auction ends. Used to surface "comparable closes" on
// each new lot card — i.e. what other buyers paid for similar inventory in
// the same market.
//
// Storage shape:
//   noltech:arbitrage:lot-history → array of LotHistoryEntry
//
// type LotHistoryEntry = {
//   lotId: string,                // tl-{palletId} from the scraper
//   palletId: string,
//   manifestSlug: string,
//   source: string,               // 'techliquidators.com'
//   title: string,
//   url: string,
//   topCategories: string,
//   topBrands: string,
//   condition: string,
//   itemCount: number,
//   msrpTotal: number,
//   msrpPerUnit: number,
//   firstSeenAt: string (ISO),
//   lastSeenAt:  string (ISO),
//   endsAt: string | null (ISO),  // auction end time when last scraped
//   numBids: number,
//   currentBid: number,           // last seen ask/current bid while active
//   finalBid: number | null,      // captured after auction ended
//   finalBidStatus: 'pending'|'sold'|'no_sale'|'unknown',
//   finalBidCheckedAt: string | null (ISO),
// }

import { pipelineFetch } from './pipelineFetch';
import { parseQuantity } from '../utils/formatters';

const KEY_HISTORY  = 'noltech:arbitrage:lot-history';
const PRUNE_AFTER_DAYS = 180; // keep 6 months of history

async function readHistory() {
  try {
    const v = await window.storage.get(KEY_HISTORY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function writeHistory(history) {
  try {
    await window.storage.set(KEY_HISTORY, history);
  } catch (e) {
    console.error('[lotHistory] write failed:', e);
  }
}

export async function getLotHistory() {
  return readHistory();
}

// Add freshly-scraped lots to history (or update existing entries with the
// latest currentBid/numBids/endsAt). Auto-prunes entries older than 6 months.
// Captures both TechLiquidators AND Liquidation.com lots — the comparable
// matcher only matches within a single source so they don't pollute each other.
export async function captureScrapedLots(lots) {
  if (!Array.isArray(lots) || !lots.length) return;
  const trackedLots = lots.filter((l) => {
    if (!l) return false;
    const src = (l.source || '').toLowerCase();
    return src.includes('techliq') || src.includes('liquidation');
  });
  if (!trackedLots.length) return;

  const history = await readHistory();
  const byLotId = new Map(history.map((h) => [h.lotId, h]));
  const now = new Date().toISOString();

  for (const lot of trackedLots) {
    if (!lot.id) continue;
    // TL needs palletId to fetch closing state; Liquidation needs lot URL.
    if (!lot.palletId && !lot.url) continue;
    const existing = byLotId.get(lot.id);
    const auction = lot.auction || {};
    const estimation = lot.estimation || {};
    const merged = {
      lotId:         lot.id,
      palletId:      lot.palletId || existing?.palletId || null,
      manifestSlug:  lot.manifestSlug || existing?.manifestSlug || '',
      lotUrl:        lot.url || existing?.lotUrl || '',
      source:        lot.source || existing?.source || 'techliquidators.com',
      title:         lot.title || existing?.title || '',
      url:           lot.url || existing?.url || '',
      topCategories: lot.topCategories || existing?.topCategories || '',
      topBrands:     lot.topBrands     || existing?.topBrands     || '',
      condition:     lot.condition     || existing?.condition     || '',
      itemCount:     parseQuantity(lot.quantity) || existing?.itemCount || 0,
      msrpTotal:     parseFloat(lot.msrpTotal) || existing?.msrpTotal || 0,
      msrpPerUnit:   parseFloat(estimation.msrpPerUnit) || existing?.msrpPerUnit || 0,
      firstSeenAt:   existing?.firstSeenAt || now,
      lastSeenAt:    now,
      endsAt:        auction.endsAt || existing?.endsAt || null,
      numBids:       parseInt(auction.numBids) || existing?.numBids || 0,
      currentBid:    parseFloat(auction.currentPrice ?? lot.price) || existing?.currentBid || 0,
      finalBid:          existing?.finalBid          ?? null,
      finalBidStatus:    existing?.finalBidStatus    || 'pending',
      finalBidCheckedAt: existing?.finalBidCheckedAt || null,
    };
    byLotId.set(lot.id, merged);
  }

  // Prune old entries
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400 * 1000;
  const next = Array.from(byLotId.values()).filter((h) => {
    const t = new Date(h.lastSeenAt || h.firstSeenAt || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });

  await writeHistory(next);
}

// Find lots in the history that are due for a closing-price check: their
// endsAt has passed, finalBid is still null, and we haven't checked recently.
export async function findLotsNeedingClosingCheck({ limit = 10, minHoursSinceLastCheck = 6 } = {}) {
  const history = await readHistory();
  const now = Date.now();
  const sinceCutoff = now - minHoursSinceLastCheck * 3600 * 1000;
  const out = [];
  for (const h of history) {
    if (h.finalBid != null) continue;
    if (h.finalBidStatus === 'sold' || h.finalBidStatus === 'no_sale') continue;
    if (!h.endsAt) continue;
    const endTs = new Date(h.endsAt).getTime();
    if (!Number.isFinite(endTs) || endTs > now) continue; // still active
    if (h.finalBidCheckedAt && new Date(h.finalBidCheckedAt).getTime() > sinceCutoff) continue;
    // Skip entries the pipeline couldn't identify a lot from.
    if (!h.lotId && !h.lotUrl) continue;
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

// Update one entry's closing-price state from a pipeline response.
export async function recordClosingState(lotId, state) {
  const history = await readHistory();
  const idx = history.findIndex((h) => h.lotId === lotId);
  if (idx < 0) return;
  history[idx] = {
    ...history[idx],
    finalBid:          state.finalBid != null ? state.finalBid : history[idx].finalBid,
    finalBidStatus:    state.status   || history[idx].finalBidStatus,
    finalBidCheckedAt: state.fetchedAt || new Date().toISOString(),
  };
  await writeHistory(history);
}

// Server-side closing-price poll. Walks N due entries, asks the pipeline for
// each, persists the result, returns a summary. One route for every source:
// the pipeline's lot provider decides how to answer.
export async function pollClosingPrices({ limit = 10, minHoursSinceLastCheck = 6 } = {}) {
  const due = await findLotsNeedingClosingCheck({ limit, minHoursSinceLastCheck });
  let updated = 0; let errors = 0;
  for (const entry of due) {
    const body = { lotId: entry.lotId, lotUrl: entry.lotUrl };
    try {
      // Generous timeout — a provider may be doing a live upstream lookup.
      const r = await pipelineFetch('/api/lots/closing-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(35000),
      });
      const data = await r.json();
      if (data.success) {
        await recordClosingState(entry.lotId, data);
        updated++;
      } else {
        errors++;
      }
    } catch (e) {
      console.warn('[lotHistory] closing-price fetch failed:', e.message);
      errors++;
    }
    // Stagger requests so a poll doesn't burst against whatever upstream the
    // provider talks to. Jittered so repeated polls don't sync up.
    const delay = 2500 + Math.random() * 2500;
    await new Promise((r) => setTimeout(r, delay));
  }
  return { checked: due.length, updated, errors };
}

// ─── Comparable matching ──────────────────────────────────────────────────────
// Given a lot, find historical CLOSED lots (finalBid != null) that are a
// reasonable apples-to-apples comparison. Match criteria:
//   - same source
//   - same primary category (case-insensitive substring)
//   - msrpPerUnit within ±30%
//   - itemCount within ±50% (looser since lot sizes vary more)
//   - same/similar condition (loose match)
// Returns null if fewer than `minSamples` matches.

const HORIZON_DAYS = 90; // only closes from the last 90 days

function normalizeCategory(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[,;|/]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function categoriesOverlap(a, b) {
  if (!a || !b) return false;
  const A = normalizeCategory(a);
  const B = normalizeCategory(b);
  for (const x of A) for (const y of B) {
    if (x === y) return true;
    if (x.includes(y) || y.includes(x)) return true;
  }
  return false;
}

function conditionsCompatible(a, b) {
  if (!a || !b) return true; // unknown ↔ anything is fine
  const norm = (s) => String(s).toLowerCase().trim().replace(/[\s\-/]+/g, '_');
  return norm(a) === norm(b);
}

export async function findComparableCloses(lot, opts = {}) {
  if (!lot) return null;
  const {
    minSamples       = 2,
    msrpTolerance    = 0.30,
    qtyTolerance     = 0.50,
    horizonDays      = HORIZON_DAYS,
    matchCondition   = false,
  } = opts;

  const history = await readHistory();
  const cutoff = Date.now() - horizonDays * 86400 * 1000;
  const lotMsrpPerUnit = parseFloat(lot.estimation?.msrpPerUnit) || 0;
  const lotItemCount   = parseQuantity(lot.quantity) || 0;
  const lotCategory    = lot.topCategories || lot.category || '';

  const matches = history.filter((h) => {
    if (h.finalBid == null || h.finalBid <= 0) return false;
    if (h.finalBidStatus !== 'sold') return false;
    if ((h.source || '').toLowerCase() !== (lot.source || '').toLowerCase()) return false;
    const closedAt = new Date(h.finalBidCheckedAt || h.lastSeenAt || 0).getTime();
    if (closedAt < cutoff) return false;
    if (!categoriesOverlap(h.topCategories, lotCategory)) return false;
    if (lotMsrpPerUnit > 0 && h.msrpPerUnit > 0) {
      const ratio = h.msrpPerUnit / lotMsrpPerUnit;
      if (ratio < 1 - msrpTolerance || ratio > 1 + msrpTolerance) return false;
    }
    if (lotItemCount > 0 && h.itemCount > 0) {
      const ratio = h.itemCount / lotItemCount;
      if (ratio < 1 - qtyTolerance || ratio > 1 + qtyTolerance) return false;
    }
    if (matchCondition && !conditionsCompatible(h.condition, lot.condition)) return false;
    return true;
  });

  if (matches.length < minSamples) return null;

  const prices = matches.map((h) => h.finalBid).sort((a, b) => a - b);
  const median = prices.length % 2
    ? prices[(prices.length - 1) / 2]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const mean = prices.reduce((s, v) => s + v, 0) / prices.length;
  return {
    count: prices.length,
    low:    prices[0],
    high:   prices[prices.length - 1],
    median: Math.round(median * 100) / 100,
    mean:   Math.round(mean * 100) / 100,
    horizonDays,
    samples: matches.map((h) => ({
      lotId: h.lotId, title: h.title, finalBid: h.finalBid,
      itemCount: h.itemCount, msrpPerUnit: h.msrpPerUnit,
      condition: h.condition, closedAt: h.finalBidCheckedAt || h.lastSeenAt,
    })),
  };
}

// Helper to compute comparables for many lots at once (used by BrowseLotsView).
export async function findComparableClosesBulk(lots, opts) {
  const out = {};
  if (!Array.isArray(lots)) return out;
  // Read history once instead of per-lot
  const history = await readHistory();
  for (const lot of lots) {
    out[lot.id] = await findComparableCloses(lot, opts);
  }
  return out;
}

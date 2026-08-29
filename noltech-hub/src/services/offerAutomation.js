// ─── Offer Automation Service ────────────────────────────────────────────
// Shared logic for evaluating + responding to eBay Best Offers. Used by:
//   - OfferManagement.jsx (manual / one-click "Apply rules" flow)
//   - useAutoSync.js (background auto-responder cycle, runs every N min)
//
// Background-mode safety bounds prevent runaway behavior:
//   - dailyMaxAuto      — max actions per UTC day (default 50)
//   - excludedItemIds   — never auto-action these specific listings
//   - dryRun            — log decisions but don't actually call eBay
//   - minHourSinceListed — don't auto-action listings younger than X hours
//                          (gives the buyer time to make a real offer first)
//
// Storage keys:
//   noltech:offers:rules       — rule config (see DEFAULT_RULES below)
//   noltech:offers:log         — array of past actions (capped at 200)
//   noltech:offers:auto-stats  — { today: 'YYYY-MM-DD', autoCount: number }
//                                resets on UTC day rollover

import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../utils/constants';
import { decryptObject } from './crypto';

const RULES_KEY = 'noltech:offers:rules';
const LOG_KEY   = 'noltech:offers:log';
const STATS_KEY = 'noltech:offers:auto-stats';

export const DEFAULT_RULES = {
  enabled: false,
  autoAcceptPct:  90,
  autoCounterPct: 70,
  counterAtPct:   88,
  autoDeclinePct: 60,
  // Background automation (Tier 1 expansion)
  autoBackground: false,
  dailyMaxAuto:   50,
  dryRun:         false,
  minHoursSinceListed: 0,
  excludedItemIds: [],
};

function pctToRatio(pct) { return (pct || 0) / 100; }

function utcDay() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Pure decision function — given an offer + rules, returns the action to
 * take. Used by both manual flow and background cycle. Returns null for
 * offers that fall in the manual-review gap.
 */
export function decideAction(offer, rules) {
  if (!rules.enabled) return null;
  if (!offer.listingPrice || !offer.offerAmount) return null;
  if (Array.isArray(rules.excludedItemIds) && rules.excludedItemIds.includes(offer.itemId)) return null;
  // Don't auto-action super-fresh listings — buyer might make a better
  // offer in the next few hours and you'd accept this one prematurely.
  if (rules.minHoursSinceListed > 0 && offer.listedAt) {
    const ageHr = (Date.now() - new Date(offer.listedAt).getTime()) / 3600000;
    if (ageHr < rules.minHoursSinceListed) return null;
  }
  const ratio = offer.offerAmount / offer.listingPrice;
  if (ratio >= pctToRatio(rules.autoAcceptPct))  return { action: 'Accept' };
  if (ratio < pctToRatio(rules.autoDeclinePct))  return { action: 'Decline' };
  if (ratio >= pctToRatio(rules.autoCounterPct)) return {
    action: 'Counter',
    counterPrice: Math.round(offer.listingPrice * pctToRatio(rules.counterAtPct) * 100) / 100,
  };
  return null;
}

async function loadCreds() {
  const raw = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
  const creds = await decryptObject(raw || {});
  if (!creds?.token) throw new Error('No eBay token configured');
  return creds;
}

/**
 * Fetch pending best offers via the local scraper. Same endpoint the UI
 * uses; just exposed as a callable function.
 */
export async function fetchPendingOffers() {
  const creds = await loadCreds();
  const res = await fetch(`${PIPELINE_BASE}/api/ebay/best-offers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userToken: creds.token,
      appId:  creds.appId  || '',
      devId:  creds.devId  || '',
      certId: creds.certId || '',
    }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Failed to fetch offers');
  return data.offers || [];
}

/**
 * Issue a single accept/decline/counter response to eBay.
 */
export async function respondToOffer(offer, { action, counterPrice, comment }) {
  const creds = await loadCreds();
  const res = await fetch(`${PIPELINE_BASE}/api/ebay/respond-offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userToken: creds.token,
      appId:  creds.appId  || '',
      devId:  creds.devId  || '',
      certId: creds.certId || '',
      itemId:  offer.itemId,
      offerId: offer.offerId,
      action,
      counterPrice,
      comment,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Response failed');
  return data;
}

async function appendLog(entry) {
  try {
    const log = (await window.storage.get(LOG_KEY)) || [];
    log.unshift(entry);
    if (log.length > 200) log.length = 200;
    await window.storage.set(LOG_KEY, log);
  } catch (e) {
    console.error('[offer-automation] log write failed:', e);
  }
}

async function getDailyStats() {
  const today = utcDay();
  const stats = (await window.storage.get(STATS_KEY)) || {};
  if (stats.today !== today) return { today, autoCount: 0 };
  return { today, autoCount: stats.autoCount || 0 };
}

async function incrDailyCount(by = 1) {
  const stats = await getDailyStats();
  stats.autoCount += by;
  try { await window.storage.set(STATS_KEY, stats); } catch {}
  return stats;
}

/**
 * Background cycle entry point. Pulls pending offers, evaluates rules,
 * acts on those that the rules cover, respects daily cap + dry-run.
 *
 * Returns { evaluated, acted, skipped, errored, dryRun, cap } summary for
 * the auto-sync heartbeat / UI display.
 */
export async function runAutoCycle() {
  const rules = { ...DEFAULT_RULES, ...((await window.storage.get(RULES_KEY)) || {}) };
  if (!rules.enabled || !rules.autoBackground) {
    return { skipped: true, reason: 'disabled' };
  }

  // Daily cap check up-front. If we're already at the limit, don't even
  // hit eBay — wait for the UTC day rollover.
  const dailyStats = await getDailyStats();
  if (dailyStats.autoCount >= rules.dailyMaxAuto) {
    return {
      skipped: true,
      reason: 'daily-cap-reached',
      todayCount: dailyStats.autoCount,
      cap: rules.dailyMaxAuto,
    };
  }

  let offers;
  try {
    offers = await fetchPendingOffers();
  } catch (e) {
    return { skipped: true, reason: 'fetch-failed', error: e.message };
  }

  let evaluated = 0;
  let acted = 0;
  let skipped = 0;
  let errored = 0;
  let remainingBudget = rules.dailyMaxAuto - dailyStats.autoCount;

  for (const offer of offers) {
    evaluated++;
    const decision = decideAction(offer, rules);
    if (!decision) { skipped++; continue; }
    if (remainingBudget <= 0) { skipped++; continue; }

    if (rules.dryRun) {
      // Log the would-have-done action but don't call eBay.
      await appendLog({
        offerId: offer.offerId,
        itemId:  offer.itemId,
        action:  `[DRY] ${decision.action}`,
        counterPrice: decision.counterPrice || null,
        buyer:        offer.buyer,
        listingPrice: offer.listingPrice,
        offerAmount:  offer.offerAmount,
        title: offer.listingTitle,
        at:    new Date().toISOString(),
        source: 'auto-bg-dryrun',
      });
      acted++;
      remainingBudget--;
      continue;
    }

    try {
      await respondToOffer(offer, decision);
      await appendLog({
        offerId: offer.offerId,
        itemId:  offer.itemId,
        action:  decision.action,
        counterPrice: decision.counterPrice || null,
        buyer:        offer.buyer,
        listingPrice: offer.listingPrice,
        offerAmount:  offer.offerAmount,
        title: offer.listingTitle,
        at:    new Date().toISOString(),
        source: 'auto-bg',
      });
      acted++;
      remainingBudget--;
      await incrDailyCount(1);
    } catch (e) {
      errored++;
      console.error(`[offer-automation] respond failed for offer ${offer.offerId}:`, e);
    }
  }

  return {
    cycleSkipped: false,
    evaluated,
    acted,
    notActionable: skipped,
    errored,
    dryRun: !!rules.dryRun,
    cap: rules.dailyMaxAuto,
    todayCount: rules.dryRun ? dailyStats.autoCount : (dailyStats.autoCount + acted),
  };
}

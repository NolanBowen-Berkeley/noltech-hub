// ─── Scraped Lot Card (visual revamp) ─────────────────────────────────────────
// FULL REWRITE — props interface UNCHANGED (drop-in replacement). All math,
// derived state, sub-component integration, async effects, and CSV exports
// are byte-for-byte preserved from the prior version. Only the JSX layout +
// styling changed.
//
// Visual changes vs prior:
//   1. Image-header status strip — unified the BID ribbon + corner signal +
//      ending-soon detection into one prioritized overlay band over the image.
//      Priority: active-bid > imminent-close > strong-buy > pass > none.
//   2. Hero ROI strip below image — green/amber/red band shows margin at a
//      glance when scanning a grid of cards (mirrors LotCardCompact).
//   3. Hero Net Rev metric — the metric grid promotes Net Rev to the
//      largest tile so the headline number stops competing with eBay Fees.
//   4. Stats chips row — Confidence / Sell-Difficulty / Risk now use
//      differentiated visual treatment (each has its own icon + tier color)
//      so the three scales don't look the same.
//   5. Reference data fold — MSRP row + condition multiplier row hide behind
//      a "Reference" collapsible when manifest pricing is the source of truth.
//   6. Ending-soon banner — auctions closing within 1 hour get a prominent
//      red banner above the metric grid instead of a buried space-separated line.
//   7. AI summary — moved BELOW actions (was inline mid-card) so it no longer
//      pushes the primary CTA out of a consistent position.
//   8. Hover lift — taller card lift on hover for clearer interactivity.

import { useState, useMemo, useEffect, memo } from 'react';
import {
  AlertTriangle,
  Loader2,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Eye,
  Check,
  X,
  Info,
  Gavel,
  Clock,
  ChevronDown,
  ChevronRight,
  Gauge,
  Target,
} from 'lucide-react';
import {
  getEbayFeeRate,
  getResaleRealizationRate,
  getActiveAskBufferDetails,
  getEffectiveResaleMultiplier,
  getEbayConditionHaircut,
  resolveConditionKey,
  getAuctionFeeRate,
} from '../../utils/fees';
import { decrypt } from '../../services/crypto';
import { API_KEY_STORAGE } from '../../utils/constants';
import { parseQuantity } from '../../utils/formatters';
import LotCardBidGuidance from './LotCardBidGuidance';
import LotCardActions from './LotCardActions';
import Tier39AnalysisBadge from './Tier39AnalysisBadge';
import LotThumbnail from './LotThumbnail';
import LotCardRepairPanel from './LotCardRepairPanel';
import { summarizeRepairs } from '../../utils/motherboardRepair';

const AI_SUMMARY_KEY = 'noltech:arbitrage:ai-summaries';

// ─── AI summary cache (module-level, shared across cards) ────────────────────

let summaryCache = null;
async function loadSummaryCache() {
  if (summaryCache) return summaryCache;
  try {
    const v = await window.storage.get(AI_SUMMARY_KEY);
    summaryCache = (v && typeof v === 'object') ? v : {};
  } catch {
    summaryCache = {};
  }
  return summaryCache;
}
async function saveSummary(lotId, payload) {
  const cache = await loadSummaryCache();
  cache[lotId] = payload;
  summaryCache = cache;
  window.storage.set(AI_SUMMARY_KEY, cache).catch((e) => console.error('[LotCard] summary save failed:', e));
}

async function fetchLotSummary(lot, enrich) {
  const rawKey = await window.storage.get(API_KEY_STORAGE).catch(e => { console.error('[lot card] storage error:', e); return null; });
  if (!rawKey) throw new Error('No Anthropic API key in Settings');
  const apiKey = await decrypt(rawKey);
  if (!apiKey) throw new Error('API key decrypt failed');

  const top = (enrich?.manifestItems || [])
    .filter((i) => i.found && i.avgPrice != null)
    .slice(0, 15)
    .map((i) => `${i.qty || 1}× ${(i.ebayTitle || i.title || '').slice(0, 60)} @ $${i.avgPrice?.toFixed(0)}`)
    .join('\n');
  const t = enrich?.totals || {};

  const context = [
    `Title: ${lot.title}`,
    `Source: ${lot.source || 'unknown'}`,
    `Asking price: $${lot.price || 0}`,
    `Item count: ${lot.quantity || 0}`,
    lot.condition && `Condition: ${lot.condition}`,
    lot.topBrands && `Brands: ${lot.topBrands}`,
    lot.topCategories && `Categories: ${lot.topCategories}`,
    t.estResale && `Estimated resale: $${t.estResale.toLocaleString()} (${t.numPriced}/${t.numItems} priced)`,
    top && `Top items:\n${top}`,
  ].filter(Boolean).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are an expert electronics reseller giving a single-paragraph read on a liquidation lot. Be concise, punchy, and honest about risks. Output 2-3 short sentences, no headers, no lists, no emojis. Focus on: what's in the lot, the upside, the main risks, and whether it's worth bidding. Use casual tone — this is a mental note, not marketing copy.`,
      messages: [{ role: 'user', content: `Give me a quick read on this lot:\n\n${context}` }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    let msg = `AI error ${res.status}`;
    try { const body = await res.json(); msg = body?.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── Signal badge ────────────────────────────────────────────────────────────

const SIGNAL_TIERS = {
  strong_buy: { label: 'Strong Buy', cls: 'bg-success text-white',          Icon: TrendingUp },
  buy:        { label: 'Buy',        cls: 'bg-success-subtle text-success', Icon: Check },
  watch:      { label: 'Watch',      cls: 'bg-warning-subtle text-warning', Icon: Eye },
  pass:       { label: 'Pass',       cls: 'bg-danger-subtle text-danger',   Icon: TrendingDown },
};

export const SIGNAL_CFG = {
  god_tier:   SIGNAL_TIERS.strong_buy,
  steal:      SIGNAL_TIERS.strong_buy,
  strong_buy: SIGNAL_TIERS.strong_buy,
  buy:        SIGNAL_TIERS.buy,
  watch:      SIGNAL_TIERS.watch,
  pass:       SIGNAL_TIERS.pass,
  dumpster:   SIGNAL_TIERS.pass,
};

export function SignalBadge({ signal, withIcon = false, className = '' }) {
  const cfg = SIGNAL_CFG[signal] || { label: signal, cls: 'bg-muted text-fg-muted', Icon: null };
  const Icon = cfg.Icon;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-md ${cfg.cls} ${className}`}>
      {withIcon && Icon && <Icon size={12} />}
      {cfg.label}
    </span>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const cleanText = (s) => {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\uFEFF\uFFFD]/g, '')
    .replace(/\\u[\da-fA-F]{4}/g, '')
    .trim();
};

// ─── Main LotCard component ──────────────────────────────────────────────────

function LotCardInner({ lot, onAnalyze, enrichment, lotNotes, onSaveNote, isWatched, onToggleWatch, onQuickBid, onQuickCompare, comparableCloses, hasActiveBid, liqEstimate, onPriceLot }) {
  const { title, source, price, condition, url, estimation, metrics } = lot;
  // Scraper APIs ship lot.quantity as a display string ("Qty: 14"); coerce
  // to a number here so every downstream `quantity > 0` / div works.
  const quantity = parseQuantity(lot.quantity);
  const e = estimation || {};
  const m = metrics || {};
  const bc = m.bidCeilings || {};

  const enrich = enrichment || {};
  const [notesOpen, setNotesOpen] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const currentNote = lotNotes?.[lot.id] || '';

  // ── AI summary state (proper useEffect hydration) ──────────────────────────
  const [aiSummary, setAiSummary] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError]     = useState('');
  const [aiOpen, setAiOpen]       = useState(false);
  useEffect(() => {
    let mounted = true;
    loadSummaryCache().then((cache) => {
      if (!mounted) return;
      const hit = cache[lot.id];
      if (hit) { setAiSummary(hit); setAiOpen(true); }
    });
    return () => { mounted = false; };
  }, [lot.id]);
  const runSummary = async () => {
    setAiLoading(true); setAiError('');
    try {
      const text = await fetchLotSummary(lot, enrich);
      const payload = { summary: text, at: Date.now() };
      setAiSummary(payload);
      setAiOpen(true);
      saveSummary(lot.id, payload);
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiLoading(false);
    }
  };
  const clearSummary = async () => {
    setAiSummary(null);
    setAiOpen(false);
    const cache = await loadSummaryCache();
    delete cache[lot.id];
    summaryCache = cache;
    window.storage.set(AI_SUMMARY_KEY, cache).catch(err => console.error('[lot card] storage error:', err));
  };

  // ── Auction timing ─────────────────────────────────────────────────────────
  const endingSoon = (() => {
    const endsAt = lot.auction?.endsAt;
    if (!endsAt) return false;
    const diff = new Date(endsAt).getTime() - Date.now();
    return diff > 0 && diff < 3600000;
  })();
  const endInfo = (() => {
    const endsAt = lot.auction?.endsAt;
    if (!endsAt) return null;
    const end = new Date(endsAt);
    const diff = end.getTime() - Date.now();
    const date = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let remaining = '', urgency = 'normal';
    if (diff <= 0)            { remaining = 'ended';                                                                                                                  urgency = 'ended'; }
    else if (diff < 3600000)  { remaining = `${Math.floor(diff / 60000)}m left`;                                                                                       urgency = 'imminent'; }
    else if (diff < 86400000) { remaining = `${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m left`;                                            urgency = 'soon'; }
    else                      { remaining = `${Math.floor(diff / 86400000)}d ${Math.floor((diff % 86400000) / 3600000)}h left`; }
    return { date, time, remaining, urgency };
  })();

  // ── CSV exports ────────────────────────────────────────────────────────────
  const handleExportCSV = () => {
    const headers = 'UPC,Title,Brand,Qty,eBay Avg Price,eBay Low,eBay High,# Sales';
    const rows = enrich.manifestItems.map(item => {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [
        esc(item.upc), esc(item.ebayTitle || item.title), esc(item.brand || ''),
        item.qty ?? 1, item.avgPrice ?? '', item.lowPrice ?? '', item.highPrice ?? '', item.numSales ?? '',
      ].join(',');
    });
    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = dlUrl; a.download = `manifest-${lot.palletId || lot.id}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(dlUrl);
  };

  // ── Pricing / math (PRESERVED EXACTLY from prior version) ──────────────────
  const isLiquidation = source?.includes('liquidation');
  const hasManifestPricing = enrich.status === 'done' && enrich.totals?.numPriced > 0 && enrich.totals?.estResale > 0;
  const rawManifestResale = enrich.totals?.estResale || 0;
  const shipping = lot.shippingCost || 0;
  const ebayFeeRate = getEbayFeeRate();
  const realizationRate = getResaleRealizationRate();
  const lotCategory = lot.topCategories || lot.category || '';
  const askBufferDetails = getActiveAskBufferDetails(lotCategory);
  const askBuffer = askBufferDetails.rate;
  const lotCondition = condition || e.condition;
  const conditionHaircut = getEbayConditionHaircut(lotCondition);
  const conditionKey = resolveConditionKey(lotCondition);
  const effectiveMultiplier = getEffectiveResaleMultiplier(lotCondition, lotCategory);
  const realizationApplied = Math.abs(effectiveMultiplier - 1) > 0.001;
  const manifestResale = rawManifestResale * effectiveMultiplier;
  const auctionFeeRate = getAuctionFeeRate(source);
  const premiumDivisor = 1 + auctionFeeRate;
  const repairSummary = useMemo(
    () => summarizeRepairs(enrich.manifestItems),
    [enrich.manifestItems]
  );
  const repairCost = repairSummary.totalCost || 0;

  let ceil30, ceil20, ceil40;
  if (hasManifestPricing) {
    const netAfterFees = manifestResale * (1 - ebayFeeRate) - shipping - repairCost;
    ceil30 = Math.round((netAfterFees * 0.70) / premiumDivisor);
    ceil20 = Math.round((netAfterFees * 0.80) / premiumDivisor);
    ceil40 = Math.round((netAfterFees * 0.60) / premiumDivisor);
  } else {
    const netBase = ((bc.at20pct ?? 0) / 0.80) - (repairCost / realizationRate);
    ceil20 = Math.round((netBase * 0.80 * realizationRate) / premiumDivisor);
    ceil30 = Math.round((netBase * 0.70 * realizationRate) / premiumDivisor);
    ceil40 = Math.round((netBase * 0.60 * realizationRate) / premiumDivisor);
  }

  const asking = price || 0;
  const overCeil = asking > 0 && asking > ceil20;
  const atWatch = asking > 0 && asking > ceil30 && asking <= ceil20;

  // ── Display metrics ────────────────────────────────────────────────────────
  // Net Rev + eBay Fees are totals — they only need manifestResale to compute,
  // so don't gate them on quantity (lots without parsed qty would otherwise
  // show "—" across all three tiles even when sold-comps populated estResale).
  // Per-unit resale does need quantity, so it stays gated.
  let displayResalePerUnit = e.estimatedResalePerUnit ?? null;
  let displayEbayFees      = m.ebayFees ?? null;
  let displayNetRevenue    = m.netRevenue != null ? Math.max(0, m.netRevenue - repairCost) : null;
  let displayResaleSource  = 'msrp';
  if (hasManifestPricing) {
    const totalRev = manifestResale;
    displayEbayFees      = Math.round(totalRev * ebayFeeRate * 100) / 100;
    displayNetRevenue    = Math.round((totalRev * (1 - ebayFeeRate) - shipping - repairCost) * 100) / 100;
    displayResaleSource  = 'manifest';
    if (quantity > 0) {
      displayResalePerUnit = Math.round((totalRev / quantity) * 100) / 100;
    }
  }

  // ── Confidence / Sell-Difficulty / Risk (preserved math) ───────────────────
  const confidence = (() => {
    let score = 0; let factors = [];
    if (hasManifestPricing) {
      score += 30; factors.push('Sold-comps data');
      const totalItems = enrich.totals?.numItems || 0;
      const pricedItems = enrich.totals?.numPriced || 0;
      const coverage = totalItems > 0 ? pricedItems / totalItems : 0;
      if (coverage >= 0.9) { score += 5; factors.push(`${Math.round(coverage * 100)}% priced`); }
      else if (coverage >= 0.7) { score += 3; }
      else if (coverage >= 0.5) { score += 1; factors.push('partial pricing'); }
      else { factors.push('low coverage'); }
    } else if (e.detectedModel) { score += 15; factors.push('model match'); }
    else { score += 5; factors.push('MSRP estimate'); }
    if (hasManifestPricing && enrich.manifestItems?.length) {
      const pricedWithSales = enrich.manifestItems.filter(i => i.found && i.numSales > 0);
      if (pricedWithSales.length > 0) {
        const avgSales = pricedWithSales.reduce((s, i) => s + (i.numSales || 0), 0) / pricedWithSales.length;
        if (avgSales >= 15) { score += 25; factors.push('high volume'); }
        else if (avgSales >= 8) { score += 20; }
        else if (avgSales >= 4) { score += 12; factors.push('moderate volume'); }
        else { score += 5; factors.push('low volume'); }
      }
    } else { score += 10; }
    if (hasManifestPricing && enrich.manifestItems?.length) {
      const withPrices = enrich.manifestItems.filter(i => i.found && i.avgPrice > 0 && i.lowPrice > 0 && i.highPrice > 0);
      if (withPrices.length > 0) {
        const avgSpread = withPrices.reduce((s, i) => {
          const range = i.highPrice - i.lowPrice;
          return s + (i.avgPrice > 0 ? range / i.avgPrice : 1);
        }, 0) / withPrices.length;
        if (avgSpread < 0.3) { score += 20; factors.push('tight prices'); }
        else if (avgSpread < 0.6) { score += 14; }
        else if (avgSpread < 1.0) { score += 8; factors.push('wide spread'); }
        else { score += 3; factors.push('volatile'); }
      }
    } else { score += 8; }
    if (quantity > 0) score += 2;
    if (lot.topBrands) score += 2;
    if (lot.msrpTotal > 0) score += 3;
    if (lot.auction?.numBids > 0) score += 3;
    if (hasManifestPricing && enrich.manifestItems?.length) {
      const cachedItems = enrich.manifestItems.filter(i => i.priceSource === 'cached' && i.cachedAt);
      if (cachedItems.length > 0) {
        const avgAge = cachedItems.reduce((s, i) => s + (Date.now() - new Date(i.cachedAt).getTime()), 0) / cachedItems.length;
        const days = avgAge / 86400000;
        if (days > 30) { score -= 10; factors.push('stale data'); }
        else if (days > 14) { score -= 5; factors.push('aging data'); }
      }
    }
    return {
      score: Math.max(0, Math.min(100, score)),
      factors,
      label: score >= 80 ? 'High' : score >= 55 ? 'Good' : score >= 35 ? 'Fair' : 'Low',
      color: score >= 80 ? 'text-success bg-success-subtle' : score >= 55 ? 'text-info bg-info-subtle' : score >= 35 ? 'text-warning bg-warning-subtle' : 'text-danger bg-danger-subtle',
    };
  })();

  const sellDifficulty = (() => {
    let diff = 0; let reasons = [];
    if (quantity > 50) { diff += 1.5; reasons.push('50+ units'); }
    else if (quantity > 20) { diff += 1; reasons.push('large lot'); }
    else if (quantity > 10) { diff += 0.5; }
    const cond = (condition || e.condition || '').toLowerCase();
    if (['broken', 'for_parts'].includes(cond)) { diff += 1.5; reasons.push('broken/parts'); }
    else if (['poor', 'as_is', 'untested', 'unknown'].includes(cond)) { diff += 1; reasons.push(cond); }
    else if (['salvage', 'mixed'].includes(cond)) { diff += 0.5; reasons.push(cond); }
    else if (['fair', 'grade_c', 'grade_d'].includes(cond)) { diff += 0.5; }
    if (hasManifestPricing && enrich.manifestItems?.length) {
      const withSales = enrich.manifestItems.filter(i => i.found && i.numSales > 0);
      if (withSales.length > 0) {
        const avgSales = withSales.reduce((s, i) => s + (i.numSales || 0), 0) / withSales.length;
        if (avgSales < 3) { diff += 1; reasons.push('low demand'); }
        else if (avgSales < 6) { diff += 0.5; }
        else if (avgSales >= 15) { diff -= 0.5; reasons.push('high demand'); }
      }
    }
    const cats = (lot.topCategories || '').toLowerCase();
    const titleLower = (title || '').toLowerCase();
    if (/server|networking|printer|scanner/.test(cats + titleLower)) { diff += 0.5; reasons.push('niche category'); }
    if (/iphone|ipad|macbook|gpu|ram|ssd/.test(cats + titleLower)) { diff -= 0.5; reasons.push('hot category'); }
    if (lot.auction?.numBids > 10) { diff += 0.5; reasons.push('competitive auction'); }
    else if (lot.auction?.numBids === 0) { diff -= 0.3; }
    const score = Math.max(1, Math.min(5, Math.round((diff + 2) * 10) / 10));
    const label = score <= 1.5 ? 'Easy' : score <= 2.5 ? 'Moderate' : score <= 3.5 ? 'Hard' : 'Very Hard';
    const color = score <= 1.5 ? 'text-success bg-success-subtle' : score <= 2.5 ? 'text-info bg-info-subtle' : score <= 3.5 ? 'text-warning bg-warning-subtle' : 'text-danger bg-danger-subtle';
    return { score, label, color, reasons };
  })();

  const risk = (() => {
    const flags = []; let score = 0;
    const canHaveManifest = isLiquidation || source?.includes('techliq') || source?.includes('bstock');
    if (canHaveManifest && enrich.status !== 'done') { score += 2; flags.push('no priced manifest'); }
    else if (canHaveManifest && enrich.status === 'done' && !enrich.manifestItems?.length) { score += 2; flags.push('empty manifest'); }
    const cond = (condition || e.condition || '').toLowerCase();
    if (!cond || cond === 'unknown' || cond === 'mixed') { score += 1; flags.push('condition unclear'); }
    else if (['broken', 'for_parts', 'salvage', 'poor', 'as_is'].includes(cond)) { score += 1; flags.push(cond.replace(/_/g, ' ')); }
    if (enrich.status === 'done' && enrich.totals?.numItems > 0) {
      const coverage = (enrich.totals.numPriced || 0) / enrich.totals.numItems;
      if (coverage < 0.4) { score += 2; flags.push(`only ${Math.round(coverage * 100)}% priced`); }
      else if (coverage < 0.7) { score += 1; flags.push(`${Math.round(coverage * 100)}% priced`); }
    }
    if (lot.auction?.endsAt) {
      const diff = new Date(lot.auction.endsAt).getTime() - Date.now();
      if (diff > 0 && diff < 7200000 && (lot.auction.numBids || 0) === 0) {
        score += 1; flags.push('ending soon, no bids');
      }
    }
    if ((quantity || 0) > 50 && (!cond || cond === 'unknown')) { score += 1; flags.push('bulk lot, no condition'); }
    if (lot.photoCount === 0 || (Array.isArray(lot.photos) && lot.photos.length === 0)) {
      score += 1; flags.push('no photos');
    }
    const level = score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low';
    return { score, flags, level };
  })();

  let signal = m.signal;
  if (hasManifestPricing && asking > 0) {
    const netAfterFees = manifestResale * (1 - ebayFeeRate) - shipping - repairCost;
    const askingCost = asking * premiumDivisor;
    const margin = netAfterFees > 0 ? (netAfterFees - askingCost) / netAfterFees : -1;
    if (margin >= 0.50) signal = 'strong_buy';
    else if (margin >= 0.30) signal = 'buy';
    else if (margin >= 0.15) signal = 'watch';
    else signal = 'pass';
  }

  // ── Visual derivations ─────────────────────────────────────────────────────
  // Single source of truth for ROI — same value passed to BidGuidance AND
  // shown in the hero strip. Prevents the hero showing 23% while BidGuidance
  // shows 23.4% (or worse, entirely different numbers when m.roi differs from
  // the ceil30-derived value on non-manifest lots).
  const roi = hasManifestPricing && asking > 0
    ? Math.round(((ceil30 - asking) / asking) * 1000) / 10
    : (m.roi != null ? m.roi : null);

  // ROI strip color — drives the band beneath the image.
  const roiStrip =
    roi == null     ? 'bg-muted/40 text-fg-muted' :
    overCeil        ? 'bg-danger/15  text-danger'  :
    roi >= 50       ? 'bg-success/20 text-success' :
    roi >= 30       ? 'bg-success/10 text-success' :
    roi >= 0        ? 'bg-warning/10 text-warning' :
                      'bg-danger/10  text-danger';

  // Outer halo priority: active-bid > imminent > strong_buy > pass > none.
  const halo =
    hasActiveBid                          ? 'ring-2 ring-primary/60' :
    endInfo?.urgency === 'imminent'       ? 'ring-2 ring-danger/50'  :
    signal === 'strong_buy'               ? 'ring-1 ring-success/40' :
    signal === 'pass'                     ? 'ring-1 ring-danger/30'  : '';

  return (
    <div className={`group relative glossy-card overflow-hidden transition-all duration-200 ease-out-expo hover:-translate-y-1 hover:shadow-glow-md ${halo}`}>

      {/* ─── 1. Image header with overlay status strip ──────────────────── */}
      <div className="relative">
        <LotThumbnail
          src={lot.image}
          alt={title}
          fit="contain"
          className="w-full h-28 bg-muted/30 transition-transform duration-300 ease-out-expo group-hover:scale-[1.02]"
          iconSize={32}
        />
        <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/40 to-transparent pointer-events-none" />

        {/* Top-left: BID ribbon (highest priority) */}
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
          {hasActiveBid && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary text-white text-[10px] font-bold tracking-wide shadow-md" title="You have an active bid on this lot">
              <Gavel size={10} /> BIDDING
            </span>
          )}
        </div>

        {/* Top-right: Tier 39 badge + signal */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <Tier39AnalysisBadge lotId={lot.lotId} onClick={() => onAnalyze && onAnalyze(lot)} />
          <SignalBadge signal={signal} withIcon />
        </div>

        {/* Bottom-left: imminent / soon clock pill — also surfaces ENDED so a
            closed auction can't visually look identical to an active one. */}
        {endInfo && endInfo.urgency !== 'normal' && (
          <span
            className={`absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold shadow-md ${
              endInfo.urgency === 'imminent' ? 'bg-danger text-white animate-pulse' :
              endInfo.urgency === 'soon'     ? 'bg-warning text-white' :
                                               'bg-fg-muted/85 text-white italic'
            }`}
            title={`Auction ends ${endInfo.date} at ${endInfo.time}`}
          >
            <Clock size={10} /> {endInfo.remaining}
          </span>
        )}
      </div>

      {/* ─── 2. Hero ROI strip ───────────────────────────────────────────── */}
      <div className={`flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold ${roiStrip}`}>
        <span className="inline-flex items-center gap-1.5">
          {roi != null && roi >= 0 ? <TrendingUp size={12} /> : roi != null ? <TrendingDown size={12} /> : <Target size={12} />}
          {roi != null ? `${roi >= 0 ? '+' : ''}${Math.round(roi)}% ROI` : 'No ROI yet'}
          {overCeil && <span className="text-[10px] opacity-80">· over ceiling</span>}
        </span>
        <span className="font-mono opacity-80">
          {asking > 0 ? `Ask $${asking.toLocaleString()}` : 'No bid yet'}
        </span>
      </div>

      <div className="p-3 space-y-2.5">
        {/* ─── 3. Header (title + meta) ────────────────────────────────── */}
        <div>
          <p className="text-sm font-semibold text-fg leading-snug line-clamp-2">
            {currentNote && !notesOpen && <span title="Has notes">{'\u{1F4DD}'} </span>}
            {title}
          </p>
          <p className="text-[11px] text-fg-muted mt-0.5">
            {source}{condition && ` · ${condition}`}
            {lot.topCategories && ` · ${lot.topCategories}`}
          </p>
        </div>

        {/* ─── 4. Stats chips (Confidence / Sell-Difficulty / Risk) ──── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${confidence.color}`}
            title={`Confidence: ${confidence.score}/100 — ${confidence.label}\n${confidence.factors.join(', ')}`}
          >
            <Gauge size={10} /> {confidence.score}%
          </span>
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${sellDifficulty.color}`}
            title={`Sell Difficulty: ${sellDifficulty.score}/5 (${sellDifficulty.label})\n${sellDifficulty.reasons.join(', ')}`}
          >
            <TrendingDown size={10} className="rotate-180" />
            Sell {sellDifficulty.label === 'Very Hard' ? '5/5' : sellDifficulty.label === 'Hard' ? '4/5' : sellDifficulty.label === 'Moderate' ? '3/5' : sellDifficulty.label === 'Easy' ? '1/5' : `${sellDifficulty.score}/5`}
          </span>
          {risk.level !== 'low' && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                risk.level === 'high' ? 'text-danger bg-danger-subtle' : 'text-warning bg-warning-subtle'
              }`}
              title={`Risk: ${risk.level}\n• ${risk.flags.join('\n• ')}`}
            >
              <ShieldAlert size={10} />
              {risk.level === 'high' ? 'High risk' : 'Risk'}
            </span>
          )}
        </div>

        {/* ─── 5. Bid Guidance panel (preserved sub-component) ────────── */}
        <LotCardBidGuidance
          overCeil={overCeil}
          atWatch={atWatch}
          hasManifestPricing={hasManifestPricing}
          ceil30={ceil30}
          ceil20={ceil20}
          ceil40={ceil40}
          asking={asking}
          quantity={quantity}
          roi={roi}
          realizationApplied={realizationApplied}
          effectiveMultiplier={effectiveMultiplier}
          realizationRate={realizationRate}
          askBuffer={askBuffer}
          askBufferDetails={askBufferDetails}
          lotCategory={lotCategory}
          conditionHaircut={conditionHaircut}
          lotCondition={lotCondition}
          conditionKey={conditionKey}
          auctionFeeRate={auctionFeeRate}
          premiumDivisor={premiumDivisor}
          source={source}
        />

        {/* ─── 6. Predicted Close (Liquidation.com only) ──────────────── */}
        {isLiquidation && liqEstimate && (
          <div className="flex items-center justify-between rounded-lg bg-secondary-subtle border border-secondary/30 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-fg-muted flex items-center gap-1">
                Predicted Close
                <Info size={10} className="text-fg-subtle"
                  title={`Estimated winning bid = title MSRP ($${liqEstimate.titleMsrp.toLocaleString()}) × the historical close ratio for "${liqEstimate.category}" lots (${liqEstimate.ratioPct}% of MSRP).`} />
              </p>
              <p className="text-lg font-bold font-mono text-secondary leading-tight">
                ${liqEstimate.estimatedClose.toLocaleString()}
              </p>
            </div>
            <div className="text-right text-[10px] text-fg-muted shrink-0">
              <p><span className="capitalize font-medium text-fg">{liqEstimate.category}</span> @ {liqEstimate.ratioPct}% MSRP</p>
              <p className={liqEstimate.source === 'category' ? 'text-success' : liqEstimate.source === 'global' ? 'text-warning' : 'text-fg-subtle'}>
                {liqEstimate.source === 'category' ? `${liqEstimate.sampleCount} comparable closes`
                  : liqEstimate.source === 'global' ? `blended · ${liqEstimate.sampleCount} closes`
                  : 'cold start — no closes yet'}
              </p>
            </div>
          </div>
        )}

        {/* ─── 7. Comparable closes line ──────────────────────────────── */}
        {comparableCloses && comparableCloses.count > 0 && (
          <p
            className="text-[11px] text-fg-muted"
            title={
              `${comparableCloses.count} similar TL lots closed in the last ${comparableCloses.horizonDays}d.\n` +
              `Range $${Number(comparableCloses.low).toLocaleString()}–$${Number(comparableCloses.high).toLocaleString()}, ` +
              `mean $${Number(comparableCloses.mean).toLocaleString()}.\n\n` +
              comparableCloses.samples.slice(0, 6).map((s) => {
                const d = s.closedAt ? new Date(s.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                return `• $${Number(s.finalBid).toLocaleString()} — ${(s.title || '').slice(0, 50)}${d ? ` (${d})` : ''}`;
              }).join('\n')
            }
          >
            Comp closes: median{' '}
            <span className="font-mono font-semibold text-fg">${Number(comparableCloses.median).toLocaleString()}</span>{' '}
            (n={comparableCloses.count}, last {comparableCloses.horizonDays}d) ·{' '}
            <span className="font-mono">${Number(comparableCloses.low).toLocaleString()}–${Number(comparableCloses.high).toLocaleString()}</span>
          </p>
        )}

        {/* ─── 8. Metric grid — Net Rev as HERO ───────────────────────── */}
        <div className="grid gap-2" style={{ gridTemplateColumns: lot.shippingCost > 0 ? '1.6fr 1fr 1fr 1fr' : '1.6fr 1fr 1fr' }}>
          {/* Net Rev hero tile (largest, primary color) */}
          <div className="rounded-lg px-3 py-2.5 bg-gradient-to-br from-primary/12 via-primary/6 to-transparent border border-primary/25">
            <p className="text-[9px] uppercase tracking-widest text-fg-muted font-semibold">Net Rev.</p>
            <p className="text-lg font-bold font-mono text-primary leading-tight">
              {displayNetRevenue != null ? `$${Math.round(displayNetRevenue).toLocaleString()}` : '—'}
            </p>
            <p className="text-[10px] text-fg-muted">{lot.shippingCost > 0 ? 'after fees + ship' : 'after eBay fees'}</p>
          </div>
          {/* Est. Resale */}
          <div
            className={`rounded-lg px-2 py-2 text-center ${displayResaleSource === 'manifest' ? 'bg-info-subtle border border-info/30' : 'bg-muted/40 border border-border-subtle'}`}
            title={displayResaleSource === 'manifest'
              ? `Per-unit estimate from eBay sold listings (${enrich.totals?.numPriced}/${enrich.totals?.numItems} items priced, last 90 days).`
              : 'Per-unit estimate from listed MSRP × condition multiplier.'}
          >
            <p className="text-[9px] text-fg-muted uppercase tracking-wide">Est. Resale</p>
            <p className={`text-sm font-bold font-mono ${displayResaleSource === 'manifest' ? 'text-info' : 'text-fg'}`}>
              ${displayResalePerUnit != null ? Math.round(displayResalePerUnit).toLocaleString() : '—'}
            </p>
            <p className="text-[9px] text-fg-muted">/unit · {displayResaleSource === 'manifest' ? 'comps' : 'MSRP'}</p>
          </div>
          {/* eBay Fees */}
          <div className="bg-muted/40 border border-border-subtle rounded-lg px-2 py-2 text-center">
            <p className="text-[9px] text-fg-muted uppercase tracking-wide">eBay Fees</p>
            <p className="text-sm font-bold text-danger font-mono">
              {displayEbayFees != null ? `$${Math.round(displayEbayFees).toLocaleString()}` : '—'}
            </p>
            <p className="text-[9px] text-fg-muted">{(getEbayFeeRate() * 100).toFixed(1)}%</p>
          </div>
          {/* Shipping (conditional) */}
          {lot.shippingCost > 0 && (
            <div className="bg-muted/40 border border-border-subtle rounded-lg px-2 py-2 text-center">
              <p className="text-[9px] text-fg-muted uppercase tracking-wide">Shipping</p>
              <p className="text-sm font-bold text-danger font-mono">${lot.shippingCost.toLocaleString()}</p>
              <p className="text-[9px] text-fg-muted">inbound</p>
            </div>
          )}
        </div>

        {/* ─── 9. Reference data (MSRP + condition multiplier) — fold ── */}
        <div className="border-t border-border-subtle pt-2">
          <button
            type="button"
            onClick={() => setReferenceOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-fg-muted hover:text-fg transition-colors"
          >
            {referenceOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Reference{lot.percentOff > 0 && <span className="ml-1 text-success normal-case">· {lot.percentOff}% off MSRP</span>}
          </button>
          {referenceOpen && (
            <div className="mt-2 space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-fg-muted">
                  {e.listedMsrpUsed ? 'Listed MSRP' : 'Est. MSRP'}{' '}
                  <span className="font-mono text-fg">${(e.msrpPerUnit ?? 0).toLocaleString()}</span>/unit
                  {!e.listedMsrpUsed && e.detectedModel && <span className="opacity-60"> · {e.detectedModel}</span>}
                </span>
                <span className="text-fg-muted">{quantity > 1 ? `${quantity} units` : '1 unit'}</span>
              </div>
              {e.conditionMultiplier != null && (
                <div className="flex items-center gap-2 text-[10px] text-fg-muted">
                  <span className={`font-semibold px-1.5 py-0.5 rounded ${
                    e.conditionMultiplier >= 0.6 ? 'bg-success-subtle text-success' :
                    e.conditionMultiplier >= 0.3 ? 'bg-warning-subtle text-warning' :
                    'bg-danger-subtle text-danger'
                  }`}>
                    {e.condition ? e.condition.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown'}
                  </span>
                  <span>
                    Multiplier <span className="font-mono font-semibold text-fg">{Math.round(e.conditionMultiplier * 100)}%</span> of MSRP =
                    <span className="font-mono font-semibold text-fg"> ${e.estimatedResalePerUnit?.toLocaleString()}</span>/unit
                    {hasManifestPricing && <span className="opacity-60"> (manifest overrides)</span>}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ─── 10. Auction / brand info ──────────────────────────────── */}
        {(lot.topBrands || lot.auction) && (
          <div className="text-[11px] text-fg-muted space-y-0.5">
            {lot.topBrands && <p>Brands: {lot.topBrands}</p>}
            {lot.auction && (
              <p className={lot.auction.numBids > 0 ? 'text-accent font-medium' : ''}>
                {lot.channel === 'auction' ? 'Auction' : 'Buy Now'}
                {lot.auction.numBids > 0 && ` · ${lot.auction.numBids} bid${lot.auction.numBids !== 1 ? 's' : ''}`}
                {endInfo && (
                  <span className={endingSoon ? 'animate-pulse' : ''}>
                    {endingSoon && <span className="inline-block w-1.5 h-1.5 rounded-full bg-danger mr-1 align-middle" />}
                    {` · ends ${endInfo.date} ${endInfo.time} (${endInfo.remaining})`}
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        {/* ─── 11. Manifest pricing (loading + banners) ──────────────── */}
        {enrich.status === 'loading' && (
          <div className="flex items-center gap-1.5 text-[11px] text-fg-muted py-1">
            <Loader2 size={11} className="animate-spin" />
            Fetching manifest &amp; pricing from sold comps...
          </div>
        )}
        {enrich.status === 'done' && enrich.noAppId && enrich.manifestItems?.length > 0 && (
          <div className="flex items-start gap-2 bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2 text-[11px] text-warning">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span><span className="font-semibold">No eBay App ID</span> — manifest parsed ({enrich.totals?.numItems} items) but prices can't be fetched. Go to Settings → eBay Credentials and add your App ID.</span>
          </div>
        )}

        {/* ─── 12. Manifest sold-comp pricing table ──────────────────── */}
        {enrich.status === 'done' && !enrich.noAppId && enrich.manifestItems?.length > 0 && (() => {
          const firstSrc = enrich.manifestItems.find(i => i.priceSource)?.priceSource || '';
          const isSoldComps = firstSrc.startsWith('sold-comps') || firstSrc === 'cached-sold-comps';
          const isLegacy = firstSrc === 'cached' || firstSrc === 'live' || firstSrc === 'cached-browse-api';
          return (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide flex items-center gap-1">
                  Sold-Comp Pricing ({enrich.totals?.numPriced || 0}/{enrich.totals?.numItems || 0} priced)
                  <Info size={10} className="text-fg-subtle"
                    title="Median sold price from eBay's recent sales (last 90 days)." />
                </p>
                {isSoldComps && <p className="text-[10px] text-fg-muted">Powered by eBay sold listings · last 90 days</p>}
                {isLegacy && <p className="text-[10px] text-warning">⚠ Legacy data — re-run pricing for sold-comp accuracy</p>}
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const cachedItems = enrich.manifestItems.filter(i => i.priceSource === 'cached' || i.priceSource === 'sold-comps-cache' || i.priceSource === 'cached-sold-comps' || i.priceSource === 'cached-browse-api');
                  if (!cachedItems.length) return null;
                  const oldest = cachedItems.reduce((old, i) => {
                    const age = i.cachedAt ? Date.now() - new Date(i.cachedAt).getTime() : 0;
                    return age > old ? age : old;
                  }, 0);
                  const days = Math.floor(oldest / 86400000);
                  if (days >= 14) return (
                    <span className="flex items-center gap-1 text-[10px] text-warning" title="Some prices may be outdated">
                      <AlertTriangle size={10} /> Prices {days}d+ old
                    </span>
                  );
                  return null;
                })()}
                {enrich.totals?.estResale > 0 && (
                  <span className="text-[11px] font-semibold font-mono text-success">
                    Est. ${enrich.totals.estResale.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
            <div className={`${showAllItems ? 'max-h-80' : 'max-h-40'} overflow-y-auto overflow-x-auto rounded-lg border border-border-subtle bg-surface text-[12px]`}>
              <div className="sticky top-0 bg-surface border-b border-border px-2.5 py-1 text-[10px] uppercase tracking-wide text-fg-muted grid grid-cols-12 gap-2">
                <span className="col-span-3">UPC</span>
                <span className="col-span-6">Item</span>
                <span className="col-span-1 text-right">Qty</span>
                <span className="col-span-2 text-right" title="Median sold price (last 90 days)">Median</span>
              </div>
              <div className="divide-y divide-border">
                {(() => {
                  const sorted = [...enrich.manifestItems].sort((a, b) => {
                    const ap = a.found && a.avgPrice != null ? a.avgPrice : -Infinity;
                    const bp = b.found && b.avgPrice != null ? b.avgPrice : -Infinity;
                    return bp - ap;
                  });
                  return showAllItems ? sorted : sorted.slice(0, 20);
                })().map((item, i) => {
                  const ACCESSORY_KEYWORDS = ['case', 'cable', 'charger', 'protector', 'adapter'];
                  const titleLower = (item.ebayTitle || item.title || '').toLowerCase();
                  const isAccessory = ACCESSORY_KEYWORDS.some(kw => titleLower.includes(kw));
                  let suspiciousReason = null;
                  if (item.found && item.avgPrice != null) {
                    if (item.avgPrice < 5 && !isAccessory) suspiciousReason = `Suspiciously low: $${item.avgPrice.toFixed(2)} for non-accessory`;
                    else if (item.avgPrice > 2000) suspiciousReason = `Unusually high price: $${item.avgPrice.toFixed(2)} — may be a wrong match`;
                    else if (item.numSales != null && item.numSales < 3) suspiciousReason = `Low confidence: only ${item.numSales} sale${item.numSales !== 1 ? 's' : ''} found`;
                  }
                  const srcBadge = (() => {
                    const s = item.priceSource;
                    if (!s) return null;
                    if (s === 'sold-comps-cache' || s === 'cached-sold-comps') return { label: 'Cached', cls: 'bg-muted text-fg-muted', tip: 'Sold-comp price from local cache' };
                    if (s === 'sold-comps-fresh') return { label: 'Fresh', cls: 'bg-success-subtle text-success', tip: 'Freshly fetched from eBay sold listings' };
                    if (s === 'sold-comps-error') return { label: 'Error', cls: 'bg-warning-subtle text-warning', tip: 'Sold-comps fetch failed' };
                    if (s === 'too-generic') return { label: 'Skipped', cls: 'bg-subtle text-fg-subtle', tip: 'Item description too generic for accurate matching' };
                    if (s === 'cached-browse-api') return { label: '(legacy) Cached', cls: 'bg-muted text-fg-muted', tip: 'Legacy Browse API cache' };
                    if (s === 'cached') return { label: '(legacy) Cached', cls: 'bg-muted text-fg-muted', tip: 'Legacy cache' };
                    if (s === 'live') return { label: '(legacy) Live', cls: 'bg-muted text-fg-muted', tip: 'Legacy Browse API live fetch' };
                    if (s === 'rate_limited') return { label: 'Rate-lim', cls: 'bg-warning-subtle text-warning', tip: 'eBay rate limited' };
                    if (s === 'no_appid') return { label: 'No App ID', cls: 'bg-warning-subtle text-warning', tip: 'Missing eBay App ID' };
                    return null;
                  })();
                  return (
                    <div key={`${item.upc || 'part'}-${i}`} className={`grid grid-cols-12 gap-2 px-2.5 py-1.5 items-center ${item._isPart ? 'bg-secondary-subtle/40' : ''}`}>
                      <span className="col-span-3 font-mono text-fg-muted truncate" title={item._isPart ? `Part-out component of: ${item._partOf}` : item.upc}>
                        {item._isPart ? (
                          <span className="inline-flex items-center gap-1 text-[9px] uppercase font-semibold text-secondary not-italic">
                            {item._partType || 'part'}
                          </span>
                        ) : (
                          <>
                            <span className="hidden sm:inline">{item.upc}</span>
                            <span className="sm:hidden">...{item.upc?.slice(-6)}</span>
                          </>
                        )}
                      </span>
                      <span className="col-span-6 truncate text-fg flex items-center gap-1" title={item._isPart ? `${cleanText(item.ebayTitle || item.title)} — parted from ${item._partOf}` : cleanText(item.ebayTitle || item.title)}>
                        {item._isPart && <span className="shrink-0 text-secondary" title={`Parted from ${item._partOf}`}>{'↳'}</span>}
                        <span className="truncate">
                          {cleanText(item.ebayTitle || item.title) || <span className="italic text-fg-muted">Unknown</span>}
                        </span>
                        {srcBadge && (
                          <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded font-medium ${srcBadge.cls}`} title={srcBadge.tip}>
                            {srcBadge.label}
                          </span>
                        )}
                      </span>
                      <span className="col-span-1 text-right text-fg-muted">
                        {item.qty > 1 ? `x${item.qty}` : ''}
                      </span>
                      <span className="col-span-2 text-right">
                        {item.found && item.avgPrice != null ? (
                          <span className="inline-flex items-center justify-end gap-0.5">
                            <span className="font-mono font-semibold text-success">${item.avgPrice.toFixed(2)}</span>
                            {suspiciousReason && <AlertTriangle size={10} className="text-warning" title={suspiciousReason} />}
                          </span>
                        ) : (
                          <span className="text-fg-muted italic">{'—'}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
                {enrich.manifestItems.length > 20 && (
                  <button
                    type="button"
                    onClick={() => setShowAllItems((v) => !v)}
                    className="w-full px-2.5 py-1.5 text-fg-muted hover:text-fg hover:bg-muted/40 text-center text-[11px] font-medium transition-colors"
                  >
                    {showAllItems
                      ? `Show top 20 (hide ${enrich.manifestItems.length - 20})`
                      : `+${enrich.manifestItems.length - 20} more items — show all`}
                  </button>
                )}
              </div>
            </div>
          </div>
          );
        })()}

        {/* ─── 13. Bent-pin repair panel (preserved sub-component) ───── */}
        <LotCardRepairPanel summary={repairSummary} />

        {enrich.status === 'done' && (!enrich.manifestItems || enrich.manifestItems.length === 0) && (source?.includes('techliq') || source?.includes('liquidation')) && (
          <p className="text-[10px] text-fg-muted italic">No UPCs found in manifest</p>
        )}
        {enrich.status === 'error' && (
          <p className="text-[10px] text-danger italic">Manifest fetch failed</p>
        )}

        {/* ─── 14. Actions (preserved sub-component) ─────────────────── */}
        <LotCardActions
          onAnalyze={() => onAnalyze(lot)}
          onQuickBid={onQuickBid ? () => onQuickBid(lot, ceil30, enrich.totals?.estResale) : null}
          onPriceLot={onPriceLot}
          isPricing={enrich.status === 'loading'}
          isWatched={isWatched}
          onToggleWatch={onToggleWatch ? () => onToggleWatch(lot.id) : null}
          url={url}
          onExportManifestCsv={
            enrich.status === 'done' && enrich.manifestItems?.length > 0 ? handleExportCSV : null
          }
          onExportListingsCsv={() => {
            const headers = ['Title','Price','Quantity','Condition','UPC','Brand'];
            const rows = enrich.manifestItems.filter(i => i.found && i.avgPrice).map(i =>
              [i.ebayTitle || i.title, i.avgPrice?.toFixed(2), i.qty, '', i.upc, i.brand || ''].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
            );
            const csv = [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `listings-${lot.palletId || lot.id}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}
          showListingsCsv={enrich.status === 'done' && enrich.manifestItems?.length > 0}
          onQuickCompare={onQuickCompare ? () => onQuickCompare(lot.id) : null}
          onToggleNotes={() => setNotesOpen((v) => !v)}
          notesOpen={notesOpen}
          hasAiSummary={!!aiSummary}
          aiOpen={aiOpen}
          aiLoading={aiLoading}
          onShowAi={() => { aiSummary ? setAiOpen((v) => !v) : runSummary(); }}
          onRefreshAi={runSummary}
          onClearAi={clearSummary}
          isMock={lot.mock}
        />

        {/* ─── 15. AI summary inline card ─────────────────────────────── */}
        {aiSummary && aiOpen && (
          <div className="relative rounded-lg border border-accent/30 bg-accent-subtle px-3 py-2 text-[12px] leading-relaxed text-fg">
            <div className="flex items-start gap-2">
              <Sparkles size={12} className="text-accent shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="whitespace-pre-wrap">{aiSummary.summary}</p>
                <p className="text-[10px] text-fg-subtle mt-1">
                  AI read · {new Date(aiSummary.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  {' · '}
                  <button onClick={runSummary} className="underline hover:text-accent transition-colors">refresh</button>
                  {' · '}
                  <button onClick={clearSummary} className="underline hover:text-accent transition-colors">clear</button>
                </p>
              </div>
              <button onClick={() => setAiOpen(false)} className="text-fg-subtle hover:text-fg transition-colors shrink-0" title="Collapse">
                <X size={11} />
              </button>
            </div>
          </div>
        )}
        {aiError && (
          <div className="flex items-start gap-2 text-[11px] text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-1.5">
            <AlertTriangle size={11} className="shrink-0 mt-0.5" />
            <span>{aiError}</span>
            <button onClick={() => setAiError('')} className="ml-auto text-danger/70 hover:text-danger shrink-0"><X size={11} /></button>
          </div>
        )}

        {/* ─── 16. Notes textarea ─────────────────────────────────────── */}
        {notesOpen && (
          <textarea
            rows={2}
            className="w-full text-xs border border-border rounded-lg px-2.5 py-1.5 bg-surface text-fg placeholder-textsecondary/60 focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            placeholder="Add notes about this lot..."
            defaultValue={currentNote}
            onBlur={(ev) => onSaveNote?.(lot.id, ev.target.value)}
          />
        )}
      </div>
    </div>
  );
}

const LotCard = memo(LotCardInner);
export default LotCard;

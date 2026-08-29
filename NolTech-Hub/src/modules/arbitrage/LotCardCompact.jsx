// ─── LotCardCompact — visual revamp ─────────────────────────────────────────
// Props interface is UNCHANGED — drop-in replacement so BrowseLotsView wiring
// doesn't move. Ceiling / ROI / signal math is the same as before (it's
// load-bearing and matches the math in LotCard.jsx — don't drift it).
//
// What changed visually:
//   1. Larger, gradient image area with overlaid badges (signal + Tier 39
//      + bid ribbon all coexist in one corner band).
//   2. Hero ROI strip — the % margin gets first-class treatment. Green/red
//      bar that runs across the top of the body, so you scan a grid of
//      cards and the wins jump out instantly.
//   3. Single info row instead of three stacked lines (source · cond · qty).
//   4. Bid-up-to is the headline number in a colored panel; supporting
//      values (pred close, repair cost) live as subtle chips below it.
//   5. Hover lifts + faint shadow glow (uses existing tokens).
//   6. Footer is text+icon ("Log Bid" / "View") so it's tap-friendly.
//
// Status indicators:
//   - You have a bid → primary-bordered card, BID ribbon top-left
//   - Strong buy   → faint green halo + green ROI strip
//   - Buy          → green ROI strip (no halo)
//   - Watch        → amber ROI strip
//   - Pass         → red ROI strip + faint red halo
//   - Auction ending soon → animated clock pill (imminent = red pulse)

import { memo, useMemo } from 'react';
import { Gavel, Star, ExternalLink, Clock, Wrench, TrendingUp, TrendingDown } from 'lucide-react';
import { summarizeRepairs } from '../../utils/motherboardRepair';
import {
  getEbayFeeRate,
  getResaleRealizationRate,
  getEffectiveResaleMultiplier,
  getAuctionFeeRate,
} from '../../utils/fees';
import { fmt } from '../../utils/formatters';
import { SignalBadge } from './LotCard';
import Tier39AnalysisBadge from './Tier39AnalysisBadge';
import LotThumbnail from './LotThumbnail';

function LotCardCompactInner({ lot, onAnalyze, enrichment, isWatched, onToggleWatch, onQuickBid, hasActiveBid, liqEstimate }) {
  // ── Math (unchanged from prior version — keep in sync with LotCard.jsx) ──
  const { title, source, price, quantity, condition, url, estimation, metrics } = lot;
  const e  = estimation || {};
  const m  = metrics || {};
  const bc = m.bidCeilings || {};
  const enrich = enrichment || {};

  const hasManifestPricing =
    enrich.status === 'done' && enrich.totals?.numPriced > 0 && enrich.totals?.estResale > 0;
  const rawManifestResale  = enrich.totals?.estResale || 0;
  const shipping           = lot.shippingCost || 0;
  const ebayFeeRate        = getEbayFeeRate();
  const realizationRate    = getResaleRealizationRate();
  const lotCategory        = lot.topCategories || lot.category || '';
  const lotCondition       = condition || e.condition;
  const effectiveMultiplier = getEffectiveResaleMultiplier(lotCondition, lotCategory);
  const manifestResale     = rawManifestResale * effectiveMultiplier;
  const auctionFeeRate     = getAuctionFeeRate(source);
  const premiumDivisor     = 1 + auctionFeeRate;

  const repairSummary = useMemo(
    () => summarizeRepairs(enrich.manifestItems),
    [enrich.manifestItems],
  );
  const repairCost = repairSummary.totalCost || 0;

  let ceil30;
  if (hasManifestPricing) {
    const netAfterFees = manifestResale * (1 - ebayFeeRate) - shipping - repairCost;
    ceil30 = Math.round((netAfterFees * 0.70) / premiumDivisor);
  } else {
    const netBase = ((bc.at20pct ?? 0) / 0.80) - (repairCost / realizationRate);
    ceil30 = Math.round((netBase * 0.70 * realizationRate) / premiumDivisor);
  }

  const asking = price || 0;
  let signal = m.signal;
  if (hasManifestPricing && asking > 0) {
    const netAfterFees = manifestResale * (1 - ebayFeeRate) - shipping - repairCost;
    const askingCost = asking * premiumDivisor;
    const margin = netAfterFees > 0 ? (netAfterFees - askingCost) / netAfterFees : -1;
    if (margin >= 0.50)      signal = 'strong_buy';
    else if (margin >= 0.30) signal = 'buy';
    else if (margin >= 0.15) signal = 'watch';
    else                     signal = 'pass';
  }

  const roi      = asking > 0 ? Math.round(((ceil30 - asking) / asking) * 100) : null;
  const overCeil = asking > 0 && ceil30 > 0 && asking > ceil30;

  const endInfo = (() => {
    const endsAt = lot.auction?.endsAt;
    if (!endsAt) return null;
    const end = new Date(endsAt);
    const diff = end.getTime() - Date.now();
    const date = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let remaining, urgency = 'normal';
    if (diff <= 0)            { remaining = 'ended';                                                                                                                  urgency = 'ended'; }
    else if (diff < 3600000)  { remaining = `${Math.floor(diff / 60000)}m left`;                                                                                       urgency = 'imminent'; }
    else if (diff < 86400000) { remaining = `${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m left`;                                            urgency = 'soon'; }
    else                      { remaining = `${Math.floor(diff / 86400000)}d ${Math.floor((diff % 86400000) / 3600000)}h left`; }
    return { date, time, remaining, urgency };
  })();

  // ── Visual derivations ─────────────────────────────────────────────────────

  // ROI strip color — drives the top-of-body accent bar.
  const roiStrip =
    roi == null               ? 'bg-muted/60' :
    overCeil                  ? 'bg-danger/15  text-danger'  :
    roi >= 50                 ? 'bg-success/15 text-success' :
    roi >= 30                 ? 'bg-success/10 text-success' :
    roi >= 0                  ? 'bg-warning/10 text-warning' :
                                'bg-danger/10  text-danger';

  // Outer halo — subtle ring for context, never compete with the BID ribbon.
  const halo =
    hasActiveBid           ? 'ring-2 ring-primary/60'        :
    signal === 'strong_buy' ? 'ring-1 ring-success/40'       :
    signal === 'pass'       ? 'ring-1 ring-danger/30'        : '';

  const stop = (ev) => ev.stopPropagation();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onAnalyze?.(lot)}
      onKeyDown={(ev) => { if (ev.key === 'Enter') onAnalyze?.(lot); }}
      className={`group relative glossy-card overflow-hidden cursor-pointer transition-all duration-200 ease-out-expo hover:-translate-y-1 hover:shadow-glow-md ${halo}`}
    >
      {/* ─── Image header (full-bleed, taller, with overlay row) ───────────── */}
      <div className="relative">
        <LotThumbnail
          src={lot.image}
          alt={title}
          fit="cover"
          className="w-full h-32 transition-transform duration-300 ease-out-expo group-hover:scale-[1.03]"
          iconSize={32}
        />
        {/* Top gradient so overlay badges stay readable on bright images */}
        <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/45 to-transparent pointer-events-none" />

        {/* Top-left overlay: watch star + (optional) BID ribbon */}
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
          {hasActiveBid && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary text-white text-[10px] font-bold tracking-wide shadow-md" title="You have an active bid on this lot">
              <Gavel size={10} /> BID
            </span>
          )}
          <button
            type="button"
            onClick={(ev) => { stop(ev); onToggleWatch?.(lot.id); }}
            className="p-1 rounded-md bg-surface/85 backdrop-blur-sm shadow-sm hover:bg-surface transition-colors"
            title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
            aria-label={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
          >
            <Star
              size={13}
              fill={isWatched ? 'currentColor' : 'none'}
              className={isWatched ? 'text-warning' : 'text-fg-subtle'}
            />
          </button>
        </div>

        {/* Top-right overlay: Tier 39 badge + signal */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
          <Tier39AnalysisBadge lotId={lot.lotId} onClick={() => onAnalyze && onAnalyze(lot)} compact />
          <SignalBadge signal={signal} withIcon />
        </div>

        {/* Bottom-left overlay: clock pill when auction is approaching close */}
        {endInfo && endInfo.urgency !== 'normal' && (
          <span
            className={`absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold shadow-md ${
              endInfo.urgency === 'imminent' ? 'bg-danger text-white animate-pulse' :
              endInfo.urgency === 'soon'     ? 'bg-warning text-white' :
              'bg-fg-muted/80 text-white italic'
            }`}
            title={`Auction ends ${endInfo.date} at ${endInfo.time}`}
          >
            <Clock size={10} /> {endInfo.remaining}
          </span>
        )}
      </div>

      {/* ─── ROI strip — the at-a-glance signal ──────────────────────────── */}
      <div className={`flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold ${roiStrip}`}>
        <span className="inline-flex items-center gap-1">
          {roi != null && roi >= 0 ? <TrendingUp size={11} /> : roi != null ? <TrendingDown size={11} /> : null}
          {roi != null ? `${roi >= 0 ? '+' : ''}${roi}% ROI` : 'No ROI yet'}
        </span>
        <span className="font-mono text-fg/70">
          {asking > 0 ? `Ask ${fmt(asking)}` : 'No bid'}
        </span>
      </div>

      {/* ─── Body ────────────────────────────────────────────────────────── */}
      <div className="p-3">
        <p className="text-sm font-semibold text-fg leading-snug line-clamp-2 mb-1.5">
          {title}
        </p>
        <p className="text-[10px] text-fg-muted truncate mb-2">
          {(lot.sourceName || source || 'unknown')}
          {lotCondition && <> · <span className="capitalize">{String(lotCondition).replace(/_/g, ' ')}</span></>}
          {quantity > 0 && <> · {quantity} units</>}
        </p>

        {/* Bid-up-to hero panel */}
        <div className={`relative rounded-lg px-3 py-2 mb-2 ${
          ceil30 > 0
            ? 'bg-gradient-to-br from-success/12 via-success/6 to-transparent border border-success/25'
            : 'bg-muted/60 border border-border-subtle'
        }`}>
          <p className="text-[9px] uppercase tracking-widest text-fg-muted font-semibold">Bid up to</p>
          <p className={`text-2xl leading-tight font-bold font-mono ${ceil30 > 0 ? 'text-success' : 'text-fg-muted'}`}>
            {ceil30 > 0 ? fmt(ceil30) : '—'}
          </p>
          {overCeil && (
            <p className="text-[10px] text-danger font-semibold mt-0.5">Asking exceeds ceiling</p>
          )}
        </div>

        {/* Sub-chips: pred close + repair cost. Each is conditional so the
            card stays clean when neither applies. */}
        {(liqEstimate || repairSummary.totalBoards > 0) && (
          <div className="flex flex-wrap gap-1.5 mb-2.5">
            {liqEstimate && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-secondary/10 text-secondary text-[10px] font-medium"
                title={`Predicted winning bid: ${liqEstimate.category} lots historically close at ${liqEstimate.ratioPct}% of title MSRP.`}
              >
                Pred <span className="font-mono font-semibold">{fmt(liqEstimate.estimatedClose)}</span>
                <span className="text-secondary/70">· {liqEstimate.ratioPct}%</span>
              </span>
            )}
            {repairSummary.totalBoards > 0 && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-warning/10 text-warning text-[10px] font-medium"
                title={`Bent-pin repair: ${repairSummary.totalBoards} motherboard${repairSummary.totalBoards !== 1 ? 's' : ''} × $5 each. ${repairSummary.bySocket.map((s) => `${s.count}× ${s.socket}`).join(', ')}${repairSummary.unknowns.length ? ` · ${repairSummary.unknowns.length} unknown` : ''}`}
              >
                <Wrench size={9} /> Repair <span className="font-mono font-semibold">{fmt(repairSummary.totalCost)}</span>
              </span>
            )}
          </div>
        )}

        {/* Non-urgent end info (normal urgency falls here — the imminent / soon
            cases live on the image overlay). */}
        {endInfo && endInfo.urgency === 'normal' && (
          <p className="flex items-center gap-1 text-[10px] text-fg-muted mb-2 truncate">
            <Clock size={10} className="shrink-0" />
            <span className="truncate">Ends {endInfo.date} {endInfo.time} · {endInfo.remaining}</span>
          </p>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-primary transition-colors"
              title="View source listing"
            >
              <ExternalLink size={11} /> View
            </a>
          ) : <span />}
          <button
            type="button"
            onClick={(ev) => { stop(ev); onQuickBid?.(lot); }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 text-primary text-[11px] font-semibold hover:bg-primary hover:text-white transition-colors"
            title="Log a bid"
          >
            <Gavel size={11} /> Log Bid
          </button>
        </div>
      </div>
    </div>
  );
}

const LotCardCompact = memo(LotCardCompactInner);
export default LotCardCompact;

// ─── Bid Guidance Panel ──────────────────────────────────────────────────────
// Extracted from LotCard.jsx for readability. Shows the user the max they can
// bid to hit a 30% margin on their effective resale estimate, plus 20% / 40%
// alternates and the current asking price/ROI. The two explainer blocks
// (resale-multiplier breakdown and buyer's-premium breakdown) are still here
// but now live inside a small Info popover instead of always being visible.
//
// All math is computed in LotCard and passed in as props — this component is
// purely presentational.

import { useState } from 'react';
import { Check, Info, X } from 'lucide-react';

function LotCardBidGuidance({
  // Status
  overCeil,
  atWatch,
  hasManifestPricing,
  // Ceilings
  ceil30,
  ceil20,
  ceil40,
  // Asking + ROI
  asking,
  quantity,
  roi,
  // Resale-multiplier explainer values
  realizationApplied,
  effectiveMultiplier,
  realizationRate,
  askBuffer,
  askBufferDetails,
  lotCategory,
  conditionHaircut,
  lotCondition,
  conditionKey,
  // Buyer's-premium explainer values
  auctionFeeRate,
  premiumDivisor,
  source,
}) {
  const [infoOpen, setInfoOpen] = useState(false);

  if (!ceil30 || ceil30 <= 0) return null;

  const statusLabel = overCeil
    ? '⚠ Over max bid'
    : atWatch
      ? 'Near limit'
      : 'Bid up to';
  const statusIcon = !overCeil && !atWatch ? <Check size={12} /> : null;

  const hasInfo = realizationApplied || auctionFeeRate > 0;

  return (
    <div
      className={`relative rounded-lg px-3 py-2.5 border ${
        overCeil
          ? 'bg-danger-subtle border-danger/30'
          : atWatch
            ? 'bg-warning-subtle border-warning/30'
            : 'bg-success-subtle border-success/30'
      }`}
    >
      {/* 1. Header line: status + optional info button */}
      <div className="flex items-center justify-between mb-1.5">
        <p
          className={`flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${
            overCeil ? 'text-danger' : atWatch ? 'text-warning' : 'text-success'
          }`}
        >
          {statusIcon}
          {statusLabel}
          {hasManifestPricing && (
            <span className="ml-1 font-normal normal-case text-info">
              (from eBay data)
            </span>
          )}
        </p>
        {hasInfo && (
          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            className={`shrink-0 p-1 -m-1 rounded transition-colors ${
              infoOpen ? 'text-primary bg-surface/60' : 'text-fg-muted hover:text-primary hover:bg-surface/60'
            }`}
            title="How is this calculated?"
          >
            <Info size={12} />
          </button>
        )}
      </div>

      {/* Info popover with the two explainer boxes */}
      {hasInfo && infoOpen && (
        <div className="absolute right-2 top-8 z-20 w-[300px] max-w-[calc(100vw-2rem)] bg-surface rounded-xl border border-border shadow-lg p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
              How is this calculated?
            </p>
            <button
              onClick={() => setInfoOpen(false)}
              className="text-fg-subtle hover:text-fg shrink-0"
              title="Close"
            >
              <X size={11} />
            </button>
          </div>
          {realizationApplied && (
            <div
              className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono bg-accent-subtle border border-accent/30 rounded px-2 py-1"
              title="Bid ceilings discount the raw eBay-priced manifest by these stacking factors. Configure in Settings: Realized Sale Price %, Active-Listing Buffer %, eBay-Pricer Condition Haircut."
            >
              <span className="text-accent font-semibold uppercase tracking-wide">
                Resale {'×'}{(effectiveMultiplier * 100).toFixed(0)}%
              </span>
              <span className="text-accent/60">=</span>
              <span className="text-accent">
                <span className="font-semibold">{(realizationRate * 100).toFixed(0)}%</span>
                <span className="text-accent/70 normal-case ml-0.5">realized</span>
              </span>
              <span className="text-accent/60">{'×'}</span>
              <span
                className={askBufferDetails.source === 'override' ? 'text-info' : 'text-accent'}
                title={
                  askBufferDetails.source === 'override'
                    ? `Per-category override matched: "${askBufferDetails.matchedKey}" → ${(askBuffer * 100).toFixed(0)}%`
                    : `Default buffer (no per-category override matched "${lotCategory || 'this lot'}")`
                }
              >
                <span className="font-semibold">{(askBuffer * 100).toFixed(0)}%</span>
                <span className={`${askBufferDetails.source === 'override' ? 'text-info/70' : 'text-accent/70'} normal-case ml-0.5`}>
                  ask buffer
                  {askBufferDetails.source === 'override' && (
                    <span className="opacity-60"> ({askBufferDetails.matchedKey})</span>
                  )}
                </span>
              </span>
              <span className="text-accent/60">{'×'}</span>
              <span className={Math.abs(conditionHaircut - 1) > 0.001 ? 'text-warning' : 'text-accent'}>
                <span className="font-semibold">{(conditionHaircut * 100).toFixed(0)}%</span>
                <span className={`${Math.abs(conditionHaircut - 1) > 0.001 ? 'text-warning/80' : 'text-accent/70'} normal-case ml-0.5`}>
                  {lotCondition ? String(lotCondition).replace(/_/g, ' ').toLowerCase() : 'condition'}
                  {conditionKey && conditionKey !== String(lotCondition || '').toLowerCase().trim() && (
                    <span className="opacity-60"> ({conditionKey.replace(/_/g, ' ')})</span>
                  )}
                </span>
              </span>
            </div>
          )}
          {auctionFeeRate > 0 && (
            <div
              className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono bg-warning-subtle border border-warning/30 rounded px-2 py-1"
              title={`Bid ceilings divide by ${premiumDivisor.toFixed(2)} to account for the ${(auctionFeeRate * 100).toFixed(1)}% buyer's premium. Bidding the displayed max means you pay max × ${premiumDivisor.toFixed(2)} after premium.`}
            >
              <span className="text-warning font-semibold uppercase tracking-wide">
                +{(auctionFeeRate * 100).toFixed(auctionFeeRate * 100 % 1 === 0 ? 0 : 1)}% buyer's premium
              </span>
              <span className="text-warning/70 normal-case">
                {source?.toLowerCase().includes('techliq') ? "(TechLiquidators checkout fee)" :
                 source?.toLowerCase().includes('liquidation') ? "(Liquidation.com checkout fee)" :
                 '(checkout fee)'}
              </span>
              <span className="text-warning/60">{'→'}</span>
              <span className="text-warning">
                max bid = cost {'÷'} {premiumDivisor.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 2. Ceiling row */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className={`text-[10px] ${overCeil ? 'text-danger' : atWatch ? 'text-warning' : 'text-success'}`}>
            Bid up to (30% margin)
          </p>
          <p className={`text-lg font-bold font-mono leading-none ${overCeil ? 'text-danger' : 'text-success'}`}>
            ${ceil30.toLocaleString()}
          </p>
          {quantity > 1 && (
            <p className={`text-[10px] mt-0.5 ${overCeil ? 'text-danger' : atWatch ? 'text-warning' : 'text-success'}`}>
              ${Math.round(ceil30 / quantity).toLocaleString()}/unit
            </p>
          )}
        </div>
        <div className="text-right space-y-0.5">
          <p className={`text-[10px] ${overCeil ? 'text-danger' : atWatch ? 'text-warning' : 'text-success'}`}>
            20% margin: <span className="font-mono font-semibold">${ceil20.toLocaleString()}</span>
          </p>
          <p className={`text-[10px] ${overCeil ? 'text-danger' : atWatch ? 'text-warning' : 'text-success'}`}>
            40% margin: <span className="font-mono font-semibold">${ceil40.toLocaleString()}</span>
          </p>
        </div>
      </div>

      {/* 3. Asking + ROI row */}
      {asking > 0 && (
        <div
          className={`mt-2 pt-2 border-t border-current/10 flex items-center justify-between text-[11px] ${
            overCeil ? 'text-danger' : atWatch ? 'text-warning' : 'text-success'
          }`}
        >
          <span>
            Asking: <span className="font-mono font-semibold">${asking.toLocaleString()}</span>
            {quantity > 1 && <span> (${(asking / quantity).toFixed(0)}/unit)</span>}
          </span>
          {roi != null && (
            <span className={`font-semibold font-mono ${roi > 0 ? 'text-success' : 'text-danger'}`}>
              {roi > 0 ? '+' : ''}{roi}% ROI
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default LotCardBidGuidance;

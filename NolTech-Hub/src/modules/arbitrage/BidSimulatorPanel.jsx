// ─── Bid simulator panel ─────────────────────────────────────────────────────
// "If I bid $X on this lot, what's my probability of winning?"
//
// Reads the per-category close-ratio distribution from the close-ratio bid
// model (services/liqBidModel.js) and shows P(win) for the user's typed bid,
// plus the percentile in the historical distribution.
//
// Renders nothing for non-Liquidation.com lots or lots without enough close
// history yet — the simulator needs samples to be meaningful.

import { useEffect, useState, useMemo } from 'react';
import { Target } from 'lucide-react';
import { simulateLiqBid } from '../../services/liqBidModel';
import { fmt } from '../../utils/formatters';

export default function BidSimulatorPanel({ lot, defaultBid }) {
  const [bid, setBid] = useState(defaultBid || '');
  const [sim, setSim] = useState(null);
  const [loading, setLoading] = useState(false);

  // Re-simulate when the bid or lot changes (debounced lightly via effect tick).
  useEffect(() => {
    let cancelled = false;
    const value = parseFloat(bid);
    if (!Number.isFinite(value) || value <= 0) { setSim(null); return; }
    setLoading(true);
    simulateLiqBid(lot, value).then((r) => { if (!cancelled) { setSim(r); setLoading(false); } });
    return () => { cancelled = true; };
  }, [bid, lot]);

  const isLiq = (lot?.source || '').toLowerCase().includes('liquidation');
  if (!isLiq) return null;

  // Derive a default title MSRP display from the lot if available.
  const msrp = lot?.estimation?.totalMsrp || 0;

  const winColor = (p) => p >= 0.7 ? 'text-success' : p >= 0.4 ? 'text-warning' : 'text-danger';

  return (
    <div className="rounded-lg bg-secondary-subtle border border-secondary/30 px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="text-[10px] uppercase tracking-wide text-fg-muted flex items-center gap-1">
          <Target size={11} className="text-secondary" />
          Bid Simulator
        </p>
        {msrp > 0 && (
          <span className="text-[10px] text-fg-subtle">
            Title MSRP: <span className="font-mono">{fmt(msrp)}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] text-fg-muted">If I bid</span>
        <div className="relative flex-1 max-w-[140px]">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted text-xs">$</span>
          <input
            type="number"
            value={bid}
            onChange={(e) => setBid(e.target.value)}
            placeholder="0"
            className="w-full pl-5 pr-2 py-1 text-xs font-mono rounded border border-border bg-surface text-fg focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {!sim && !loading && (
        <p className="text-[10px] text-fg-subtle">
          Enter a bid to estimate P(win) from historical category closes.
        </p>
      )}
      {loading && (
        <p className="text-[10px] text-fg-subtle">Calculating…</p>
      )}
      {sim && (
        <>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] text-fg-muted">P(win):</span>
            <span className={`text-base font-bold font-mono ${winColor(sim.winProbability)}`}>
              {(sim.winProbability * 100).toFixed(1)}%
            </span>
          </div>
          <div className="text-[10px] text-fg-muted leading-relaxed">
            Your bid is at the <span className="font-mono font-semibold text-fg">{sim.percentile.toFixed(0)}th</span> percentile of historical {sim.scope === 'category' ? 'in-category' : 'liquidation'} closes
            <span className="text-fg-subtle"> ({sim.sampleCount} samples).</span>
          </div>
          {sim.distribution && (
            <div className="mt-1.5 grid grid-cols-5 gap-1 text-[9px] text-center">
              <Quartile label="p10" value={sim.distribution.p10} msrp={msrp} />
              <Quartile label="p25" value={sim.distribution.p25} msrp={msrp} />
              <Quartile label="med" value={sim.distribution.median} msrp={msrp} highlight />
              <Quartile label="p75" value={sim.distribution.p75} msrp={msrp} />
              <Quartile label="p90" value={sim.distribution.p90} msrp={msrp} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Quartile({ label, value, msrp, highlight }) {
  const dollars = (value && msrp > 0) ? Math.round(value * msrp) : null;
  return (
    <div className={`rounded px-1 py-0.5 ${highlight ? 'bg-secondary/20' : 'bg-muted/30'}`}>
      <div className="text-fg-subtle uppercase tracking-wide">{label}</div>
      <div className="font-mono text-fg">
        {dollars != null ? `$${dollars.toLocaleString()}` : '—'}
      </div>
    </div>
  );
}

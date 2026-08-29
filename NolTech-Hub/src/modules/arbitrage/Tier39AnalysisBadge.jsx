// ─── Tier39AnalysisBadge ─────────────────────────────────────────────────────
// Tiny status badge for a lot card showing the auto-analyze result.
// States: loading | pending | processing | scored | error | cost_cap | not_queued
//
// When scored: shows margin % + recommendation arrow. Click → opens
// DealAnalyzer. When errored: tooltip surfaces the queue row's error message
// + click triggers a one-shot requeue so the user can retry without going
// through the SQL / queue cooldown dance.

import { useState } from 'react';
import { Loader2, AlertCircle, TrendingUp, TrendingDown, Clock, CircleDashed, Ban, RotateCw } from 'lucide-react';
import { useLotAnalysis } from '../../hooks/useLotAnalysis';
import { requeueLot } from '../../services/lotAnalysisQueue';

export default function Tier39AnalysisBadge({ lotId, onClick, compact = false }) {
  const { queue, status, marginPct, recommendation, redFlags } = useLotAnalysis(lotId);
  const [retrying, setRetrying] = useState(false);

  if (!lotId || status === 'not_queued') return null;

  // ── Scored ─────────────────────────────────────────────────────────────
  if (status === 'scored') {
    const isGreen = marginPct != null && marginPct >= 20;
    const isAmber = marginPct != null && marginPct >= 0 && marginPct < 20;
    const isRed = marginPct == null || marginPct < 0;
    const color = isGreen ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : isAmber ? 'text-amber-700 bg-amber-50 border-amber-200'
                : 'text-rose-700 bg-rose-50 border-rose-200';
    const Icon = isGreen ? TrendingUp : isRed ? TrendingDown : CircleDashed;
    const recLabel = ({
      resell_whole_lot: 'whole',
      part_out_desktops: 'part-out',
      full_part_out: 'parts',
    })[recommendation] || '—';

    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${color} hover:opacity-80 transition`}
        title={`Recommendation: ${recommendation}${redFlags.length ? ` · ${redFlags.length} red flag(s)` : ''}`}
      >
        <Icon size={12} />
        {marginPct != null ? `${marginPct.toFixed(1)}%` : '—'}
        {!compact && <span className="opacity-60">·{recLabel}</span>}
        {redFlags.length > 0 && (
          <AlertCircle size={11} className="text-amber-600" />
        )}
      </button>
    );
  }

  // ── In-flight or error states ───────────────────────────────────────────
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-slate-600 bg-slate-100 border border-slate-200">
        <Clock size={12} /> queued
      </span>
    );
  }
  if (status === 'processing') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-sky-700 bg-sky-50 border border-sky-200">
        <Loader2 size={12} className="animate-spin" /> scoring
      </span>
    );
  }
  if (status === 'completing') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-sky-700 bg-sky-50 border border-sky-200">
        <Loader2 size={12} className="animate-spin" /> finalizing
      </span>
    );
  }
  if (status === 'error') {
    const errMsg = queue?.error || 'Worker reported an error';
    const handleRetry = async (e) => {
      e.stopPropagation();
      if (retrying) return;
      setRetrying(true);
      try { await requeueLot(lotId); } catch {}
      setRetrying(false);
    };
    return (
      <button
        type="button"
        onClick={handleRetry}
        disabled={retrying}
        title={`Tier 39 error: ${errMsg.slice(0, 240)}\n\nClick to requeue.`}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 disabled:opacity-60"
      >
        {retrying ? <Loader2 size={11} className="animate-spin" /> : <AlertCircle size={12} />}
        {retrying ? 'requeueing' : 'err'}
        {!retrying && <RotateCw size={10} className="opacity-60" />}
      </button>
    );
  }
  if (status === 'cost_cap') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-amber-700 bg-amber-50 border border-amber-200"
        title="Daily $5 analysis cap reached — will retry tomorrow"
      >
        <Ban size={12} /> capped
      </span>
    );
  }
  return null;
}

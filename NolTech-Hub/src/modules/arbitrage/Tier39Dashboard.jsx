// ─── Tier 39 ROI dashboard ────────────────────────────────────────────────────
// Surfaces the lots the auto-analyze worker scored overnight (`lot_analyses`
// table). Sorted by recommendation-scenario margin% descending so the highest-
// ROI opportunities float to the top. Each row joins to liquidation_lots_newegg
// for the lot title / URL / current bid / endsAt + red_flags array from the
// analysis row itself.
//
// Data flow:
//   auto-analyze-worker (cron) → lot_analyses + liquidation_lots_newegg
//   this dashboard            → Supabase read joined on lot_id
//
// No write paths from here — purely a read view.

import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, ExternalLink, Loader2, AlertTriangle, Filter, RefreshCw, Clock, Gavel, ShieldAlert, ChevronDown, Repeat, TrendingDown } from 'lucide-react';
import { supabase, getActiveWorkspace } from '../../services/supabase';
import { fmt, formatDate } from '../../utils/formatters';
import EmptyState from '../../components/EmptyState';

const SORT_OPTIONS = [
  { value: 'margin', label: 'Top margin %' },
  { value: 'profit', label: 'Top profit $' },
  { value: 'recent', label: 'Most recent' },
];

const REC_LABELS = {
  resell_whole_lot:   { short: 'Whole lot',  color: 'bg-info-subtle text-info'     },
  part_out_desktops:  { short: 'Part desks', color: 'bg-warning-subtle text-warning' },
  full_part_out:      { short: 'Full parts', color: 'bg-success-subtle text-success' },
};

function scenarioOf(row) {
  const rec = row?.recommendation;
  const sc = row?.scenarios;
  if (!rec || !sc || typeof sc !== 'object') return null;
  return sc[rec] || null;
}

export default function Tier39Dashboard({ onAnalyzeLot }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortBy, setSortBy] = useState('margin');
  const [minMargin, setMinMargin] = useState(0);
  const [hideRedFlags, setHideRedFlags] = useState(false);
  const [recFilter, setRecFilter] = useState('all');
  const [todayCosts, setTodayCosts] = useState(null);

  // ── Load lot_analyses + joined lot rows ──────────────────────────────────
  const load = async () => {
    setLoading(true); setError('');
    try {
      const workspaceId = await getActiveWorkspace();
      if (!workspaceId) throw new Error('No active workspace');

      // 1. Pull recent analyses (limit 200 — UI sorts/filters in memory).
      const { data: analyses, error: aErr } = await supabase
        .from('lot_analyses')
        .select('lot_id, scored_at, raw_lot_price, items_total_estimated_msrp, scenarios, recommendation, red_flags, total_cost_to_score_usd')
        .eq('workspace_id', workspaceId)
        .order('scored_at', { ascending: false })
        .limit(200);
      if (aErr) throw aErr;
      if (!analyses?.length) { setRows([]); return; }

      // 2. Pull lot metadata for the analyzed lots in one query, including
      // the relist columns added in migration 020. relisted_from carries
      // the prior lot_id; prior_starting_bid lets us show the price delta.
      const lotIds = analyses.map((a) => a.lot_id);
      const { data: lots } = await supabase
        .from('liquidation_lots_newegg')
        .select('lot_id, title, url, current_bid, num_bids, ends_at, manifest_url, dismissed_at, relisted_from, prior_starting_bid')
        .eq('workspace_id', workspaceId)
        .in('lot_id', lotIds);
      const lotsByLot = new Map((lots || []).map((l) => [l.lot_id, l]));

      // 3. Today's cost meter — informational.
      const today = new Date().toISOString().slice(0, 10);
      const { data: costRow } = await supabase
        .from('analysis_costs')
        .select('total_usd, lots_analyzed')
        .eq('workspace_id', workspaceId)
        .eq('date', today)
        .maybeSingle();
      setTodayCosts(costRow);

      // 4. Stitch together. Drop dismissed lots silently — user marked them.
      const stitched = analyses
        .map((a) => {
          const lot = lotsByLot.get(a.lot_id);
          if (lot?.dismissed_at) return null;
          const sc = scenarioOf(a);
          return {
            ...a,
            lot,
            margin_pct: sc ? Number(sc.margin_pct) : null,
            profit:     sc ? Number(sc.profit)     : null,
            revenue:    sc ? Number(sc.revenue)    : null,
            cost_basis: sc ? Number(sc.cost_basis) : null,
            red_flag_count: Array.isArray(a.red_flags) ? a.red_flags.length : 0,
          };
        })
        .filter(Boolean);

      setRows(stitched);
    } catch (e) {
      console.error('[Tier39Dashboard] load failed:', e);
      setError(e?.message || 'Failed to load analyses');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ── Filter + sort ────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = rows;
    if (minMargin > 0)     list = list.filter((r) => Number.isFinite(r.margin_pct) && r.margin_pct >= minMargin);
    if (hideRedFlags)      list = list.filter((r) => r.red_flag_count === 0);
    if (recFilter !== 'all') list = list.filter((r) => r.recommendation === recFilter);

    list = [...list].sort((a, b) => {
      if (sortBy === 'margin') return (b.margin_pct ?? -Infinity) - (a.margin_pct ?? -Infinity);
      if (sortBy === 'profit') return (b.profit     ?? -Infinity) - (a.profit     ?? -Infinity);
      return new Date(b.scored_at) - new Date(a.scored_at);
    });
    return list;
  }, [rows, sortBy, minMargin, hideRedFlags, recFilter]);

  // ── Summary stats ────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = rows.length;
    const profitable = rows.filter((r) => Number.isFinite(r.profit) && r.profit > 0).length;
    const totalProfit = rows.reduce((s, r) => s + (Number.isFinite(r.profit) ? Math.max(0, r.profit) : 0), 0);
    const avgMargin = (() => {
      const vals = rows.map((r) => r.margin_pct).filter((v) => Number.isFinite(v));
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    })();
    return { total, profitable, totalProfit, avgMargin };
  }, [rows]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 size={14} className="animate-spin" /> Loading Tier 39 analyses…
        </div>
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-24 bg-muted/40 rounded-xl animate-pulse" />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger-subtle p-4 text-sm text-danger flex items-start gap-2">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-semibold">Couldn't load analyses</p>
          <p className="text-xs mt-1">{error}</p>
        </div>
        <button onClick={load} className="px-3 py-1 rounded bg-danger text-white text-xs">Retry</button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No auto-analyses yet"
        description="The auto-analyze worker runs every 5 minutes. Once it scores a Newegg_Business lot, it'll show up here."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Lots scored" value={stats.total} icon={TrendingUp} />
        <StatTile label="Profitable" value={stats.profitable} icon={Gavel} accent="success" />
        <StatTile label="Total upside" value={fmt(stats.totalProfit)} mono accent="success" />
        <StatTile label="Avg margin" value={`${stats.avgMargin.toFixed(1)}%`} mono accent="info" />
      </div>

      {/* Cost meter */}
      {todayCosts && (
        <div className="rounded-lg border border-border-subtle bg-muted/30 px-3 py-2 text-xs text-fg-muted flex items-center justify-between">
          <span>Today's analysis spend: <span className="font-mono font-semibold text-fg">{fmt(Number(todayCosts.total_usd))}</span> across {todayCosts.lots_analyzed} lots</span>
          <button onClick={load} className="inline-flex items-center gap-1 text-primary hover:underline">
            <RefreshCw size={11} /> Refresh
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-2">
        <Filter size={14} className="text-fg-muted ml-1" />
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          Sort
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="text-xs border border-border-subtle rounded px-2 py-1 bg-surface">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          Min margin %
          <input type="number" value={minMargin} onChange={(e) => setMinMargin(Number(e.target.value) || 0)} min={0} max={100} className="w-16 text-xs border border-border-subtle rounded px-2 py-1 bg-surface font-mono" />
        </label>
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          Strategy
          <select value={recFilter} onChange={(e) => setRecFilter(e.target.value)} className="text-xs border border-border-subtle rounded px-2 py-1 bg-surface">
            <option value="all">All</option>
            <option value="resell_whole_lot">Whole lot</option>
            <option value="part_out_desktops">Part desktops</option>
            <option value="full_part_out">Full part-out</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer ml-auto">
          <input type="checkbox" checked={hideRedFlags} onChange={(e) => setHideRedFlags(e.target.checked)} />
          Hide red-flagged
        </label>
      </div>

      {/* Result count */}
      <p className="text-xs text-fg-muted">
        {filtered.length}{filtered.length !== rows.length ? ` of ${rows.length}` : ''} lots
      </p>

      {/* Rows */}
      {filtered.length === 0 ? (
        <p className="text-sm text-fg-muted text-center py-8 italic">No analyses match these filters.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((row) => (
            <Tier39Row key={row.lot_id} row={row} onClick={() => row.lot && onAnalyzeLot?.({ ...row.lot, lotId: row.lot_id })} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Individual row ──────────────────────────────────────────────────────────

function Tier39Row({ row, onClick }) {
  const [expanded, setExpanded] = useState(false);
  const recCfg = REC_LABELS[row.recommendation] || { short: row.recommendation, color: 'bg-muted text-fg-muted' };
  const m = row.margin_pct;
  const profitable = Number.isFinite(row.profit) && row.profit > 0;
  const marginCls = !Number.isFinite(m) ? 'text-fg-muted' : m >= 30 ? 'text-success' : m >= 10 ? 'text-warning' : 'text-danger';

  const lot = row.lot || {};
  const endingSoon = lot.ends_at && (new Date(lot.ends_at).getTime() - Date.now()) < 3600000;
  // Relist signal — both fields must be present from migration 020. Compute
  // the bid delta + signed % drop for the badge tooltip.
  const isRelist = !!lot.relisted_from && Number.isFinite(Number(lot.prior_starting_bid));
  const priorBid = isRelist ? Number(lot.prior_starting_bid) : null;
  const curBid   = Number.isFinite(Number(lot.current_bid)) ? Number(lot.current_bid) : null;
  const bidDelta = isRelist && Number.isFinite(curBid) ? curBid - priorBid : null;
  const bidDeltaPct = isRelist && priorBid > 0 && Number.isFinite(curBid)
    ? ((curBid - priorBid) / priorBid) * 100
    : null;

  return (
    <div className={`group rounded-xl border ${profitable ? 'border-success/30 bg-success-subtle/30' : 'border-border bg-surface'} transition-all hover:shadow-sm`}>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-3 flex items-center gap-3"
      >
        {/* Margin badge */}
        <div className="shrink-0 w-16 text-right">
          <p className={`text-xl font-bold font-mono leading-none ${marginCls}`}>
            {Number.isFinite(m) ? `${m >= 0 ? '+' : ''}${m.toFixed(0)}%` : '—'}
          </p>
          <p className="text-[9px] text-fg-muted uppercase tracking-wide mt-0.5">margin</p>
        </div>

        {/* Title block */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-fg truncate flex items-center gap-1.5">
            {isRelist && (
              <span
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent/15 text-accent shrink-0"
                title={`Relisted from lot ${lot.relisted_from}. Prior starting bid: ${fmt(priorBid)}. ROI carried over (free re-analysis).`}
              >
                <Repeat size={10} /> RELIST
              </span>
            )}
            <span className="truncate">{lot.title || row.lot_id}</span>
          </p>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-fg-muted flex-wrap">
            <span className={`px-1.5 py-0.5 rounded font-medium ${recCfg.color}`}>{recCfg.short}</span>
            {Number.isFinite(row.profit) && (
              <span className="font-mono">Profit <span className={profitable ? 'text-success font-semibold' : 'text-danger'}>{fmt(row.profit)}</span></span>
            )}
            {Number.isFinite(lot.current_bid) && (
              <span className="font-mono">Bid {fmt(lot.current_bid)}{lot.num_bids ? ` (${lot.num_bids})` : ''}</span>
            )}
            {/* Bid delta for relists — green when starting bid dropped (better
                for buyer), red when it went up (rare but possible). */}
            {isRelist && Number.isFinite(bidDelta) && (
              <span
                className={`inline-flex items-center gap-0.5 font-mono font-semibold ${
                  bidDelta < 0 ? 'text-success' : bidDelta > 0 ? 'text-danger' : 'text-fg-muted'
                }`}
                title={`Started at ${fmt(priorBid)} previously, now ${fmt(curBid)}.`}
              >
                {bidDelta < 0 ? <TrendingDown size={10} /> : <TrendingUp size={10} />}
                {bidDelta > 0 ? '+' : ''}{fmt(bidDelta)}
                {Number.isFinite(bidDeltaPct) && (
                  <span className="opacity-70">({bidDeltaPct > 0 ? '+' : ''}{bidDeltaPct.toFixed(0)}%)</span>
                )}
              </span>
            )}
            {endingSoon && (
              <span className="inline-flex items-center gap-1 text-danger font-medium">
                <Clock size={10} /> ends soon
              </span>
            )}
            {row.red_flag_count > 0 && (
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldAlert size={10} /> {row.red_flag_count} flag{row.red_flag_count !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Right column — ext link + expand */}
        <div className="shrink-0 flex items-center gap-1">
          {lot.url && (
            <a
              href={lot.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="p-1 rounded text-fg-muted hover:text-primary hover:bg-muted/40"
              title="Open on Liquidation.com"
            >
              <ExternalLink size={13} />
            </a>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            className={`p-1 rounded text-fg-muted hover:bg-muted/40 transition-transform ${expanded ? 'rotate-180' : ''}`}
            title={expanded ? 'Collapse details' : 'Show details'}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </button>

      {/* Expanded details — scenarios + red flags */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border-subtle pt-2 text-xs space-y-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-fg-muted font-semibold mb-1">Scenarios</p>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(row.scenarios || {}).map(([k, v]) => {
                const isRec = k === row.recommendation;
                return (
                  <div key={k} className={`rounded p-2 ${isRec ? 'bg-success-subtle border border-success/30' : 'bg-muted/40'}`}>
                    <p className="text-[10px] font-semibold text-fg-muted">{(REC_LABELS[k]?.short) || k}</p>
                    <p className={`text-sm font-bold font-mono ${isRec ? 'text-success' : 'text-fg'}`}>
                      {Number.isFinite(Number(v?.margin_pct)) ? `${Number(v.margin_pct).toFixed(0)}%` : '—'}
                    </p>
                    <p className="text-[10px] text-fg-muted">{fmt(Number(v?.profit))} profit</p>
                  </div>
                );
              })}
            </div>
          </div>
          {row.red_flag_count > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-warning font-semibold mb-1 inline-flex items-center gap-1">
                <ShieldAlert size={10} /> Red flags
              </p>
              <ul className="space-y-0.5">
                {(row.red_flags || []).map((flag, i) => (
                  <li key={i} className="text-[11px] text-fg-muted">• {typeof flag === 'string' ? flag : (flag?.message || JSON.stringify(flag))}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[10px] text-fg-subtle">Scored {formatDate(row.scored_at)} · ${Number(row.total_cost_to_score_usd || 0).toFixed(3)} to analyze</p>
        </div>
      )}
    </div>
  );
}

// ─── Stat tile ───────────────────────────────────────────────────────────────

function StatTile({ label, value, icon: Icon, mono, accent }) {
  const colorCls =
    accent === 'success' ? 'text-success' :
    accent === 'info'    ? 'text-info'    :
    accent === 'warning' ? 'text-warning' :
                           'text-fg';
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fg-muted font-medium">
        {Icon && <Icon size={11} />}
        {label}
      </div>
      <p className={`text-lg font-bold mt-0.5 ${colorCls} ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

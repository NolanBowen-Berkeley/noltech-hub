// ─── Lot History Viewer ──────────────────────────────────────────────────────
// Inspect / manage the local lot-history database that powers the comparable-
// closes feature. Shows status counts, a sortable filterable table, manual
// closing-price override, on-demand re-poll, and per-row JSON inspect.

import { useEffect, useState, useMemo, Fragment } from 'react';
import {
  RefreshCw, Loader2, AlertTriangle, Search, X, Trash2, ExternalLink, Edit2, Check,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, History,
} from 'lucide-react';
import { fmt, formatDateTime } from '../../utils/formatters';
import { pollClosingPrices, recordClosingState, getLotHistory } from '../../services/lotHistory';
import usePagination from '../../hooks/usePagination';
import EmptyState from '../../components/EmptyState';

const KEY_HISTORY = 'noltech:arbitrage:lot-history';

const STATUS_CONFIG = {
  pending:      { label: 'Pending',      cls: 'bg-warning-subtle text-warning' },
  still_active: { label: 'Active',       cls: 'bg-info-subtle text-info' },
  sold:         { label: 'Sold',         cls: 'bg-success-subtle text-success' },
  no_sale:      { label: 'No Sale',      cls: 'bg-muted text-fg-muted' },
  unknown:      { label: 'Unknown',      cls: 'bg-danger-subtle text-danger' },
};

const SORT_OPTIONS = [
  { value: 'lastSeenAt',  label: 'Last seen' },
  { value: 'finalBid',    label: 'Final bid' },
  { value: 'endsAt',      label: 'Ends at' },
  { value: 'msrpPerUnit', label: 'MSRP / unit' },
  { value: 'itemCount',   label: 'Quantity' },
];

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  return (
    <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

export default function LotHistoryViewer() {
  const [history,    setHistory]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [polling,    setPolling]    = useState(false);
  const [pollResult, setPollResult] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search,     setSearch]     = useState('');
  const [sortBy,     setSortBy]     = useState('lastSeenAt'); // lastSeenAt | finalBid | endsAt | msrpPerUnit | itemCount
  const [sortDir,    setSortDir]    = useState('desc');
  const [editingId,  setEditingId]  = useState(null);
  const [editValue,  setEditValue]  = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [loadError, setLoadError]   = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getLotHistory();
      setHistory(data);
    } catch (e) {
      console.error('[lot history] load failed:', e);
      setLoadError(e?.message || 'Failed to load lot history');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { total: history.length, pending: 0, still_active: 0, sold: 0, no_sale: 0, unknown: 0, ended_pending: 0 };
    const now = Date.now();
    for (const h of history) {
      const status = h.finalBidStatus || 'pending';
      if (c[status] != null) c[status]++;
      if (h.finalBid == null && h.endsAt && new Date(h.endsAt).getTime() < now) c.ended_pending++;
    }
    return c;
  }, [history]);

  const filtered = useMemo(() => {
    let rows = history;
    if (statusFilter !== 'all') {
      rows = rows.filter((h) => (h.finalBidStatus || 'pending') === statusFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter((h) =>
        (h.title || '').toLowerCase().includes(q) ||
        (h.topCategories || '').toLowerCase().includes(q) ||
        (h.topBrands || '').toLowerCase().includes(q) ||
        (h.lotId || '').toLowerCase().includes(q) ||
        (h.palletId || '').toLowerCase().includes(q)
      );
    }
    const valOf = (h) => {
      const v = h[sortBy];
      if (sortBy === 'lastSeenAt' || sortBy === 'endsAt') return v ? new Date(v).getTime() : 0;
      return Number(v) || 0;
    };
    rows = [...rows].sort((a, b) => sortDir === 'desc' ? valOf(b) - valOf(a) : valOf(a) - valOf(b));
    return rows;
  }, [history, statusFilter, search, sortBy, sortDir]);

  const { page, pageItems, totalPages, next, prev, setPage, pageSize, setPageSize } =
    usePagination(filtered, 25);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortBy(col); setSortDir('desc'); }
  };

  const handlePollNow = async () => {
    setPolling(true);
    setPollResult(null);
    try {
      const r = await pollClosingPrices({ limit: 25, minHoursSinceLastCheck: 0 });
      setPollResult({ ok: true, ...r });
      await load();
    } catch (e) {
      setPollResult({ ok: false, msg: e.message });
    } finally {
      setPolling(false);
    }
  };

  const handleSaveOverride = async (lotId) => {
    const num = parseFloat(editValue);
    if (isNaN(num) || num <= 0) { setEditingId(null); return; }
    await recordClosingState(lotId, {
      finalBid: num,
      status: 'sold',
      fetchedAt: new Date().toISOString(),
    });
    setEditingId(null);
    setEditValue('');
    await load();
  };

  const handleDeleteRow = async (lotId) => {
    if (!confirm(`Remove this entry from lot history? (lotId: ${lotId})`)) return;
    const next = history.filter((h) => h.lotId !== lotId);
    await window.storage.set(KEY_HISTORY, next);
    await load();
  };

  const handleClearAll = async () => {
    if (!confirm(`Clear ALL ${history.length} lot history entries? This is permanent.`)) return;
    await window.storage.set(KEY_HISTORY, []);
    await load();
  };

  const SortHeader = ({ label, col, className = '' }) => (
    <button
      type="button"
      onClick={() => handleSort(col)}
      className={`text-[11px] font-semibold uppercase tracking-wide text-fg-muted hover:text-fg transition-colors ${className}`}
    >
      {label}
      {sortBy === col && <span className="ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>}
    </button>
  );

  // Shared expand-row body content (key/value grid + raw JSON details)
  const renderExpandBody = (h) => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <p className="text-fg-muted uppercase tracking-wide text-[10px]">Category</p>
          <p className="text-fg break-words">{h.topCategories || '—'}</p>
        </div>
        <div>
          <p className="text-fg-muted uppercase tracking-wide text-[10px]">Qty</p>
          <p className="text-fg font-mono">{h.itemCount ?? '—'}</p>
        </div>
        <div>
          <p className="text-fg-muted uppercase tracking-wide text-[10px]">MSRP / unit</p>
          <p className="text-fg font-mono">{h.msrpPerUnit ? fmt(h.msrpPerUnit) : '—'}</p>
        </div>
        <div>
          <p className="text-fg-muted uppercase tracking-wide text-[10px]">Ends</p>
          <p className="text-fg">{h.endsAt ? formatDateTime(h.endsAt) : '—'}</p>
        </div>
        <div>
          <p className="text-fg-muted uppercase tracking-wide text-[10px]">Lot ID</p>
          <p className="text-fg font-mono break-all">{h.lotId || '—'}</p>
        </div>
        <div>
          <p className="text-fg-muted uppercase tracking-wide text-[10px]">URL</p>
          {h.url ? (
            <a
              href={h.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline break-all inline-flex items-center gap-1"
            >
              <ExternalLink size={10} /> Open lot
            </a>
          ) : (
            <p className="text-fg-muted">—</p>
          )}
        </div>
      </div>
      <details>
        <summary className="text-[11px] text-fg-muted cursor-pointer">View raw JSON</summary>
        <pre className="mt-2 text-[10px] text-fg-muted font-mono whitespace-pre-wrap break-words">
          {JSON.stringify(h, null, 2)}
        </pre>
      </details>
    </div>
  );

  // Action buttons (used by both desktop row and mobile card)
  const renderActions = (h, { onToggleExpand, expanded }) => (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
        className="text-fg-muted hover:text-primary p-1 rounded hover:bg-primary/10"
        title={expanded ? 'Collapse details' : 'Expand details'}
      >
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditingId(h.lotId);
          setEditValue(h.finalBid != null ? String(h.finalBid) : '');
        }}
        className="text-fg-muted hover:text-primary p-1 rounded hover:bg-primary/10"
        title="Edit closing price"
      >
        <Edit2 size={11} />
      </button>
      {h.url && (
        <a
          href={h.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-fg-muted hover:text-primary p-1 rounded hover:bg-primary/10"
          title="Open on TechLiquidators"
        >
          <ExternalLink size={11} />
        </a>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); handleDeleteRow(h.lotId); }}
        className="text-fg-muted hover:text-danger p-1 rounded hover:bg-danger/10"
        title="Remove entry"
      >
        <Trash2 size={11} />
      </button>
    </>
  );

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="p-3 rounded-lg border border-danger/40 bg-danger/5 text-xs text-danger flex items-center justify-between gap-3">
          <span>Couldn't load lot history: {loadError}</span>
          <button
            type="button"
            onClick={load}
            className="px-2 py-0.5 rounded border border-danger/40 text-danger hover:bg-danger/10"
          >
            Retry
          </button>
        </div>
      )}
      {/* Status counts */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <button
          type="button"
          onClick={() => setStatusFilter('all')}
          className={`text-left p-2.5 rounded-lg border ${statusFilter === 'all' ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:bg-muted/40'}`}
        >
          <p className="text-[10px] uppercase tracking-wide text-fg-muted">Total</p>
          <p className="text-lg font-bold font-mono text-fg">{counts.total}</p>
        </button>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={`text-left p-2.5 rounded-lg border ${statusFilter === key ? 'border-primary bg-primary/5' : 'border-border bg-surface hover:bg-muted/40'}`}
          >
            <p className="text-[10px] uppercase tracking-wide text-fg-muted">{cfg.label}</p>
            <p className="text-lg font-bold font-mono text-fg">{counts[key] || 0}</p>
          </button>
        ))}
      </div>

      {counts.ended_pending > 0 && (
        <div className="bg-warning-subtle border border-warning/30 rounded-lg p-3 text-xs text-warning flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div>
            <strong>{counts.ended_pending}</strong> ended lot{counts.ended_pending !== 1 ? 's' : ''} need{counts.ended_pending === 1 ? 's' : ''} a closing-price check.
            The background poller runs hourly, but you can trigger it now with the button on the right.
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, category, brand, lot ID…"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-lg bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted">
          Sort by
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="text-xs px-2 py-1 rounded border border-border bg-surface"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
            className="text-xs px-2 py-1 rounded border border-border bg-surface hover:bg-muted"
            title={sortDir === 'desc' ? 'Descending' : 'Ascending'}
          >
            {sortDir === 'desc' ? '↓' : '↑'}
          </button>
        </label>
        <button
          type="button"
          onClick={handlePollNow}
          disabled={polling}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {polling ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {polling ? 'Polling…' : 'Re-poll now'}
        </button>
        <button
          type="button"
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-muted hover:bg-muted/80 transition-colors"
          title="Reload from storage"
        >
          <RefreshCw size={12} /> Reload
        </button>
        <button
          type="button"
          onClick={handleClearAll}
          disabled={!history.length}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-danger/30 text-danger hover:bg-danger/10 disabled:opacity-50 transition-colors"
          title="Clear all entries"
        >
          <Trash2 size={12} /> Clear all
        </button>
      </div>

      {pollResult && (
        <div className={`rounded-lg p-2.5 text-xs ${
          pollResult.ok ? 'bg-success/10 text-success border border-success/20' : 'bg-danger/10 text-danger border border-danger/20'
        }`}>
          {pollResult.ok
            ? `Re-poll complete — checked ${pollResult.checked}, updated ${pollResult.updated}, errors ${pollResult.errors}`
            : `Poll failed: ${pollResult.msg}`}
        </div>
      )}

      {/* Table / cards */}
      {loading ? (
        <div className="h-32 bg-muted rounded-xl animate-pulse" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={History}
          title={history.length === 0 ? 'No lot history yet' : 'No entries match'}
          description={history.length === 0
            ? 'Scrape some lots in Browse Lots and entries will accumulate here automatically.'
            : 'Try adjusting the current filter or search.'}
        />
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden sm:block bg-surface rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left"><SortHeader label="Last seen" col="lastSeenAt" /></th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Title</th>
                    <th className="px-3 py-2 text-right"><SortHeader label="Final bid" col="finalBid" /></th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Status</th>
                    <th className="px-3 py-2 w-28"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {pageItems.map((h) => {
                    const status = h.finalBidStatus || 'pending';
                    const editing = editingId === h.lotId;
                    const expanded = expandedId === h.lotId;
                    const toggleExpand = () => setExpandedId(expanded ? null : h.lotId);
                    return (
                      <Fragment key={h.lotId}>
                        <tr className="hover:bg-muted/20">
                          <td className="px-3 py-2 text-fg-muted whitespace-nowrap">
                            {h.lastSeenAt ? formatDateTime(h.lastSeenAt) : '—'}
                          </td>
                          <td className="px-3 py-2 max-w-[320px]">
                            <button
                              type="button"
                              onClick={toggleExpand}
                              className="text-fg hover:text-primary text-left truncate w-full"
                              title={h.title}
                            >
                              {h.title || '(untitled)'}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {editing ? (
                              <div className="flex items-center gap-1 justify-end">
                                <input
                                  type="number" step="0.01" min="0"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveOverride(h.lotId); if (e.key === 'Escape') setEditingId(null); }}
                                  autoFocus
                                  className="w-20 bg-warning-subtle border border-warning/40 rounded px-1.5 py-0.5 text-xs font-mono text-right focus:outline-none focus:ring-2 focus:ring-warning/30"
                                />
                                <button type="button" onClick={() => handleSaveOverride(h.lotId)} className="text-success hover:bg-success/10 p-0.5 rounded"><Check size={12} /></button>
                                <button type="button" onClick={() => setEditingId(null)} className="text-fg-muted hover:bg-muted/40 p-0.5 rounded"><X size={12} /></button>
                              </div>
                            ) : h.finalBid != null ? (
                              <span className="font-bold text-success">{fmt(h.finalBid)}</span>
                            ) : (
                              <span className="text-fg-muted">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <StatusBadge status={status} />
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 justify-end">
                              {renderActions(h, { onToggleExpand: toggleExpand, expanded })}
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={5} className="px-3 py-3 bg-muted/20 border-t border-border">
                              {renderExpandBody(h)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination footer (desktop) */}
            <div className="px-4 py-2 border-t border-border flex items-center justify-between gap-2 text-xs text-fg-muted flex-wrap">
              <span>
                {filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}
                {filtered.length > pageSize ? ` (page ${page + 1} of ${totalPages})` : ''}
              </span>
              <div className="flex items-center gap-3">
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button onClick={prev} disabled={page === 0}
                      className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronLeft size={14} /></button>
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      let p = i;
                      if (totalPages > 7) {
                        if (page < 4) p = i;
                        else if (page > totalPages - 5) p = totalPages - 7 + i;
                        else p = page - 3 + i;
                      }
                      return (
                        <button key={p} onClick={() => setPage(p)}
                          className={`w-6 h-6 rounded text-xs font-medium ${p === page ? 'bg-primary text-white' : 'hover:bg-muted text-fg-muted'}`}>
                          {p + 1}
                        </button>
                      );
                    })}
                    <button onClick={next} disabled={page >= totalPages - 1}
                      className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronRight size={14} /></button>
                  </div>
                )}
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="text-xs px-2 py-1 rounded border border-border bg-surface"
                  title="Rows per page"
                >
                  <option value={25}>25 / page</option>
                  <option value={50}>50 / page</option>
                  <option value={100}>100 / page</option>
                </select>
              </div>
            </div>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden space-y-2">
            {pageItems.map((h) => {
              const status = h.finalBidStatus || 'pending';
              const editing = editingId === h.lotId;
              const expanded = expandedId === h.lotId;
              const toggleExpand = () => setExpandedId(expanded ? null : h.lotId);
              return (
                <div
                  key={h.lotId}
                  className="bg-surface rounded-lg border border-border p-3 shadow-sm"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={toggleExpand}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); } }}
                    className="cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-fg-muted">
                        {h.lastSeenAt ? formatDateTime(h.lastSeenAt) : '—'}
                      </span>
                      <StatusBadge status={status} />
                    </div>
                    <p className="text-sm font-medium text-fg mt-1 line-clamp-2">
                      {h.title || '(untitled)'}
                    </p>
                    {editing ? (
                      <div className="flex items-center gap-1 mt-2">
                        <input
                          type="number" step="0.01" min="0"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') handleSaveOverride(h.lotId);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          autoFocus
                          className="w-28 bg-warning-subtle border border-warning/40 rounded px-1.5 py-0.5 text-xs font-mono"
                        />
                        <button type="button" onClick={(e) => { e.stopPropagation(); handleSaveOverride(h.lotId); }} className="text-success hover:bg-success/10 p-1 rounded"><Check size={14} /></button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setEditingId(null); }} className="text-fg-muted hover:bg-muted/40 p-1 rounded"><X size={14} /></button>
                      </div>
                    ) : (
                      <p className={`text-xl font-bold font-mono mt-2 ${h.finalBid != null ? 'text-success' : 'text-fg-subtle'}`}>
                        {h.finalBid != null ? fmt(h.finalBid) : '—'}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    {renderActions(h, { onToggleExpand: toggleExpand, expanded })}
                  </div>
                  {expanded && (
                    <div className="mt-3 pt-3 border-t border-border">
                      {renderExpandBody(h)}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Pagination footer (mobile) */}
            <div className="bg-surface rounded-lg border border-border p-2 flex items-center justify-between gap-2 text-xs text-fg-muted flex-wrap">
              <span>
                {filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}
                {filtered.length > pageSize ? ` (p ${page + 1}/${totalPages})` : ''}
              </span>
              <div className="flex items-center gap-2">
                {totalPages > 1 && (
                  <div className="flex items-center gap-1">
                    <button onClick={prev} disabled={page === 0}
                      className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronLeft size={14} /></button>
                    <span className="text-[11px] text-fg-muted px-1">{page + 1} / {totalPages}</span>
                    <button onClick={next} disabled={page >= totalPages - 1}
                      className="p-1 rounded hover:bg-muted disabled:opacity-30"><ChevronRight size={14} /></button>
                  </div>
                )}
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="text-xs px-2 py-1 rounded border border-border bg-surface"
                  title="Rows per page"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

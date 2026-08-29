import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Star,
  StarOff,
  ExternalLink,
  Clock,
  Trash2,
  SortAsc,
  MessageSquare,
  Loader2,
  AlertTriangle,
  Eye,
} from 'lucide-react';
import { getEbayFeeRate } from '../../utils/fees';
import { fmt, formatDateShort } from '../../utils/formatters';
import EmptyState from '../../components/EmptyState';

// ─── Storage Keys ─────────────────────────────────────────────────────────────

const KEY_WATCHLIST = 'noltech:arbitrage:watchlist';
const KEY_BROWSE    = 'noltech:arbitrage:browse-lots';

// ─── Signal Config (mirrors ArbitrageScanner) ─────────────────────────────────

const SIGNAL_CFG = {
  god_tier:    { label: '\u{1F525} God Tier',     cls: 'bg-accent text-white' },
  steal:       { label: '\u{1F4B0} Steal',        cls: 'bg-success text-white' },
  strong_buy:  { label: 'Strong Buy',      cls: 'bg-success text-white' },
  buy:         { label: 'Buy',             cls: 'bg-success-subtle text-success' },
  watch:       { label: 'Watch',           cls: 'bg-warning-subtle text-warning' },
  pass:        { label: 'Pass',            cls: 'bg-danger-subtle text-danger' },
  dumpster:    { label: '\u{1F5D1}\uFE0F Dumpster',     cls: 'bg-danger text-white' },
};

const SIGNAL_ORDER = { god_tier: 0, steal: 1, strong_buy: 2, buy: 3, watch: 4, pass: 5, dumpster: 6 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeRemaining(endsAt) {
  if (!endsAt) return null;
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return { text: 'Ended', urgent: false, ended: true };
  if (diff < 3600000) return { text: `${Math.floor(diff / 60000)}m left`, urgent: true, ended: false };
  if (diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return { text: `${h}h ${m}m left`, urgent: h < 2, ended: false };
  }
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  return { text: `${d}d ${h}h left`, urgent: false, ended: false };
}



function computeSignal(lot) {
  const m = lot.metrics || {};
  const asking = lot.price || 0;
  const shipping = lot.shippingCost || 0;
  const ebayFeeRate = getEbayFeeRate();

  // Check for manifest-based enrichment totals on the lot object itself
  const estResale = lot._enrichTotals?.estResale || 0;
  const numPriced = lot._enrichTotals?.numPriced || 0;
  const hasManifestPricing = numPriced > 0 && estResale > 0;

  if (hasManifestPricing && asking > 0) {
    const netAfterFees = estResale * (1 - ebayFeeRate) - shipping;
    const margin = netAfterFees > 0 ? (netAfterFees - asking) / netAfterFees : -1;
    if (margin >= 0.80)      return 'god_tier';
    if (margin >= 0.60)      return 'steal';
    if (margin >= 0.40)      return 'strong_buy';
    if (margin >= 0.30)      return 'buy';
    if (margin >= 0.20)      return 'watch';
    if (margin >= 0)         return 'pass';
    return 'dumpster';
  }

  return m.signal || null;
}

// ─── Signal Badge ─────────────────────────────────────────────────────────────

function SignalBadge({ signal }) {
  if (!signal) return null;
  const cfg = SIGNAL_CFG[signal] || { label: signal, cls: 'bg-muted text-fg-muted' };
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ─── Condition Badge ──────────────────────────────────────────────────────────

function ConditionBadge({ condition }) {
  if (!condition) return null;
  const lower = condition.toLowerCase();
  const cls = lower.includes('new') ? 'bg-success-subtle text-success'
    : lower.includes('refurb') ? 'bg-info-subtle text-info'
    : lower.includes('used') || lower.includes('open') ? 'bg-warning-subtle text-warning'
    : lower.includes('salvage') || lower.includes('damage') ? 'bg-danger-subtle text-danger'
    : 'bg-muted text-fg-muted';
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${cls}`}>
      {condition}
    </span>
  );
}

// ─── Watched Lot Card ─────────────────────────────────────────────────────────

function WatchedLotCard({ lot, watchEntry, onRemove, onUpdateNotes }) {
  const [notes, setNotes] = useState(watchEntry.notes || '');
  const [notesOpen, setNotesOpen] = useState(false);
  const saveTimer = useRef(null);

  const { title, source, price, condition, url, metrics, estimation, quantity } = lot;
  const m = metrics || {};
  const bc = m.bidCeilings || {};
  const e = estimation || {};

  const signal = computeSignal(lot);
  const endsAt = lot.auction?.endsAt;
  const remaining = timeRemaining(endsAt);

  // Bid ceiling
  const shipping = lot.shippingCost || 0;
  const ebayFeeRate = getEbayFeeRate();
  const estResale = lot._enrichTotals?.estResale || 0;
  const numPriced = lot._enrichTotals?.numPriced || 0;
  const hasManifestPricing = numPriced > 0 && estResale > 0;

  let ceil30;
  if (hasManifestPricing) {
    const netAfterFees = estResale * (1 - ebayFeeRate) - shipping;
    ceil30 = Math.round(netAfterFees * 0.70);
  } else {
    ceil30 = bc.at30pct ?? null;
  }

  // Est. resale display
  const resaleDisplay = hasManifestPricing
    ? `$${Math.round(estResale).toLocaleString()}`
    : e.estimatedResalePerUnit != null
      ? `$${e.estimatedResalePerUnit.toLocaleString()}/unit`
      : null;

  // Signal-based border
  const borderCls =
    signal === 'god_tier'   ? 'border-accent/40 ring-1 ring-accent/30' :
    signal === 'steal'      ? 'border-success' :
    signal === 'strong_buy' ? 'border-success/60' :
    signal === 'buy'        ? 'border-success/30' :
    signal === 'dumpster'   ? 'border-danger/50' :
    signal === 'pass'       ? 'border-danger/30' : 'border-border';

  // Auto-save notes with debounce
  const handleNotesChange = (val) => {
    setNotes(val);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onUpdateNotes(lot.id, val);
    }, 600);
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  return (
    <div className={`bg-surface rounded-xl border shadow-sm p-4 space-y-3 ${borderCls}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-fg leading-snug line-clamp-2">
            {watchEntry.notes && !notesOpen && <span title="Has notes" className="mr-0.5">📝</span>}
            {title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            {source && (
              <span className="text-[10px] text-fg-muted">{source}</span>
            )}
            <ConditionBadge condition={condition} />
          </div>
        </div>
        <SignalBadge signal={signal} />
      </div>

      {/* Price + bid ceiling row */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[10px] text-fg-muted uppercase tracking-wide">Asking Price</p>
          <p className="text-lg font-bold font-mono text-fg leading-none">
            {price != null ? `$${Number(price).toLocaleString()}` : '$\u2014'}
          </p>
          {quantity > 1 && price > 0 && (
            <p className="text-[10px] text-fg-muted font-mono">
              ${Math.round(price / quantity).toLocaleString()}/unit
            </p>
          )}
        </div>
        {ceil30 != null && ceil30 > 0 && (
          <div className="text-right">
            <p className="text-[10px] text-fg-muted uppercase tracking-wide">Bid Ceiling (30%)</p>
            <p className={`text-lg font-bold font-mono leading-none ${
              price > ceil30 ? 'text-danger' : 'text-success'
            }`}>
              ${ceil30.toLocaleString()}
            </p>
          </div>
        )}
      </div>

      {/* Info row: resale, auction time */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-muted">
        {resaleDisplay && (
          <span>
            Est. Resale: <span className="font-mono font-medium text-fg">{resaleDisplay}</span>
            {hasManifestPricing && (
              <span className="ml-1 text-info">(eBay data)</span>
            )}
          </span>
        )}
        {remaining && (
          <span className={`inline-flex items-center gap-1 ${
            remaining.ended ? 'text-fg-muted' :
            remaining.urgent ? 'text-danger font-medium' : ''
          }`}>
            {remaining.urgent && !remaining.ended && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
            )}
            <Clock size={11} />
            {remaining.ended ? 'Ended' : `Ends ${endsAt ? formatDateShort(endsAt) : ''}`}
            <span className={remaining.urgent ? 'font-semibold' : 'font-medium'}>
              ({remaining.text})
            </span>
          </span>
        )}
      </div>

      {/* Notes section */}
      <div>
        <button
          onClick={() => setNotesOpen(!notesOpen)}
          className="inline-flex items-center gap-1 text-[11px] text-fg-muted hover:text-fg transition-colors"
        >
          <MessageSquare size={11} />
          {notes ? 'Edit notes' : 'Add notes'}
        </button>
        {notesOpen && (
          <textarea
            value={notes}
            onChange={(e) => handleNotesChange(e.target.value)}
            placeholder="Personal notes about this lot..."
            className="mt-1.5 w-full text-xs border border-border rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary bg-muted/40"
            rows={2}
          />
        )}
      </div>

      {/* Added date + action buttons */}
      <div className="flex items-center justify-between pt-1 border-t border-border-subtle">
        <span className="text-[10px] text-fg-muted">
          Watched {formatDateShort(watchEntry.addedAt)}
        </span>
        <div className="flex items-center gap-1.5">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-secondary hover:text-primary transition-colors px-2 py-1 rounded-md hover:bg-secondary/5"
            >
              <ExternalLink size={12} />
              View Listing
            </a>
          )}
          <button
            onClick={() => onRemove(lot.id)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-danger/70 hover:text-danger transition-colors px-2 py-1 rounded-md hover:bg-danger-subtle"
            title="Remove from watchlist"
          >
            <StarOff size={12} />
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm p-4 space-y-3 animate-pulse">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 space-y-2">
          <div className="h-4 bg-muted rounded w-3/4" />
          <div className="h-3 bg-muted rounded w-1/2" />
        </div>
        <div className="h-5 bg-muted rounded-full w-16" />
      </div>
      <div className="flex justify-between">
        <div className="space-y-1">
          <div className="h-3 bg-muted rounded w-16" />
          <div className="h-6 bg-muted rounded w-20" />
        </div>
        <div className="space-y-1 text-right">
          <div className="h-3 bg-muted rounded w-20 ml-auto" />
          <div className="h-6 bg-muted rounded w-16 ml-auto" />
        </div>
      </div>
      <div className="h-3 bg-muted rounded w-2/3" />
    </div>
  );
}

// ─── Main Watchlist Component ─────────────────────────────────────────────────

export default function Watchlist() {
  const [watchMap, setWatchMap]     = useState(null);   // { [lotId]: { addedAt, notes } }
  const [allLots, setAllLots]       = useState(null);   // full browse-lots array
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [sortBy, setSortBy]         = useState('added'); // 'added' | 'ending' | 'signal'

  // ── Load data ──
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [wl, lots] = await Promise.all([
        window.storage.get(KEY_WATCHLIST),
        window.storage.get(KEY_BROWSE),
      ]);
      setWatchMap(wl || {});
      // browse-lots storage is { lots: [...], enrichments: {...}, ... }, not a raw array
      setAllLots(lots?.lots || []);
    } catch (err) {
      console.error('Watchlist storage error:', err);
      setError(err.message || "Couldn't load watchlist data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Persist watchlist ──
  const persistWatchlist = useCallback(async (updated) => {
    try {
      await window.storage.set(KEY_WATCHLIST, updated);
      setWatchMap(updated);
    } catch (err) {
      console.error('Failed to save watchlist:', err);
    }
  }, []);

  // ── Remove from watchlist ──
  const handleRemove = useCallback((lotId) => {
    const updated = { ...watchMap };
    delete updated[lotId];
    persistWatchlist(updated);
  }, [watchMap, persistWatchlist]);

  // ── Clear all ──
  const [clearConfirm, setClearConfirm] = useState(false);
  const handleClearAll = useCallback(() => {
    persistWatchlist({});
    setClearConfirm(false);
  }, [persistWatchlist]);

  // ── Update notes ──
  const handleUpdateNotes = useCallback((lotId, notes) => {
    const updated = { ...watchMap, [lotId]: { ...watchMap[lotId], notes } };
    persistWatchlist(updated);
  }, [watchMap, persistWatchlist]);

  // ── Build watched lots list ──
  const watchedLots = (() => {
    if (!watchMap || !allLots) return [];
    const lotIndex = {};
    for (const lot of allLots) {
      lotIndex[lot.id] = lot;
    }
    return Object.keys(watchMap)
      .map((id) => ({ lot: lotIndex[id], entry: watchMap[id] }))
      .filter((item) => item.lot != null);
  })();

  // ── Sort ──
  const sortedLots = [...watchedLots].sort((a, b) => {
    if (sortBy === 'ending') {
      const aEnd = a.lot.auction?.endsAt ? new Date(a.lot.auction.endsAt).getTime() : Infinity;
      const bEnd = b.lot.auction?.endsAt ? new Date(b.lot.auction.endsAt).getTime() : Infinity;
      return aEnd - bEnd;
    }
    if (sortBy === 'signal') {
      const aS = SIGNAL_ORDER[computeSignal(a.lot)] ?? 99;
      const bS = SIGNAL_ORDER[computeSignal(b.lot)] ?? 99;
      if (aS !== bS) return aS - bS;
      // within same signal, sort by ending soonest
      const aEnd = a.lot.auction?.endsAt ? new Date(a.lot.auction.endsAt).getTime() : Infinity;
      const bEnd = b.lot.auction?.endsAt ? new Date(b.lot.auction.endsAt).getTime() : Infinity;
      return aEnd - bEnd;
    }
    // default: added newest first
    const aDate = a.entry.addedAt ? new Date(a.entry.addedAt).getTime() : 0;
    const bDate = b.entry.addedAt ? new Date(b.entry.addedAt).getTime() : 0;
    return bDate - aDate;
  });

  const watchCount = Object.keys(watchMap || {}).length;

  // ── Loading state ──
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-6 bg-muted rounded w-40 animate-pulse" />
          <div className="h-8 bg-muted rounded w-24 animate-pulse" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="bg-danger-subtle rounded-full p-4 mb-4">
          <AlertTriangle size={28} className="text-danger" />
        </div>
        <p className="text-sm font-semibold text-fg mb-1">Couldn't load watchlist</p>
        <p className="text-xs text-fg-muted mb-4">{error}</p>
        <button
          onClick={loadData}
          className="text-xs font-medium text-secondary hover:text-primary transition-colors px-4 py-2 border border-secondary/30 rounded-lg hover:bg-secondary/5"
        >
          Try Again
        </button>
      </div>
    );
  }

  // ── Empty state ──
  if (watchCount === 0 || sortedLots.length === 0) {
    return (
      <EmptyState
        icon={Eye}
        title="No lots watched yet"
        description="Star lots in Browse Lots to add them here. Watched lots appear in this dedicated view so you can track them easily."
      />
    );
  }

  // ── Main view ──
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Star size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-fg">
            {sortedLots.length} lot{sortedLots.length !== 1 ? 's' : ''} watched
          </h2>
        </div>

        <div className="flex items-center gap-2">
          {/* Sort picker */}
          <div className="flex items-center gap-1.5">
            <SortAsc size={13} className="text-fg-muted" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-xs border border-border rounded-lg px-2 py-1.5 bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary"
            >
              <option value="added">Date Added (Newest)</option>
              <option value="ending">Auction End (Soonest)</option>
              <option value="signal">Best Deal First</option>
            </select>
          </div>

          {/* Clear all */}
          {clearConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-danger">Clear all?</span>
              <button onClick={handleClearAll} className="text-xs bg-danger text-white px-3 py-1.5 rounded-lg hover:bg-danger/90 transition-colors">Yes</button>
              <button onClick={() => setClearConfirm(false)} className="text-xs border border-border text-fg-muted px-3 py-1.5 rounded-lg hover:bg-bg transition-colors">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => setClearConfirm(true)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-danger/70 hover:text-danger transition-colors px-2.5 py-1.5 rounded-lg border border-danger/30 hover:border-danger/50 hover:bg-danger-subtle"
            >
              <Trash2 size={12} />
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Lot cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {sortedLots.map(({ lot, entry }) => (
          <WatchedLotCard
            key={lot.id}
            lot={lot}
            watchEntry={entry}
            onRemove={handleRemove}
            onUpdateNotes={handleUpdateNotes}
          />
        ))}
      </div>
    </div>
  );
}

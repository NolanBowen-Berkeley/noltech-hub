// ─── Listing Aging Dashboard ─────────────────────────────────────────────────
// Single-pane view of every active listing organized by how long it's been
// sitting unsold. Surfaces the "dead money" problem (capital tied up in
// stale listings) and provides bulk actions: drop prices, end listings, or
// queue for auto-relist. Designed to be the weekly review tool — open it,
// pick the worst offenders, take action in under 5 minutes.
//
// Pulls from existing inventory state (items where status === 'listed').
// No new storage keys; piggybacks on `noltech:settings:listing-aging-days`
// for the user's chosen threshold (default 45 days).

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock, AlertTriangle, TrendingDown, Search, ExternalLink, Trash2,
  RefreshCw, ChevronDown, ChevronUp, DollarSign, Filter, X, Check, Tag,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt, formatDate } from '../../utils/formatters';
import { Card, Button, Input, Label, Badge, Stat } from '../../components/ui';
import EmptyState from '../../components/EmptyState';
import { cn } from '../../components/ui/cn';
import eventBus from '../../services/eventBus';

const KEY_THRESHOLD = 'noltech:settings:listing-aging-days';

// Age buckets — color-coded escalation from fresh to dead.
const BUCKETS = [
  { id: 'fresh',     label: 'Fresh',     min: 0,   max: 30,  color: 'success', desc: '< 30 days listed — too early to drop prices' },
  { id: 'cooling',   label: 'Cooling',   min: 30,  max: 60,  color: 'info',    desc: '30-60 days — start watching, consider a small drop' },
  { id: 'aging',     label: 'Aging',     min: 60,  max: 90,  color: 'warning', desc: '60-90 days — drop price or end the listing' },
  { id: 'stale',     label: 'Stale',     min: 90,  max: 180, color: 'danger',  desc: '90-180 days — dead capital, aggressive action' },
  { id: 'dead',      label: 'Dead',     min: 180, max: Infinity, color: 'danger', desc: '> 6 months — liquidate at any price' },
];

function bucketFor(days) {
  return BUCKETS.find((b) => days >= b.min && days < b.max) || BUCKETS[BUCKETS.length - 1];
}

// Calculate listing age in days. Prefers `listedAt` (set by eBay sync when
// a sale flips status back to 'listed'), then `dateAdded`, then lot
// purchaseDate as the worst-case fallback.
function ageDays(item, lot) {
  const candidates = [item.listedAt, item.dateAdded, lot?.purchaseDate]
    .filter(Boolean)
    .map((s) => new Date(s).getTime())
    .filter(Number.isFinite);
  if (candidates.length === 0) return 0;
  const ts = Math.min(...candidates);   // oldest = most conservative
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

export default function ListingAgingDashboard() {
  const { state, dispatch } = useApp();
  const [thresholdDays, setThresholdDays] = useState(45);
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch]     = useState('');
  const [bucketFilter, setBucketFilter] = useState('all');
  const [sortBy, setSortBy]     = useState('age-desc');
  const [bulkDropPct, setBulkDropPct] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    window.storage.get(KEY_THRESHOLD)
      .then((v) => { if (typeof v === 'number' && v > 0) setThresholdDays(v); })
      .catch(() => {});
  }, []);

  // Flatten all listed items + computed age
  const allListed = useMemo(() => {
    const out = [];
    for (const lot of (state.lots || [])) {
      for (const item of (lot.items || [])) {
        if (item.status !== 'listed') continue;
        if (!item.listingPrice) continue;
        const age = ageDays(item, lot);
        const price = parseFloat(item.listingPrice) || 0;
        const cost  = parseFloat(item.costBasis) || (parseFloat(lot.cost) / Math.max(1, lot.itemCount || lot.items?.length || 1));
        const projMargin = price > 0 ? ((price - cost) / price) * 100 : 0;
        out.push({
          id: item.id,
          lotId: lot.id,
          lotName: lot.sourceName || lot.name || lot.title || lot.id,
          name: `${item.brand || ''} ${item.model || ''}`.trim() || item.sku || 'Item',
          sku: item.sku || item.serialNumber || '',
          listingPrice: price,
          costBasis: cost,
          projMargin,
          age,
          bucket: bucketFor(age),
          ebayItemId: item.ebayItemId,
          category: item.category || '',
          lastPriceChange: item.lastPriceChange || null,
        });
      }
    }
    return out;
  }, [state.lots]);

  // Bucket counts (drives the tab strip)
  const bucketCounts = useMemo(() => {
    const counts = {};
    let totalValue = 0;
    let staleValue = 0;
    for (const item of allListed) {
      counts[item.bucket.id] = (counts[item.bucket.id] || 0) + 1;
      totalValue += item.listingPrice;
      if (item.age >= thresholdDays) staleValue += item.listingPrice;
    }
    return { counts, totalValue, staleValue, total: allListed.length };
  }, [allListed, thresholdDays]);

  // Filtered + sorted view
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = allListed;
    if (bucketFilter !== 'all') list = list.filter((i) => i.bucket.id === bucketFilter);
    if (q) {
      list = list.filter((i) =>
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        i.lotName.toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sortBy === 'age-desc')   return b.age - a.age;
      if (sortBy === 'age-asc')    return a.age - b.age;
      if (sortBy === 'price-desc') return b.listingPrice - a.listingPrice;
      if (sortBy === 'price-asc')  return a.listingPrice - b.listingPrice;
      if (sortBy === 'margin-asc') return a.projMargin - b.projMargin;
      return 0;
    });
    return sorted;
  }, [allListed, search, bucketFilter, sortBy]);

  // ── Selection helpers ─────────────────────────────────────────────────
  const toggleOne = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === visible.length && visible.length > 0) return new Set();
      return new Set(visible.map((i) => i.id));
    });
  }, [visible]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const selectedItems = useMemo(
    () => visible.filter((i) => selected.has(i.id)),
    [visible, selected],
  );

  const selectedValue = selectedItems.reduce((s, i) => s + i.listingPrice, 0);

  // ── Bulk actions ──────────────────────────────────────────────────────
  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  // Drop selected items' prices by a percentage. Math is at the per-item
  // level so each item gets a price proportional to its own listing price.
  const handleBulkDrop = useCallback(async () => {
    const pct = parseFloat(bulkDropPct);
    if (!isFinite(pct) || pct <= 0 || pct >= 100) {
      showToast('Enter a percentage between 1 and 99', 'error');
      return;
    }
    if (selectedItems.length === 0) return;
    if (!confirm(`Drop ${selectedItems.length} listing${selectedItems.length !== 1 ? 's' : ''} by ${pct}%? This updates the local item record; eBay sync will push the change next time it runs.`)) return;

    setBusy(true);
    const factor = 1 - pct / 100;
    for (const item of selectedItems) {
      const newPrice = Math.round(item.listingPrice * factor * 100) / 100;
      dispatch({
        type: 'UPDATE_ITEM',
        id: item.id,
        updates: {
          listingPrice: newPrice,
          lastPriceChange: new Date().toISOString(),
        },
      });
    }
    setBusy(false);
    setSelected(new Set());
    setBulkDropPct('');
    showToast(`Dropped ${selectedItems.length} listing${selectedItems.length !== 1 ? 's' : ''} by ${pct}%. Total reduction: ${fmt(selectedValue * (pct / 100))}.`);
  }, [bulkDropPct, selectedItems, selectedValue, dispatch]);

  // Flip selected items to "ended" status so they stop appearing as listed.
  // Doesn't actually call eBay End API — that happens via separate sync.
  const handleBulkEnd = useCallback(async () => {
    if (selectedItems.length === 0) return;
    if (!confirm(`Mark ${selectedItems.length} listing${selectedItems.length !== 1 ? 's' : ''} as ended? They'll move out of the listed pool. To actually end them on eBay, use the EndListing flow.`)) return;
    setBusy(true);
    for (const item of selectedItems) {
      dispatch({
        type: 'UPDATE_ITEM',
        id: item.id,
        updates: { status: 'ended', endedAt: new Date().toISOString() },
      });
    }
    setBusy(false);
    setSelected(new Set());
    showToast(`Marked ${selectedItems.length} listing${selectedItems.length !== 1 ? 's' : ''} as ended.`);
  }, [selectedItems, dispatch]);

  // Queue for AutoRelist — bumps a hint on the item that AutoRelist will pick up.
  const handleQueueRelist = useCallback(async () => {
    if (selectedItems.length === 0) return;
    setBusy(true);
    for (const item of selectedItems) {
      dispatch({
        type: 'UPDATE_ITEM',
        id: item.id,
        updates: { queuedForRelist: true, queuedAt: new Date().toISOString() },
      });
    }
    setBusy(false);
    setSelected(new Set());
    eventBus.emit('notification:push', {
      type: 'info',
      title: 'Queued for re-list',
      message: `${selectedItems.length} listing${selectedItems.length !== 1 ? 's' : ''} flagged. AutoRelist will pick them up on next run.`,
    });
    showToast(`Queued ${selectedItems.length} for re-list.`);
  }, [selectedItems, dispatch]);

  // ── Persist threshold inline ──────────────────────────────────────────
  const updateThreshold = useCallback(async (n) => {
    setThresholdDays(n);
    try { await window.storage.set(KEY_THRESHOLD, n); } catch (e) { console.error('[aging] threshold save:', e); }
  }, []);

  // ── Render ────────────────────────────────────────────────────────────

  if (allListed.length === 0) {
    return (
      <EmptyState
        icon={Tag}
        title="No active listings"
        description="When you have items listed on eBay, they'll appear here grouped by how long they've been sitting unsold."
      />
    );
  }

  const allSelected = selected.size === visible.length && visible.length > 0;
  const someSelected = selected.size > 0 && selected.size < visible.length;

  return (
    <div className="space-y-3">
      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Card padding="sm" radius="lg">
          <Stat
            label="Active Listings"
            value={bucketCounts.total}
            sub={`${fmt(bucketCounts.totalValue)} listed`}
            intent="neutral"
            size="md"
          />
        </Card>
        <Card padding="sm" radius="lg">
          <Stat
            label={`Stale ≥ ${thresholdDays}d`}
            value={allListed.filter((i) => i.age >= thresholdDays).length}
            sub={`${fmt(bucketCounts.staleValue)} tied up`}
            intent={bucketCounts.staleValue > 1000 ? 'danger' : 'warning'}
            size="md"
          />
        </Card>
        <Card padding="sm" radius="lg">
          <Stat
            label="Oldest"
            value={allListed.length > 0 ? `${Math.max(...allListed.map((i) => i.age))}d` : '—'}
            sub={allListed.length > 0 ? allListed.sort((a, b) => b.age - a.age)[0]?.name?.slice(0, 24) : ''}
            intent="warning"
            size="md"
          />
        </Card>
        <Card padding="sm" radius="lg">
          <Stat
            label="Avg Age"
            value={allListed.length > 0 ? `${Math.round(allListed.reduce((s, i) => s + i.age, 0) / allListed.length)}d` : '—'}
            sub={`across ${allListed.length} item${allListed.length !== 1 ? 's' : ''}`}
            intent="neutral"
            size="md"
          />
        </Card>
      </div>

      {/* Bucket tabs */}
      <Card padding="sm" radius="lg">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setBucketFilter('all')}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors',
              bucketFilter === 'all'
                ? 'bg-primary text-white shadow-sm'
                : 'bg-muted/40 text-fg-muted hover:text-fg hover:bg-muted',
            )}
          >
            All
            <span className={cn('inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full text-[10px] font-mono', bucketFilter === 'all' ? 'bg-surface/20' : 'bg-black/10')}>
              {bucketCounts.total}
            </span>
          </button>
          {BUCKETS.map((b) => {
            const count = bucketCounts.counts[b.id] || 0;
            const active = bucketFilter === b.id;
            const tone = {
              success: 'text-success',
              info:    'text-info',
              warning: 'text-warning',
              danger:  'text-danger',
            }[b.color];
            return (
              <button
                key={b.id}
                onClick={() => setBucketFilter(b.id)}
                disabled={count === 0}
                title={b.desc}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  active
                    ? 'bg-primary text-white shadow-sm'
                    : `bg-muted/40 ${tone} hover:bg-muted`,
                )}
              >
                {b.label}
                <span className={cn(
                  'inline-flex items-center justify-center min-w-[20px] h-4 px-1 rounded-full text-[10px] font-mono',
                  active ? 'bg-surface/20' : 'bg-black/10',
                )}>{count}</span>
                <span className="text-[10px] opacity-60 hidden sm:inline">
                  {b.min}{b.max === Infinity ? '+' : `-${b.max}`}d
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Search + threshold + filters toggle */}
      <Card padding="sm" radius="lg" className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-fg-subtle pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU, item, or lot…"
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] uppercase tracking-wider text-fg-muted mb-0">Stale ≥</Label>
          <input
            type="number"
            min="1"
            max="365"
            value={thresholdDays}
            onChange={(e) => updateThreshold(parseInt(e.target.value, 10) || 45)}
            className="w-16 border border-border rounded-lg px-2 py-1.5 text-xs font-mono text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <span className="text-[10px] text-fg-muted">days</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[10px] uppercase tracking-wider text-fg-muted mb-0">Sort</Label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="border border-border rounded-lg px-2 py-1.5 text-xs text-fg bg-surface focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="age-desc">Oldest first</option>
            <option value="age-asc">Newest first</option>
            <option value="price-desc">Highest price</option>
            <option value="price-asc">Lowest price</option>
            <option value="margin-asc">Lowest margin (dump these)</option>
          </select>
        </div>
      </Card>

      {/* Bulk action bar — appears when at least one item selected */}
      <AnimatePresence initial={false}>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <Card padding="sm" radius="lg" className="bg-accent-subtle/40 border-accent/30 flex flex-wrap items-center gap-3">
              <div className="text-sm font-semibold text-fg shrink-0 flex items-center gap-2">
                <span className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-md bg-accent text-accent-fg text-xs tabular-nums">
                  {selected.size}
                </span>
                selected · {fmt(selectedValue)} value
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-[10px] mb-0">Drop:</Label>
                <Input
                  type="number"
                  min="1"
                  max="99"
                  step="1"
                  value={bulkDropPct}
                  onChange={(e) => setBulkDropPct(e.target.value)}
                  placeholder="10"
                  className="w-16"
                />
                <span className="text-xs text-fg-muted">%</span>
                <Button variant="warning" size="sm" onClick={handleBulkDrop} disabled={busy}>
                  <TrendingDown /> Apply
                </Button>
              </div>
              <Button variant="secondary" size="sm" onClick={handleQueueRelist} disabled={busy}>
                <RefreshCw /> Queue re-list
              </Button>
              <Button variant="danger" size="sm" onClick={handleBulkEnd} disabled={busy}>
                <Trash2 /> End listings
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                <X /> Clear
              </Button>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className={cn(
              'rounded-lg p-3 text-sm border',
              toast.type === 'error' ? 'bg-danger-subtle text-danger border-danger/30' :
                                       'bg-success-subtle text-success border-success/30',
            )}
          >
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Listings table */}
      <Card padding="none" radius="lg" className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-sm font-semibold text-fg">
            {visible.length} {bucketFilter === 'all' ? 'listing' : `${BUCKETS.find((b) => b.id === bucketFilter)?.label || bucketFilter} listing`}{visible.length !== 1 ? 's' : ''}
          </h3>
          <span className="text-xs text-fg-muted">
            {fmt(visible.reduce((s, i) => s + i.listingPrice, 0))} total
          </span>
        </div>
        {visible.length === 0 ? (
          <div className="p-8 text-center text-sm text-fg-muted">
            No listings match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 border-b border-border-subtle">
                <tr>
                  <th className="px-3 py-2 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected; }}
                      onChange={toggleAll}
                      className="accent-accent size-3.5 cursor-pointer"
                    />
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-fg-muted">Age</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-fg-muted">Item</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-fg-muted">Lot</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-fg-muted">Price</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-fg-muted">Margin</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-fg-muted">Last Change</th>
                  <th className="px-3 py-2 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {visible.map((item) => {
                  const sel = selected.has(item.id);
                  const tone = {
                    success: 'text-success',
                    info:    'text-info',
                    warning: 'text-warning',
                    danger:  'text-danger',
                  }[item.bucket.color];
                  return (
                    <tr
                      key={item.id}
                      className={cn('hover:bg-muted/30 transition-colors', sel && 'bg-accent-subtle/40')}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => toggleOne(item.id)}
                          className="accent-accent size-3.5 cursor-pointer"
                        />
                      </td>
                      <td className={cn('px-3 py-2 font-mono text-xs tabular-nums whitespace-nowrap', tone)}>
                        {item.age}d
                        <span className="ml-1 text-[10px] opacity-70">{item.bucket.label}</span>
                      </td>
                      <td className="px-3 py-2 max-w-[260px]">
                        <div className="truncate text-fg" title={item.name}>{item.name}</div>
                        {item.sku && <div className="text-[10px] font-mono text-fg-subtle">{item.sku}</div>}
                      </td>
                      <td className="px-3 py-2 text-xs text-fg-muted max-w-[160px] truncate" title={item.lotName}>
                        {item.lotName}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">
                        {fmt(item.listingPrice)}
                      </td>
                      <td className={cn(
                        'px-3 py-2 text-right font-mono tabular-nums text-xs',
                        item.projMargin < 0 ? 'text-danger' :
                        item.projMargin < 20 ? 'text-warning' : 'text-success',
                      )}>
                        {item.projMargin.toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">
                        {item.lastPriceChange
                          ? formatDate(item.lastPriceChange)
                          : <span className="text-fg-subtle italic">never</span>}
                      </td>
                      <td className="px-3 py-2">
                        {item.ebayItemId && (
                          <a
                            href={`https://www.ebay.com/itm/${item.ebayItemId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-fg-muted hover:text-primary"
                            title="Open on eBay"
                          >
                            <ExternalLink size={13} />
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

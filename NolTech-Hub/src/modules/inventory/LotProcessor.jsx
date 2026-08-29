// ─── Lot Processor ────────────────────────────────────────────────────────────
// Workstation view for processing lot items one by one.
// Select a lot → see all items → update status, grade, notes, disposition inline.
// Tracks progress through the lot with a progress bar.

import { useState, useMemo, useCallback, useEffect, lazy, Suspense } from 'react';
import {
  Package, CheckCircle, AlertTriangle, ArrowRight, ChevronDown, ChevronUp,
  Wrench, Tag, Truck, Recycle, DollarSign, Clipboard, Search, X, EyeOff, Eye,
  Boxes,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ITEM_STATUSES, GRADES, CONDITIONS } from '../../utils/constants';
import { fmt, formatDate } from '../../utils/formatters';
import eventBus from '../../services/eventBus';
import EmptyState from '../../components/EmptyState';
import { Modal } from '../../components/ui';

// Lazy-loaded so the testing checklist (~14kb gzipped) doesn't bloat
// LotProcessor's initial chunk. Modal opens on Test click; first open
// triggers the dynamic import.
const TestingChecklist = lazy(() => import('./TestingChecklist'));

const HIDDEN_LOTS_KEY = 'noltech:operations:hidden-lots';

const DISPOSITION_OPTIONS = [
  { value: '', label: 'Undecided', cls: 'bg-muted text-fg-muted' },
  { value: 'sell_whole', label: 'Sell Whole', cls: 'bg-success-subtle text-success' },
  { value: 'part_out', label: 'Part Out', cls: 'bg-warning-subtle text-warning' },
  { value: 'sell_as_is', label: 'Sell As-Is', cls: 'bg-info-subtle text-info' },
  { value: 'repair', label: 'Repair', cls: 'bg-accent-subtle text-accent' },
  { value: 'recycle', label: 'Recycle', cls: 'bg-danger-subtle text-danger' },
];

const STATUS_ICON = {
  received: Package, testing: Clipboard, listed: Tag,
  sold: DollarSign, parted_out: Wrench, recycled: Recycle,
  repair: Wrench,
};

export default function LotProcessor() {
  const { state, dispatch } = useApp();
  const [selectedLotId, setSelectedLotId] = useState(null);
  const [expandedItem, setExpandedItem] = useState(null);
  const [search, setSearch] = useState('');
  // null = closed; item object = TestingChecklist modal open for that item.
  // Mirrors ItemManager's compsItem pattern.
  const [testingItem, setTestingItem] = useState(null);

  // Hidden lot IDs — per-device preference (not synced). Persists across
  // sessions so a hidden lot stays hidden after reload.
  const [hiddenLots, setHiddenLots] = useState(() => new Set());
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    window.storage.get(HIDDEN_LOTS_KEY)
      .then((v) => { if (Array.isArray(v)) setHiddenLots(new Set(v)); })
      .catch((e) => console.error('[LotProcessor] hidden lots load failed:', e));
  }, []);
  const persistHidden = (set) => {
    window.storage.set(HIDDEN_LOTS_KEY, Array.from(set))
      .then(() => window.dispatchEvent(new CustomEvent('noltech:hidden-lots-changed')))
      .catch((e) => console.error('[LotProcessor] hidden lots save failed:', e));
  };

  // Auto-close the test modal + toast on successful save. Both gated inside
  // the setter so a save fired by a different item (TestingChecklist's
  // lot-mode navigation moves to item B while modal still tracks item A,
  // or a save fired by another mounted instance) doesn't produce a stray
  // toast. testResults + conditionGrade are written back by useEventBridge.
  useEffect(() => {
    const off = eventBus.on('test:completed', ({ itemId, grade, passRate }) => {
      setTestingItem((cur) => {
        if (cur && cur.id === itemId) {
          eventBus.emit('notification:push', {
            type:    'success',
            title:   'Test saved',
            message: `Grade ${grade} · ${Math.round((passRate || 0) * 100)}% pass`,
          });
          return null;
        }
        return cur;
      });
    });
    return off;
  }, []);

  // 'tested' badge + Re-test label derive from the same storage TestingChecklist
  // reads (CHECKLIST_KEY) so the affordance can't drift from what the modal
  // actually pre-fills. Refresh after every save.
  const [savedChecklists, setSavedChecklists] = useState({});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.storage.get('noltech:testing:checklists')
        .then((v) => { if (!cancelled && v && typeof v === 'object') setSavedChecklists(v); })
        .catch(() => { /* default {} is fine */ });
    };
    load();
    const off = eventBus.on('test:completed', () => load());
    return () => { cancelled = true; off(); };
  }, []);
  const hideLot = (lotId) => {
    setHiddenLots((prev) => {
      const next = new Set(prev);
      next.add(lotId);
      persistHidden(next);
      return next;
    });
    if (selectedLotId === lotId) setSelectedLotId(null);
  };
  const unhideLot = (lotId) => {
    setHiddenLots((prev) => {
      const next = new Set(prev);
      next.delete(lotId);
      persistHidden(next);
      return next;
    });
  };

  // Get processing/received lots (ones with items to work through)
  const activeLots = useMemo(() =>
    state.lots
      .filter(l => l.status === 'received' || l.status === 'processing')
      .filter(l => showHidden || !hiddenLots.has(l.id))
      .sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0)),
    [state.lots, hiddenLots, showHidden]
  );

  const allLots = useMemo(() =>
    state.lots
      .filter(l => (l.items || []).length > 0)
      .filter(l => showHidden || !hiddenLots.has(l.id))
      .sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0)),
    [state.lots, hiddenLots, showHidden]
  );

  // Multi-select for bulk-update of grade / disposition / status across many
  // items at once. Cleared when the user switches lots.
  const [selectedItemIds, setSelectedItemIds] = useState(() => new Set());
  const [bulkGrade, setBulkGrade] = useState('');
  const [bulkDisp, setBulkDisp] = useState('');
  const [bulkStatus, setBulkStatus] = useState('');
  useEffect(() => { setSelectedItemIds(new Set()); }, [selectedLotId]);
  const toggleItemPick = useCallback((itemId) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);
  const clearItemPicks = useCallback(() => setSelectedItemIds(new Set()), []);

  const selectedLot = state.lots.find(l => l.id === selectedLotId);
  const items = useMemo(() => {
    if (!selectedLot) return [];
    const q = search.toLowerCase();
    return (selectedLot.items || []).filter(i => {
      if (!q) return true;
      return [i.brand, i.model, i.serialNumber, i.notes].some(f => f && f.toLowerCase().includes(q));
    });
  }, [selectedLot, search]);

  // Progress stats for selected lot
  const progress = useMemo(() => {
    if (!selectedLot) return null;
    const all = selectedLot.items || [];
    const total = all.length;
    if (total === 0) return null;
    const processed = all.filter(i => i.status && i.status !== 'received').length;
    const tested = all.filter(i => i.conditionGrade).length;
    const listed = all.filter(i => i.status === 'listed' || i.status === 'sold').length;
    const disposed = all.filter(i => i.disposition).length;
    return { total, processed, tested, listed, disposed, pct: Math.round((processed / total) * 100) };
  }, [selectedLot]);

  const updateItem = useCallback((itemId, updates) => {
    dispatch({ type: 'UPDATE_ITEM', id: itemId, updates });
  }, [dispatch]);

  const quickStatus = (itemId, status) => {
    updateItem(itemId, { status });
    if (status === 'repair') {
      eventBus.emit('notification:push', { type: 'info', title: 'Sent to Repair', message: 'Item moved to repair queue' });
    }
  };

  const quickGrade = (itemId, grade) => {
    // Auto-suggest disposition based on grade
    const autoDisposition =
      (grade === 'A' || grade === 'B') ? 'sell_whole' :
      grade === 'C' ? 'sell_as_is' :
      (grade === 'D' || grade === 'F') ? 'part_out' : null;

    const updates = { conditionGrade: grade };
    // Only auto-set disposition if item doesn't already have one
    const currentItem = items.find(i => i.id === itemId);
    if (autoDisposition && !currentItem?.disposition) {
      updates.disposition = autoDisposition;
    }
    updateItem(itemId, updates);
  };

  const quickDisposition = (itemId, disposition) => {
    updateItem(itemId, { disposition });
    // Auto-set status based on disposition
    if (disposition === 'repair') quickStatus(itemId, 'repair');
    if (disposition === 'recycle') quickStatus(itemId, 'recycled');
  };

  // Auto-update lot status when all items processed
  const checkLotCompletion = useCallback(() => {
    if (!selectedLot) return;
    const all = selectedLot.items || [];
    if (all.length === 0) return;
    const allProcessed = all.every(i => i.status && i.status !== 'received');
    if (allProcessed && selectedLot.status !== 'processing') {
      dispatch({ type: 'UPDATE_LOT', id: selectedLot.id, updates: { status: 'processing' } });
    }
    // Promote to 'listed' once every item lands in a terminal state. Guard
    // matches the value being written so the dispatch + toast don't loop
    // every render once a lot is already promoted.
    const allListed = all.every(i => ['listed', 'sold', 'parted_out', 'recycled'].includes(i.status));
    if (allListed && selectedLot.status !== 'listed') {
      dispatch({ type: 'UPDATE_LOT', id: selectedLot.id, updates: { status: 'listed' } });
      eventBus.emit('notification:push', { type: 'success', title: 'Lot Fully Processed', message: `All ${all.length} items processed` });
    }
  }, [selectedLot, dispatch]);

  // ── Lot selector ──
  if (!selectedLotId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-fg">Select a Lot to Process</h2>
            <p className="text-xs text-fg-muted mt-0.5">Pick a lot to work through its items</p>
          </div>
          {hiddenLots.size > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-border bg-surface text-fg-muted hover:bg-muted/40 transition-colors"
              title={showHidden ? 'Stop showing hidden lots' : 'Show hidden lots so you can unhide them'}
            >
              {showHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              {showHidden ? `Showing hidden (${hiddenLots.size})` : `${hiddenLots.size} hidden`}
            </button>
          )}
        </div>

        {activeLots.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">Active Lots (Received / Processing)</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {activeLots.map(lot => {
                const itemCount = (lot.items || []).length;
                const processed = (lot.items || []).filter(i => i.status !== 'received').length;
                const pct = itemCount > 0 ? Math.round((processed / itemCount) * 100) : 0;
                const isHidden = hiddenLots.has(lot.id);
                return (
                  <div key={lot.id} className="relative group">
                    {/* Hide / unhide toggle — top-right of the card. Stops
                        click propagation so it doesn't open the lot. */}
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (isHidden) unhideLot(lot.id);
                        else hideLot(lot.id);
                      }}
                      className={`absolute top-2 right-2 z-10 p-1 rounded-md transition-all ${
                        isHidden
                          ? 'opacity-100 bg-warning-subtle text-warning'
                          : 'opacity-50 hover:opacity-100 bg-surface/80 border border-border text-fg-muted hover:text-fg'
                      }`}
                      title={isHidden ? 'Unhide this lot' : 'Hide this lot from Operations'}
                    >
                      {isHidden ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                    <button onClick={() => setSelectedLotId(lot.id)}
                      className={`w-full bg-surface rounded-xl border border-border shadow-sm p-4 text-left hover:border-primary/40 hover:shadow transition-all ${isHidden ? 'opacity-50' : ''}`}>
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-semibold text-fg">{lot.sourceName || lot.source}</p>
                          <p className="text-[10px] text-fg-muted mt-0.5">{formatDate(lot.purchaseDate)} - {fmt(lot.cost)}</p>
                        </div>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full mr-7 ${
                          lot.status === 'processing' ? 'bg-info-subtle text-info' : 'bg-muted text-fg-muted'
                        }`}>{lot.status}</span>
                    </div>
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[10px] text-fg-muted mb-1">
                        <span>{processed}/{itemCount} items processed</span>
                        <span className="font-mono font-semibold">{pct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {allLots.length > activeLots.length && (
          <div>
            <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-2">All Lots with Items</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {allLots.filter(l => !activeLots.includes(l)).slice(0, 10).map(lot => {
                const isHidden = hiddenLots.has(lot.id);
                return (
                  <div key={lot.id} className="relative group flex items-center">
                    <button onClick={() => setSelectedLotId(lot.id)}
                      className={`flex-1 bg-surface rounded-lg border border-border px-3 py-2 text-left hover:border-primary/30 transition-colors text-xs ${isHidden ? 'opacity-50' : ''}`}>
                      <span className="font-medium text-fg">{lot.sourceName || lot.source}</span>
                      <span className="text-fg-muted ml-2">{(lot.items || []).length} items</span>
                    </button>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (isHidden) unhideLot(lot.id);
                        else hideLot(lot.id);
                      }}
                      className={`ml-1 p-1.5 rounded-md transition-all ${
                        isHidden
                          ? 'opacity-100 bg-warning-subtle text-warning'
                          : 'opacity-50 hover:opacity-100 text-fg-muted hover:text-fg hover:bg-muted/40'
                      }`}
                      title={isHidden ? 'Unhide this lot' : 'Hide this lot from Operations'}
                    >
                      {isHidden ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {allLots.length === 0 && (
          <div className="text-center py-10 text-fg-muted">
            <Package size={40} className="mx-auto mb-3 opacity-25" />
            <p className="font-medium">No lots with items</p>
            <p className="text-sm mt-1">Import a lot from Arbitrage Scanner or add one in Lots &amp; Items.</p>
          </div>
        )}
      </div>
    );
  }

  // ── Processing workstation ──
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <button onClick={() => { setSelectedLotId(null); setSearch(''); }}
            className="text-xs text-secondary hover:underline mb-1 inline-block">
            &larr; Back to lot list
          </button>
          <h2 className="text-lg font-bold text-fg">
            {selectedLot?.sourceName || selectedLot?.source || 'Lot'}
          </h2>
          <p className="text-xs text-fg-muted">
            {formatDate(selectedLot?.purchaseDate)} - {fmt(selectedLot?.cost)} - {(selectedLot?.items || []).length} items
          </p>
        </div>
      </div>

      {/* Progress bar */}
      {progress && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-fg">Processing Progress</span>
            <span className="text-sm font-bold font-mono text-primary">{progress.pct}%</span>
          </div>
          <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden mb-3">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${progress.pct}%` }} />
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <p className="text-xs font-bold text-fg font-mono">{progress.processed}/{progress.total}</p>
              <p className="text-[10px] text-fg-muted">Processed</p>
            </div>
            <div>
              <p className="text-xs font-bold text-fg font-mono">{progress.tested}/{progress.total}</p>
              <p className="text-[10px] text-fg-muted">Graded</p>
            </div>
            <div>
              <p className="text-xs font-bold text-fg font-mono">{progress.disposed}/{progress.total}</p>
              <p className="text-[10px] text-fg-muted">Dispositioned</p>
            </div>
            <div>
              <p className="text-xs font-bold text-fg font-mono">{progress.listed}/{progress.total}</p>
              <p className="text-[10px] text-fg-muted">Listed/Sold</p>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-xs">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
        <input type="text" placeholder="Search items..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg bg-surface focus:outline-none focus:ring-1 focus:ring-primary" />
        {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted"><X size={11} /></button>}
      </div>

      {/* Items list */}
      <div className="space-y-2">
        {items.map(item => {
          const expanded = expandedItem === item.id;
          const Icon = STATUS_ICON[item.status] || Package;
          const statusLabel = ITEM_STATUSES.find(s => s.value === item.status)?.label || item.status || 'Received';
          const dispCfg = DISPOSITION_OPTIONS.find(d => d.value === (item.disposition || '')) || DISPOSITION_OPTIONS[0];
          const isPicked = selectedItemIds.has(item.id);

          return (
            <div key={item.id} className={`bg-surface rounded-xl border shadow-sm transition-colors flex items-stretch ${
              isPicked ? 'border-primary/50 ring-1 ring-primary/30' :
              item.status === 'received' ? 'border-border' :
              item.status === 'sold' ? 'border-success/30' :
              item.status === 'listed' ? 'border-accent/30' :
              'border-border'
            }`}>
              {/* Multi-select checkbox column */}
              <label className="flex items-center pl-3 pr-1 cursor-pointer" title="Select for bulk action">
                <input
                  type="checkbox"
                  checked={isPicked}
                  onChange={() => toggleItemPick(item.id)}
                  className="rounded border-border-strong text-primary focus:ring-primary/30"
                />
              </label>
              <div className="flex-1 min-w-0">
              {/* Compact row — the Test button sits OUTSIDE the expand button
                  so clicking it opens the modal without toggling expansion;
                  the chevron stays INSIDE so tapping it still expands. */}
              {(() => {
                const hasSavedChecklist = !!savedChecklists?.[item.id];
                return (
              <div className="flex items-center gap-2 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setExpandedItem(expanded ? null : item.id)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left"
                >
                  <Icon size={14} className="text-fg-muted shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-fg truncate">
                      {[item.brand, item.model].filter(Boolean).join(' ') || item.serialNumber || 'Unknown Item'}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-fg-muted">
                      <span className={`font-semibold px-1.5 py-0.5 rounded-full ${
                        item.status === 'received' ? 'bg-muted text-fg-muted' :
                        item.status === 'testing' ? 'bg-info-subtle text-info' :
                        item.status === 'listed' ? 'bg-accent-subtle text-accent' :
                        item.status === 'sold' ? 'bg-success-subtle text-success' :
                        'bg-muted text-fg-muted'
                      }`}>{statusLabel}</span>
                      {item.conditionGrade && <span className="font-mono font-semibold">Grade {item.conditionGrade}</span>}
                      {item.disposition && <span className={`px-1.5 py-0.5 rounded-full ${dispCfg.cls}`}>{dispCfg.label}</span>}
                      {hasSavedChecklist && (
                        <span className="inline-flex items-center gap-0.5 text-success" title="Has a saved test checklist">
                          <CheckCircle size={10} />tested
                        </span>
                      )}
                      {item.serialNumber && <span className="font-mono truncate max-w-[120px]">{item.serialNumber}</span>}
                    </div>
                  </div>
                  {expanded ? <ChevronUp size={14} className="text-fg-muted shrink-0 ml-auto" /> : <ChevronDown size={14} className="text-fg-muted shrink-0 ml-auto" />}
                </button>
                <button
                  type="button"
                  onClick={() => setTestingItem(item)}
                  title="Run testing checklist"
                  className="text-[10px] font-medium px-2 py-1 rounded-md border border-border text-fg-muted hover:bg-muted/40 hover:text-fg inline-flex items-center gap-1 shrink-0 transition-colors"
                >
                  <Clipboard size={11} />
                  {hasSavedChecklist ? 'Re-test' : 'Test'}
                </button>
              </div>
                );
              })()}

              {/* Expanded detail */}
              {expanded && (
                <div className="px-4 pb-4 pt-1 border-t border-border-subtle space-y-3">
                  {/* Quick status */}
                  <div>
                    <p className="text-[10px] font-semibold text-fg-muted uppercase mb-1.5">Status</p>
                    <div className="flex flex-wrap gap-1.5">
                      {ITEM_STATUSES.map(s => (
                        <button key={s.value} onClick={() => { quickStatus(item.id, s.value); checkLotCompletion(); }}
                          className={`text-[10px] font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                            item.status === s.value ? 'bg-primary text-white border-primary' : 'bg-surface border-border text-fg-muted hover:bg-muted/40'
                          }`}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Quick grade */}
                  <div>
                    <p className="text-[10px] font-semibold text-fg-muted uppercase mb-1.5">Condition Grade</p>
                    <div className="flex gap-1.5">
                      {GRADES.map(g => (
                        <button key={g} onClick={() => quickGrade(item.id, g)}
                          className={`w-8 h-8 rounded-lg text-xs font-bold border transition-colors ${
                            item.conditionGrade === g ? 'bg-primary text-white border-primary' : 'bg-surface border-border text-fg-muted hover:bg-muted/40'
                          }`}>
                          {g}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Disposition */}
                  <div>
                    <p className="text-[10px] font-semibold text-fg-muted uppercase mb-1.5">Disposition</p>
                    <div className="flex flex-wrap gap-1.5">
                      {DISPOSITION_OPTIONS.filter(d => d.value).map(d => (
                        <button key={d.value} onClick={() => { quickDisposition(item.id, d.value); checkLotCompletion(); }}
                          className={`text-[10px] font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                            item.disposition === d.value ? 'bg-primary text-white border-primary' : `border-border hover:opacity-80 ${d.cls}`
                          }`}>
                          {d.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Notes */}
                  <div>
                    <p className="text-[10px] font-semibold text-fg-muted uppercase mb-1.5">Notes</p>
                    <textarea rows={2}
                      className="w-full text-xs border border-border rounded-lg px-2.5 py-1.5 bg-surface text-fg focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      defaultValue={item.notes || ''}
                      onBlur={e => updateItem(item.id, { notes: e.target.value })}
                      placeholder="Add notes about this item..."
                    />
                  </div>
                </div>
              )}
              </div>
            </div>
          );
        })}
      </div>

      {items.length === 0 && selectedLot && (
        <EmptyState
          icon={Boxes}
          title={search ? 'No items match your search' : 'No items in this lot yet'}
        />
      )}

      {/* Sticky bulk-action toolbar — appears when items are checked. */}
      {selectedItemIds.size > 0 && (
        <div className="sticky bottom-2 z-20 bg-surface rounded-xl border border-border shadow-lg ring-1 ring-primary/10 p-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-primary shrink-0">
            {selectedItemIds.size} selected
          </span>
          <select
            value={bulkStatus}
            onChange={(ev) => setBulkStatus(ev.target.value)}
            className="border border-border-strong rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
          >
            <option value="">Status…</option>
            {ITEM_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select
            value={bulkGrade}
            onChange={(ev) => setBulkGrade(ev.target.value)}
            className="border border-border-strong rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
          >
            <option value="">Grade…</option>
            {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <select
            value={bulkDisp}
            onChange={(ev) => setBulkDisp(ev.target.value)}
            className="border border-border-strong rounded-lg px-2 py-1.5 text-xs focus:ring-2 focus:ring-primary/30 focus:border-primary outline-none"
          >
            <option value="">Disposition…</option>
            {DISPOSITION_OPTIONS.filter(d => d.value).map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => {
              const updates = {};
              if (bulkStatus) updates.status = bulkStatus;
              if (bulkGrade) updates.conditionGrade = bulkGrade;
              if (bulkDisp) updates.disposition = bulkDisp;
              if (Object.keys(updates).length === 0) return;
              for (const id of selectedItemIds) {
                dispatch({ type: 'UPDATE_ITEM', id, updates });
              }
              eventBus.emit('notification:push', {
                type: 'success',
                title: 'Bulk update applied',
                message: `${selectedItemIds.size} item${selectedItemIds.size !== 1 ? 's' : ''} updated`,
              });
              setSelectedItemIds(new Set());
              setBulkStatus(''); setBulkGrade(''); setBulkDisp('');
            }}
            disabled={!bulkStatus && !bulkGrade && !bulkDisp}
            className="text-sm px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={clearItemPicks}
            className="text-sm px-3 py-1.5 border border-border text-fg-muted rounded-lg hover:bg-muted/40"
          >
            Clear
          </button>
        </div>
      )}

      <Modal
        open={!!testingItem}
        onClose={() => setTestingItem(null)}
        size="2xl"
        title="Test Checklist"
        subtitle={testingItem
          ? ([testingItem.brand, testingItem.model].filter(Boolean).join(' ') || testingItem.serialNumber || 'Unknown Item')
          : ''}
      >
        {testingItem && (
          <Suspense fallback={<div className="h-64 bg-muted rounded-xl animate-pulse" />}>
            <TestingChecklist
              itemId={testingItem.id}
              category={testingItem.category}
              itemName={[testingItem.brand, testingItem.model].filter(Boolean).join(' ') || 'Unknown Item'}
            />
          </Suspense>
        )}
      </Modal>
    </div>
  );
}

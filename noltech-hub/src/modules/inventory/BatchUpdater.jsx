import { useState, useMemo, useCallback } from 'react';
import {
  CheckSquare, Square, Filter, ArrowDown, Trash2, Edit,
  Package, Tag, MapPin, DollarSign, Search, RefreshCw, Undo2, X, AlertTriangle,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import eventBus from '../../services/eventBus';
import { formatCurrency, today } from '../../utils/formatters';
import { CATEGORIES, ITEM_STATUSES } from '../../utils/constants';
import { useHiddenLots } from '../../hooks/useHiddenLots';
import EmptyState from '../../components/EmptyState';
import { classifyByDirection, appendHistoryRow } from '../../utils/priceHistoryReasons';

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCATIONS_KEY = 'noltech:locations';
const PRICE_HISTORY_KEY = 'noltech:price-history';
const MONO = { fontFamily: "'JetBrains Mono', monospace" };

const ZONES = [
  { value: 'intake',    label: 'Intake' },
  { value: 'testing',   label: 'Testing Bench' },
  { value: 'storage',   label: 'Storage' },
  { value: 'shelf-a',   label: 'Shelf A' },
  { value: 'shelf-b',   label: 'Shelf B' },
  { value: 'shelf-c',   label: 'Shelf C' },
  { value: 'shipping',  label: 'Shipping' },
  { value: 'recycle',   label: 'Recycle' },
];

const BATCH_ACTIONS = [
  { key: 'status',   label: 'Change Status',   icon: RefreshCw },
  { key: 'location', label: 'Change Location',  icon: MapPin },
  { key: 'price',    label: 'Adjust Price',      icon: DollarSign },
  { key: 'category', label: 'Assign Category',   icon: Tag },
  { key: 'delete',   label: 'Delete Selected',   icon: Trash2, danger: true },
];

// ─── Main Component ──────────────────────────────────────────────────────────

export default function BatchUpdater() {
  const { state, dispatch } = useApp();
  const { isHidden } = useHiddenLots();

  // ── Selection state ─────────────────────────────────────────────────────
  const [selectedLotId, setSelectedLotId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());

  // ── Action state ────────────────────────────────────────────────────────
  const [activeAction, setActiveAction] = useState(null);
  const [actionParams, setActionParams] = useState({});
  const [showPreview, setShowPreview] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [applying, setApplying] = useState(false);

  // ── Results state ───────────────────────────────────────────────────────
  const [result, setResult] = useState(null);       // { count, text, undoData }
  const [undoData, setUndoData] = useState(null);   // [{ itemId, prevValues }]

  // ── Flatten items ───────────────────────────────────────────────────────
  const allItems = useMemo(() => {
    return (state.lots || []).flatMap((lot) =>
      (lot.items || []).map((item) => ({
        ...item,
        displayName: [item.brand, item.model].filter(Boolean).join(' ') || 'Unnamed Item',
        lotName: lot.sourceName || lot.source || 'Unknown Lot',
      }))
    );
  }, [state.lots]);

  // ── Filtered items ──────────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    let items = allItems;
    if (selectedLotId) items = items.filter((i) => i.lotId === selectedLotId);
    if (statusFilter) items = items.filter((i) => i.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter((i) =>
        i.displayName.toLowerCase().includes(q) ||
        (i.serialNumber || '').toLowerCase().includes(q) ||
        (i.category || '').toLowerCase().includes(q)
      );
    }
    return items;
  }, [allItems, selectedLotId, statusFilter, search]);

  // ── Selected items (resolved) ───────────────────────────────────────────
  const selectedItems = useMemo(() => {
    return filteredItems.filter((i) => selectedIds.has(i.id));
  }, [filteredItems, selectedIds]);

  // ── Selection helpers ───────────────────────────────────────────────────
  const toggleItem = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredItems.map((i) => i.id)));
  }, [filteredItems]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const allSelected = filteredItems.length > 0 && filteredItems.every((i) => selectedIds.has(i.id));

  // ── Preview data ────────────────────────────────────────────────────────
  const previewChanges = useMemo(() => {
    if (!activeAction || selectedItems.length === 0) return [];

    return selectedItems.map((item) => {
      const changes = {};
      if (activeAction === 'status' && actionParams.status) {
        changes.status = { from: item.status, to: actionParams.status };
      }
      if (activeAction === 'location') {
        changes.location = { from: item.zone || '—', to: `${actionParams.zone || ''} ${actionParams.location || ''}`.trim() || '—' };
      }
      if (activeAction === 'price') {
        const current = item.listingPrice || item.estimatedValue || 0;
        let newPrice = current;
        if (actionParams.priceMode === 'percent') {
          const pct = Number(actionParams.priceValue) || 0;
          newPrice = Math.round(current * (1 + pct / 100) * 100) / 100;
        } else {
          newPrice = current + (Number(actionParams.priceValue) || 0);
        }
        newPrice = Math.max(0, newPrice);
        changes.price = { from: current, to: newPrice };
      }
      if (activeAction === 'category' && actionParams.category) {
        changes.category = { from: item.category || '—', to: actionParams.category };
      }
      if (activeAction === 'delete') {
        changes.action = { from: item.displayName, to: 'DELETE' };
      }
      return { ...item, changes };
    });
  }, [activeAction, actionParams, selectedItems]);

  // ── Apply batch action ──────────────────────────────────────────────────
  const applyAction = useCallback(async () => {
    if (selectedItems.length === 0 || !activeAction) return;
    setApplying(true);

    const prevValues = [];
    let count = 0;

    try {
      if (activeAction === 'status' && actionParams.status) {
        for (const item of selectedItems) {
          prevValues.push({ itemId: item.id, prev: { status: item.status } });
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { status: actionParams.status } });
          count++;
        }
      }

      if (activeAction === 'location') {
        let locations = {};
        try { locations = (await window.storage.get(LOCATIONS_KEY)) || {}; } catch (e) { console.error('[batch updater] locations load failed:', e); }
        for (const item of selectedItems) {
          prevValues.push({ itemId: item.id, prev: { zone: item.zone, location: item.location } });
          const updates = {};
          if (actionParams.zone) updates.zone = actionParams.zone;
          if (actionParams.location) updates.location = actionParams.location;
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates });
          locations[item.id] = { zone: actionParams.zone || '', location: actionParams.location || '' };
          count++;
        }
        try { await window.storage.set(LOCATIONS_KEY, locations); } catch (e) { console.error('Location save error:', e); }
      }

      if (activeAction === 'price') {
        let priceHist = {};
        try { priceHist = (await window.storage.get(PRICE_HISTORY_KEY)) || {}; } catch (e) { console.error('[batch updater] price history load failed:', e); }

        for (const item of selectedItems) {
          const current = item.listingPrice || item.estimatedValue || 0;
          let newPrice = current;
          if (actionParams.priceMode === 'percent') {
            const pct = Number(actionParams.priceValue) || 0;
            newPrice = Math.round(current * (1 + pct / 100) * 100) / 100;
          } else {
            newPrice = current + (Number(actionParams.priceValue) || 0);
          }
          newPrice = Math.max(0, newPrice);

          prevValues.push({ itemId: item.id, prev: { listingPrice: current } });
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { listingPrice: newPrice } });
          // Reason is direction-aware. The same value is emitted on the bus
          // AND written to the local history map so any reader of either
          // surface gets a consistent classification (see priceHistoryReasons
          // for the canonical taxonomy + isMarkdown helper).
          const reason = classifyByDirection(current, newPrice);
          eventBus.emit('price:changed', { itemId: item.id, oldPrice: current, newPrice, reason });
          priceHist[item.id] = appendHistoryRow(priceHist[item.id], { price: newPrice, reason, oldPrice: current });
          count++;
        }
        try { await window.storage.set(PRICE_HISTORY_KEY, priceHist); } catch (e) { console.error('Price history save error:', e); }
      }

      if (activeAction === 'category' && actionParams.category) {
        for (const item of selectedItems) {
          prevValues.push({ itemId: item.id, prev: { category: item.category } });
          dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { category: actionParams.category } });
          count++;
        }
      }

      if (activeAction === 'delete') {
        for (const item of selectedItems) {
          prevValues.push({ itemId: item.id, prev: { ...item } });
          dispatch({ type: 'DELETE_ITEM', id: item.id });
          count++;
        }
      }

      setUndoData(prevValues);
      setResult({ count, text: `Updated ${count} item${count !== 1 ? 's' : ''}` });
      setSelectedIds(new Set());
      setActiveAction(null);
      setActionParams({});
      setShowPreview(false);
      setShowConfirmDelete(false);
    } catch (e) {
      setResult({ count: 0, text: `Error: ${e.message}` });
    }

    setApplying(false);
  }, [selectedItems, activeAction, actionParams, dispatch]);

  // ── Undo ────────────────────────────────────────────────────────────────
  const undoAction = useCallback(() => {
    if (!undoData || undoData.length === 0) return;
    for (const entry of undoData) {
      if (activeAction === 'delete') {
        // Re-add deleted items
        dispatch({ type: 'ADD_ITEM', item: entry.prev });
      } else {
        dispatch({ type: 'UPDATE_ITEM', id: entry.itemId, updates: entry.prev });
      }
    }
    setResult({ count: undoData.length, text: `Undid ${undoData.length} changes` });
    setUndoData(null);
  }, [undoData, dispatch, activeAction]);

  // ── Loading / Error ─────────────────────────────────────────────────────
  if (state.loading) {
    return (
      <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-muted rounded w-1/3" />
          <div className="h-4 bg-muted rounded w-2/3" />
          <div className="h-10 bg-muted rounded w-full" />
          <div className="h-10 bg-muted rounded w-full" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="bg-surface rounded-xl border border-danger/30 shadow-sm p-6">
        <div className="flex items-center gap-3 text-danger">
          <AlertTriangle className="w-5 h-5" />
          <div>
            <p className="font-semibold">Couldn't load inventory</p>
            <p className="text-sm text-danger">{state.error}</p>
          </div>
        </div>
      </div>
    );
  }

  const statusLabel = (val) => ITEM_STATUSES.find((s) => s.value === val)?.label || val || '—';
  const categoryLabel = (val) => CATEGORIES.find((c) => c.value === val)?.label || val || '—';

  return (
    <div className="space-y-6">
      {/* ── Result toast ──────────────────────────────────────────────────── */}
      {result && (
        <div className="flex items-center justify-between bg-success-subtle border border-success/30 rounded-lg px-4 py-3">
          <span className="text-sm font-medium text-success">{result.text}</span>
          <div className="flex items-center gap-2">
            {undoData && undoData.length > 0 && (
              <button
                onClick={undoAction}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-surface border border-success/30 text-success text-xs font-medium hover:bg-success-subtle transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5" /> Undo
              </button>
            )}
            <button
              onClick={() => { setResult(null); setUndoData(null); }}
              className="p-1 rounded hover:bg-success-subtle text-success"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <Filter className="w-5 h-5 text-fg-muted" />
          <h3 className="text-lg font-semibold text-fg">Select Items</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          {/* Lot filter */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Lot</label>
            <select
              value={selectedLotId}
              onChange={(e) => { setSelectedLotId(e.target.value); setSelectedIds(new Set()); }}
              className="h-10 px-3 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">All Lots</option>
              {(state.lots || []).filter(l => !isHidden(l.id)).map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.sourceName || lot.source || 'Unknown'} ({(lot.items || []).length} items)
                </option>
              ))}
            </select>
          </div>

          {/* Status filter */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setSelectedIds(new Set()); }}
              className="h-10 px-3 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">All Statuses</option>
              {ITEM_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          {/* Search */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-subtle" />
              <input
                type="text"
                placeholder="Brand, model, serial..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 w-full pl-9 pr-3 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
        </div>

        {/* Select all bar */}
        <div className="flex items-center justify-between py-2 px-1 mb-2">
          <button
            onClick={allSelected ? deselectAll : selectAll}
            className="flex items-center gap-2 text-sm text-fg-muted hover:text-fg transition-colors"
          >
            {allSelected ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4" />}
            <span>{allSelected ? 'Deselect All' : 'Select All'}</span>
            <span className="text-xs text-fg-subtle">({filteredItems.length} items)</span>
          </button>
          {selectedIds.size > 0 && (
            <span className="text-sm font-semibold text-primary">{selectedIds.size} selected</span>
          )}
        </div>

        {/* Item list */}
        {filteredItems.length === 0 ? (
          <EmptyState
            icon={Filter}
            title="No items match your filters"
            description="Try adjusting the lot, status, or search filters."
          />
        ) : (
          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="border-b border-border">
                  <th className="w-10 px-2 py-2.5" />
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Item</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Category</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Status</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Price</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, idx) => {
                  const isSelected = selectedIds.has(item.id);
                  return (
                    <tr
                      key={item.id}
                      onClick={() => toggleItem(item.id)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-info-subtle' : idx % 2 === 0 ? 'bg-surface' : 'bg-muted/40'
                      } hover:bg-info-subtle/70`}
                    >
                      <td className="px-2 py-2.5 text-center">
                        {isSelected
                          ? <CheckSquare className="w-4 h-4 text-primary mx-auto" />
                          : <Square className="w-4 h-4 text-fg-subtle mx-auto" />}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-fg">{item.displayName}</div>
                        <div className="text-xs text-fg-subtle">{item.lotName}</div>
                      </td>
                      <td className="px-4 py-2.5 text-fg-muted">{categoryLabel(item.category)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                          item.status === 'sold' ? 'bg-success-subtle text-success' :
                          item.status === 'listed' ? 'bg-info-subtle text-info' :
                          item.status === 'testing' ? 'bg-warning-subtle text-warning' :
                          item.status === 'parted_out' ? 'bg-accent-subtle text-accent' :
                          item.status === 'recycled' ? 'bg-danger-subtle text-danger' :
                          'bg-muted text-fg-muted'
                        }`}>
                          {statusLabel(item.status)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-fg" style={MONO}>
                        {item.listingPrice || item.estimatedValue ? formatCurrency(item.listingPrice || item.estimatedValue) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Selected Items Bar + Actions ──────────────────────────────────── */}
      {/* Sticky to the bottom of the viewport so the action panel is always
          reachable while the user scrolls a long selection list. Adds a soft
          drop-shadow above so it visually separates from the table. */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-2 z-20 bg-surface rounded-xl border border-border shadow-lg p-6 ring-1 ring-primary/10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Edit className="w-5 h-5 text-fg-muted" />
              <h3 className="text-lg font-semibold text-fg">Batch Actions</h3>
              <span className="text-sm font-semibold text-primary">{selectedIds.size} items selected</span>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2 mb-4">
            {BATCH_ACTIONS.map((action) => {
              const Icon = action.icon;
              const isActive = activeAction === action.key;
              return (
                <button
                  key={action.key}
                  onClick={() => {
                    setActiveAction(isActive ? null : action.key);
                    setActionParams({});
                    setShowPreview(false);
                    setShowConfirmDelete(false);
                  }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    isActive
                      ? action.danger
                        ? 'bg-danger-subtle text-danger border-danger/30'
                        : 'bg-info-subtle text-info border-info/30'
                      : action.danger
                        ? 'bg-surface text-danger border-border hover:bg-danger-subtle hover:border-danger/30'
                        : 'bg-surface text-fg-muted border-border hover:bg-muted/40'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {action.label}
                </button>
              );
            })}
          </div>

          {/* ── Action-specific forms ───────────────────────────────────────── */}
          {activeAction === 'status' && (
            <div className="p-4 bg-muted/40 rounded-lg border border-border space-y-3">
              <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">New Status</label>
              <select
                value={actionParams.status || ''}
                onChange={(e) => setActionParams({ ...actionParams, status: e.target.value })}
                className="h-10 w-full sm:w-64 px-3 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Select status...</option>
                {ITEM_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setShowPreview(true)}
                  disabled={!actionParams.status}
                  className="px-4 py-2 rounded-lg bg-muted text-fg text-sm font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Preview
                </button>
                <button
                  onClick={applyAction}
                  disabled={!actionParams.status || applying}
                  className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {applying ? 'Applying...' : 'Apply'}
                </button>
              </div>
            </div>
          )}

          {activeAction === 'location' && (
            <div className="p-4 bg-muted/40 rounded-lg border border-border space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Zone</label>
                  <select
                    value={actionParams.zone || ''}
                    onChange={(e) => setActionParams({ ...actionParams, zone: e.target.value })}
                    className="h-10 w-full px-3 mt-1 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="">Select zone...</option>
                    {ZONES.map((z) => (
                      <option key={z.value} value={z.value}>{z.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Location Detail</label>
                  <input
                    type="text"
                    placeholder="e.g., Bin 3, Row 2"
                    value={actionParams.location || ''}
                    onChange={(e) => setActionParams({ ...actionParams, location: e.target.value })}
                    className="h-10 w-full px-3 mt-1 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowPreview(true)} className="px-4 py-2 rounded-lg bg-muted text-fg text-sm font-medium hover:bg-muted transition-colors">Preview</button>
                <button
                  onClick={applyAction}
                  disabled={(!actionParams.zone && !actionParams.location) || applying}
                  className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {applying ? 'Applying...' : 'Apply'}
                </button>
              </div>
            </div>
          )}

          {activeAction === 'price' && (
            <div className="p-4 bg-muted/40 rounded-lg border border-border space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">Mode</label>
                  <select
                    value={actionParams.priceMode || 'percent'}
                    onChange={(e) => setActionParams({ ...actionParams, priceMode: e.target.value, priceValue: '' })}
                    className="h-10 w-full px-3 mt-1 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <option value="percent">Percentage (+/-)</option>
                    <option value="fixed">Fixed Amount (+/-)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">
                    {actionParams.priceMode === 'fixed' ? 'Amount ($)' : 'Percentage (%)'}
                  </label>
                  <input
                    type="number"
                    placeholder={actionParams.priceMode === 'fixed' ? 'e.g., -10' : 'e.g., -15'}
                    value={actionParams.priceValue || ''}
                    onChange={(e) => setActionParams({ ...actionParams, priceValue: e.target.value })}
                    className="h-10 w-full px-3 mt-1 rounded-lg border border-border-strong text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
              <p className="text-xs text-fg-subtle">Use negative values to decrease prices, positive to increase.</p>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowPreview(true)} disabled={!actionParams.priceValue} className="px-4 py-2 rounded-lg bg-muted text-fg text-sm font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Preview</button>
                <button
                  onClick={applyAction}
                  disabled={!actionParams.priceValue || applying}
                  className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {applying ? 'Applying...' : 'Apply'}
                </button>
              </div>
            </div>
          )}

          {activeAction === 'category' && (
            <div className="p-4 bg-muted/40 rounded-lg border border-border space-y-3">
              <label className="text-xs font-medium text-fg-muted uppercase tracking-wide">New Category</label>
              <select
                value={actionParams.category || ''}
                onChange={(e) => setActionParams({ ...actionParams, category: e.target.value })}
                className="h-10 w-full sm:w-64 px-3 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Select category...</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowPreview(true)} disabled={!actionParams.category} className="px-4 py-2 rounded-lg bg-muted text-fg text-sm font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Preview</button>
                <button
                  onClick={applyAction}
                  disabled={!actionParams.category || applying}
                  className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {applying ? 'Applying...' : 'Apply'}
                </button>
              </div>
            </div>
          )}

          {activeAction === 'delete' && (
            <div className="p-4 bg-danger-subtle rounded-lg border border-danger/30 space-y-3">
              <div className="flex items-center gap-2 text-danger">
                <AlertTriangle className="w-5 h-5" />
                <span className="text-sm font-semibold">Delete {selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''}?</span>
              </div>
              <p className="text-xs text-danger">This action can be undone after applying, but deleted items cannot be recovered after leaving this page.</p>
              {!showConfirmDelete ? (
                <button
                  onClick={() => setShowConfirmDelete(true)}
                  className="px-4 py-2 rounded-lg bg-danger text-white text-sm font-medium hover:bg-danger/90 transition-colors"
                >
                  Confirm Delete
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={applyAction}
                    disabled={applying}
                    className="px-4 py-2 rounded-lg bg-danger text-white text-sm font-medium hover:bg-danger/90 disabled:opacity-50 transition-colors"
                  >
                    {applying ? 'Deleting...' : 'Yes, Delete All'}
                  </button>
                  <button
                    onClick={() => setShowConfirmDelete(false)}
                    className="px-4 py-2 rounded-lg bg-surface text-fg-muted text-sm border border-border-strong hover:bg-muted/40 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Preview table ──────────────────────────────────────────────── */}
          {showPreview && activeAction && activeAction !== 'delete' && previewChanges.length > 0 && (
            <div className="mt-4 border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted border-b border-border">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Item</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">Current</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">
                      <ArrowDown className="w-3.5 h-3.5 mx-auto" />
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-fg-muted uppercase tracking-wide">New</th>
                  </tr>
                </thead>
                <tbody>
                  {previewChanges.map((item, idx) => {
                    const changeKey = Object.keys(item.changes)[0];
                    const change = item.changes[changeKey];
                    if (!change) return null;
                    return (
                      <tr key={item.id} className={idx % 2 === 0 ? 'bg-surface' : 'bg-muted/40'}>
                        <td className="px-4 py-2.5 font-medium text-fg">{item.displayName}</td>
                        <td className="px-4 py-2.5 text-fg-muted" style={changeKey === 'price' ? MONO : {}}>
                          {changeKey === 'price' ? formatCurrency(change.from) :
                           changeKey === 'status' ? statusLabel(change.from) :
                           changeKey === 'category' ? categoryLabel(change.from) :
                           String(change.from)}
                        </td>
                        <td className="px-4 py-2.5 text-center text-fg-subtle">
                          <ArrowDown className="w-3.5 h-3.5 mx-auto" />
                        </td>
                        <td className="px-4 py-2.5 font-semibold text-info" style={changeKey === 'price' ? MONO : {}}>
                          {changeKey === 'price' ? formatCurrency(change.to) :
                           changeKey === 'status' ? statusLabel(change.to) :
                           changeKey === 'category' ? categoryLabel(change.to) :
                           String(change.to)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

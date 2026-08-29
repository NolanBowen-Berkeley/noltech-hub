import { useState, useMemo, useEffect } from 'react';
import { Edit2, Trash2, Package, RefreshCw, Sliders, X, RotateCcw, Plus } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { SOURCES, LOT_STATUSES } from '../../utils/constants';
import { formatCurrency, formatDate, today } from '../../utils/formatters';
import DatePicker from '../../components/DatePicker';
import { useSkuOverlay } from '../../hooks/useSkuOverlay';
import { Modal } from '../../components/ui';
import EmptyState from '../../components/EmptyState';
import eventBus from '../../services/eventBus';

// ─── Constants ────────────────────────────────────────────────────────────────

const BLANK = {
  purchaseDate: today(),
  source: 'liquidation.com',
  sourceName: '',
  cost: '',
  itemCount: '',
  status: 'received',
  notes: '',
};

const BLANK_SKU = { skuPrefix: '', skuSuffix: '' };

const SRC_LABEL  = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));
const STAT_LABEL = Object.fromEntries(LOT_STATUSES.map((s) => [s.value, s.label]));

const LOT_STATUS_CLS = {
  received:   'bg-muted text-fg-muted border-border',
  processing: 'bg-info-subtle text-info border-info/30',
  listed:     'bg-primary/10 text-primary border-primary/20',
  completed:  'bg-success-subtle text-success border-success/30',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function LotStat({ label, value, mono, valueClass }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide">{label}</span>
      <span
        className={`text-sm font-medium text-fg ${valueClass || ''}`}
        style={mono ? { fontFamily: "'JetBrains Mono', monospace" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function LotManager() {
  const { state, dispatch } = useApp();
  const { overlay, setLotSku } = useSkuOverlay();
  const [form, setForm] = useState(BLANK);
  const [editId, setEditId] = useState(null);
  const [errors, setErrors] = useState({});
  const [skuEditing, setSkuEditing] = useState(null);
  const [skuForm, setSkuForm] = useState(BLANK_SKU);
  const [pnlSales,        setPnlSales]        = useState([]);
  const [allocatingLotId, setAllocatingLotId] = useState(null);
  const [weights,         setWeights]         = useState({}); // { [itemId]: string }
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [removeItemConfirmId, setRemoveItemConfirmId] = useState(null);
  const [compactView, setCompactView] = useState(false);
  // Add/Edit lot is now a modal so the always-visible form doesn't crowd
  // the page. Opens on "Add Lot" button OR when starting an edit.
  const [showLotModal, setShowLotModal] = useState(false);

  // Load P&L sales to show real sold counts per lot
  useEffect(() => {
    window.storage.get('noltech:lotprofit:sales')
      .then((s) => setPnlSales(Array.isArray(s) ? s : []))
      .catch(e => console.error('[lot manager] storage error:', e));
  }, []);

  // Clear stale confirm-strip ids when the target lot/item disappears (e.g.
  // a teammate's realtime DELETE arrives while the strip is open).
  useEffect(() => {
    if (removeItemConfirmId &&
        !state.lots.some((l) => (l.items || []).some((i) => i.id === removeItemConfirmId))) {
      setRemoveItemConfirmId(null);
    }
    if (deleteConfirmId && !state.lots.some((l) => l.id === deleteConfirmId)) {
      setDeleteConfirmId(null);
    }
  }, [state.lots, removeItemConfirmId, deleteConfirmId]);

  // Count P&L sales per lot
  const pnlSalesByLot = useMemo(() =>
    pnlSales.reduce((acc, s) => {
      if (s.lotId) acc[s.lotId] = (acc[s.lotId] || 0) + 1;
      return acc;
    }, {})
  , [pnlSales]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const inputCls =
    'w-full border border-border rounded-lg px-3 py-2 text-sm text-fg bg-surface ' +
    'focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-colors';
  const labelCls = 'block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1';

  // ── Validation ──────────────────────────────────────────────────────────────

  const validate = () => {
    const e = {};
    if (!form.purchaseDate) e.purchaseDate = 'Required';
    if (!form.cost || parseFloat(form.cost) <= 0) e.cost = 'Must be greater than 0';
    if (!form.itemCount || parseInt(form.itemCount) < 1) e.itemCount = 'Must be at least 1';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Submit ──────────────────────────────────────────────────────────────────

  const submit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    const data = {
      ...form,
      cost: parseFloat(form.cost),
      itemCount: parseInt(form.itemCount),
    };

    if (editId) {
      dispatch({ type: 'UPDATE_LOT', id: editId, updates: data });
      setEditId(null);
    } else {
      // _origin tag flows through to useEventBridge.lot:added so the
      // auto-created Cost of Goods (Lots) bookkeeping row is labeled
      // accurately.
      dispatch({
        type: 'ADD_LOT',
        lot: { id: crypto.randomUUID(), items: [], ...data },
        _origin: 'manual_lot_manager',
      });
    }

    setForm(BLANK);
    setErrors({});
    setShowLotModal(false);
  };

  const startEdit = (lot) => {
    setEditId(lot.id);
    setForm({
      purchaseDate: lot.purchaseDate || today(),
      source: lot.source || 'liquidation.com',
      sourceName: lot.sourceName || '',
      cost: String(lot.cost ?? ''),
      itemCount: String(lot.itemCount ?? ''),
      status: lot.status || 'received',
      notes: lot.notes || '',
    });
    setShowLotModal(true);
  };

  const cancel = () => {
    setEditId(null);
    setForm(BLANK);
    setErrors({});
    setShowLotModal(false);
  };

  const openAddModal = () => {
    setEditId(null);
    setForm(BLANK);
    setErrors({});
    setShowLotModal(true);
  };

  const openSkuEdit = (lot) => {
    setSkuEditing(lot.id);
    setSkuForm({
      skuPrefix: overlay[lot.id]?.skuPrefix || '',
      skuSuffix: overlay[lot.id]?.skuSuffix || '',
    });
  };

  const saveSkuEdit = (lotId) => {
    setLotSku(lotId, skuForm.skuPrefix.trim().toUpperCase(), skuForm.skuSuffix.trim().toUpperCase());
    setSkuEditing(null);
  };

  const confirmDeleteLot = (lotId) => {
    dispatch({ type: 'DELETE_LOT', id: lotId });
    setDeleteConfirmId(null);
  };

  // Remove a single item from a lot. Routes through the existing DELETE_ITEM
  // reducer, so persistence (IndexedDB) and cloud sync (Supabase items table)
  // happen automatically. Blocked cases:
  //   - status === 'listed' | 'sold'  → orphans the eBay listing or the
  //                                     sale's bookkeeping + sales_history.
  //   - item.ebayItemId is set        → next eBay Sync All would re-create
  //                                     the row from the still-live listing,
  //                                     making the delete look ineffective.
  const removeItemFromLot = (lotId, itemId) => {
    const lot  = state.lots.find((l) => l.id === lotId);
    const item = lot?.items?.find((i) => i.id === itemId);
    if (!item) return;
    if (item.status === 'listed' || item.status === 'sold') {
      eventBus.emit('notification:push', {
        type:    'warning',
        title:   'Cannot remove',
        message: `Item is ${item.status} — unlist or undo the sale first.`,
      });
      setRemoveItemConfirmId(null);
      return;
    }
    if (item.ebayItemId) {
      eventBus.emit('notification:push', {
        type:    'warning',
        title:   'Cannot remove',
        message: 'Item is linked to an eBay listing — end the listing first, otherwise the next Sync All will re-create it.',
      });
      setRemoveItemConfirmId(null);
      return;
    }
    // Drop the removed item's weight so totalW recomputes cleanly over the
    // surviving rows when the Cost Allocator re-renders.
    setWeights((prev) => {
      const rest = { ...prev };
      delete rest[itemId];
      return rest;
    });
    // Capture the freed cost basis so the toast can nudge the user to save.
    const freedCostBasis = Number(item.costBasis) || 0;
    dispatch({ type: 'DELETE_ITEM', id: itemId });
    setRemoveItemConfirmId(null);
    const label = item.model || item.brand || 'Item';
    eventBus.emit('notification:push', {
      type:    'success',
      title:   'Item removed',
      message: freedCostBasis > 0
        ? `${label} removed. Click Save Cost Basis to redistribute its ${formatCurrency(freedCostBasis)} share across remaining items.`
        : `${label} removed from lot.`,
    });
  };

  // ── Cost Allocator ──────────────────────────────────────────────────────────

  const openAllocator = (lot) => {
    const items = lot.items || [];
    const init  = {};
    items.forEach((i) => { init[i.id] = i.costBasis != null ? String(i.costBasis) : '1'; });
    // If no costBasis set, use equal weights of 1
    const anySet = items.some((i) => i.costBasis != null && i.costBasis > 0);
    if (!anySet) items.forEach((i) => { init[i.id] = '1'; });
    setWeights(init);
    setAllocatingLotId(lot.id);
  };

  const setEqualWeights = (lot) => {
    const init = {};
    (lot.items || []).forEach((i) => { init[i.id] = '1'; });
    setWeights(init);
  };

  const setPriceWeights = (lot) => {
    const items = lot.items || [];
    const w = {};
    items.forEach((i) => {
      const price = i.sale?.salePrice || i.listingPrice || 0;
      w[i.id] = price > 0 ? String(price) : '1';
    });
    setWeights(w);
  };

  const applyAllocation = (lot) => {
    const items      = lot.items || [];
    const totalWeight = items.reduce((s, i) => s + (parseFloat(weights[i.id]) || 1), 0);
    if (totalWeight <= 0) return;
    const lotCost = parseFloat(lot.cost) || 0;
    items.forEach((i) => {
      const w        = parseFloat(weights[i.id]) || 1;
      const costBasis = Math.round((w / totalWeight) * lotCost * 100) / 100;
      dispatch({ type: 'UPDATE_ITEM', id: i.id, updates: { costBasis } });
    });
    setAllocatingLotId(null);
  };

  // Redistribute remaining cost to unsold items.
  // Sold items keep whatever costBasis they had; unsold split the remainder.
  const redistributeToUnsold = (lot) => {
    const items    = lot.items || [];
    const sold     = items.filter((i) => i.status === 'sold');
    const unsold   = items.filter((i) => i.status !== 'sold');
    const lotCost  = parseFloat(lot.cost) || 0;
    const usedCost = sold.reduce((s, i) => s + (i.costBasis || 0), 0);
    const remaining = Math.max(lotCost - usedCost, 0);
    if (unsold.length === 0) return;
    const perItem = Math.round((remaining / unsold.length) * 100) / 100;
    unsold.forEach((i) => {
      dispatch({ type: 'UPDATE_ITEM', id: i.id, updates: { costBasis: perItem } });
    });
  };

  // ── Derived data ────────────────────────────────────────────────────────────

  const sortedLots = useMemo(
    () => [...state.lots].sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || '')),
    [state.lots]
  );

  const avgCostPreview =
    form.cost && form.itemCount && parseInt(form.itemCount) > 0
      ? parseFloat(form.cost) / parseInt(form.itemCount)
      : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-screen-2xl">
      {/* Page Header — clean, single row */}
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-fg tracking-tight">Lot Purchases</h1>
          <p className="text-sm text-fg-muted mt-0.5">
            {state.lots.length} lot{state.lots.length !== 1 ? 's' : ''} recorded
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setCompactView(v => !v)}
            className={`text-sm px-3 py-2 border rounded-lg transition-colors ${
              compactView ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border text-fg-muted hover:bg-muted/40'
            }`}
            title={compactView ? 'Expanded view' : 'Compact view'}
          >
            {compactView ? 'Expanded view' : 'Compact view'}
          </button>
          <button
            onClick={async () => {
              const ov = await window.storage.get('noltech:lotprofit:overlay').catch(() => ({})) || {};
              dispatch({ type: 'REMATCH_ITEMS_BY_SKU', overlay: ov, lots: state.lots });
            }}
            title="Re-assign all inventory items to their lot based on SKU pattern"
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-border text-fg-muted text-sm rounded-lg hover:bg-muted/40 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Rematch SKUs
          </button>
          <button
            onClick={openAddModal}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Lot
          </button>
        </div>
      </div>

      {/* Lot list — full width, no sticky form crowding the side */}
      <div className="space-y-3">

      {/* Add/Edit Lot — modal so it doesn't permanently occupy 380px on the side */}
      <Modal
        open={showLotModal}
        onClose={cancel}
        size="md"
        title={editId ? 'Edit Lot' : 'Add New Lot'}
        subtitle={editId ? 'Update purchase details' : 'Record a new lot purchase'}
      >
        <div>
          <form onSubmit={submit} className="space-y-4">

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Purchase Date</label>
                <DatePicker value={form.purchaseDate} onChange={v => set('purchaseDate', v)} />
                {errors.purchaseDate && (
                  <p className="text-xs text-danger mt-1">{errors.purchaseDate}</p>
                )}
              </div>
              <div>
                <label className={labelCls}>Source *</label>
                <select
                  value={form.source}
                  onChange={(e) => set('source', e.target.value)}
                  className={inputCls}
                >
                  {SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls}>Source / Lot Name</label>
              <input
                type="text"
                placeholder="e.g. Lot #4821, Auction listing URL, company name"
                value={form.sourceName}
                onChange={(e) => set('sourceName', e.target.value)}
                className={inputCls}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Lot Cost ($) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={form.cost}
                  onChange={(e) => set('cost', e.target.value)}
                  className={inputCls}
                />
                {errors.cost && <p className="text-xs text-danger mt-1">{errors.cost}</p>}
              </div>
              <div>
                <label className={labelCls}>Item Count *</label>
                <input
                  type="number"
                  min="1"
                  placeholder="0"
                  value={form.itemCount}
                  onChange={(e) => set('itemCount', e.target.value)}
                  className={inputCls}
                />
                {errors.itemCount && <p className="text-xs text-danger mt-1">{errors.itemCount}</p>}
              </div>
            </div>

            {/* Live avg cost preview */}
            {avgCostPreview !== null && (
              <div className="flex items-center gap-2 px-3 py-2 bg-secondary/5 border border-secondary/20 rounded-lg text-sm">
                <span className="text-fg-muted">Avg cost per unit:</span>
                <span
                  className="font-semibold text-secondary"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {formatCurrency(avgCostPreview)}
                </span>
              </div>
            )}

            <div>
              <label className={labelCls}>Status</label>
              <select
                value={form.status}
                onChange={(e) => set('status', e.target.value)}
                className={inputCls}
              >
                {LOT_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelCls}>Notes</label>
              <textarea
                rows={3}
                placeholder="e.g. 15x mixed laptops — Lenovo/Dell, various conditions"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                className={inputCls + ' resize-none'}
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              {editId && (
                <button
                  type="button"
                  onClick={cancel}
                  className="px-4 py-2 border border-border text-fg-muted rounded-lg text-sm font-medium hover:bg-muted/40 transition-colors"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors"
              >
                {editId ? 'Save Changes' : 'Add Lot'}
              </button>
            </div>
          </form>
        </div>
      </Modal>

        {/* ── Lot List items ── */}
        {sortedLots.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No lots yet"
              description="Click Add Lot in the top-right to record your first purchase."
            />
          ) : (
            sortedLots.map((lot) => {
              const items        = lot.items || [];
              const invSold      = items.filter((i) => i.status === 'sold').length;
              const pnlSold      = pnlSalesByLot[lot.id] || 0;
              const soldCount    = Math.max(invSold, pnlSold);
              const loggedCount  = Math.max(items.length, pnlSold);
              const availCount   = items.filter(
                (i) => i.status !== 'sold' && i.status !== 'recycled' && i.status !== 'parted_out'
              ).length;
              const avgCost = (parseFloat(lot.cost) || 0) / (parseInt(lot.itemCount) || 1);
              const isEditing = editId === lot.id;

              // ── Compact row view ──
              if (compactView) {
                return (
                  <div key={lot.id} className="flex items-center gap-3 bg-surface rounded-lg border border-border px-4 py-2.5 hover:border-border-strong transition-colors">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-fg truncate">
                        {lot.sourceName || `${SRC_LABEL[lot.source] || lot.source} Lot`}
                      </p>
                    </div>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${LOT_STATUS_CLS[lot.status] || LOT_STATUS_CLS.received}`}>
                      {STAT_LABEL[lot.status] || lot.status}
                    </span>
                    <span className="text-xs text-fg-muted whitespace-nowrap">{formatDate(lot.purchaseDate)}</span>
                    <span className="text-xs font-mono font-semibold text-fg whitespace-nowrap">{formatCurrency(lot.cost)}</span>
                    <span className="text-[10px] text-fg-muted whitespace-nowrap">{lot.itemCount} items</span>
                    <span className="text-[10px] text-success font-semibold whitespace-nowrap">{soldCount} sold</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => startEdit(lot)} className="p-1 text-fg-muted hover:text-primary rounded"><Edit2 className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setDeleteConfirmId(lot.id)} className="p-1 text-fg-muted hover:text-danger rounded"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                );
              }

              // ── Full card view ──
              const skuPrefix = overlay[lot.id]?.skuPrefix;
              const skuSuffix = overlay[lot.id]?.skuSuffix;
              const hasSkuPattern = !!(skuPrefix || skuSuffix);
              return (
                <div
                  key={lot.id}
                  className={`bg-surface rounded-xl border shadow-sm transition-all ${
                    isEditing
                      ? 'border-primary ring-1 ring-primary/20'
                      : 'border-border hover:border-border-strong'
                  }`}
                >
                  {/* Header row — title, status, date, source on one line */}
                  <div className="flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-fg text-base leading-tight truncate">
                          {lot.sourceName || `${SRC_LABEL[lot.source] || lot.source} Lot`}
                        </p>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            LOT_STATUS_CLS[lot.status] || LOT_STATUS_CLS.received
                          }`}
                        >
                          {STAT_LABEL[lot.status] || lot.status}
                        </span>
                      </div>
                      <p className="text-xs text-fg-muted mt-1">
                        {formatDate(lot.purchaseDate)} · {SRC_LABEL[lot.source] || lot.source}
                        {hasSkuPattern && (
                          <>
                            {' · '}
                            <span className="font-mono text-primary">
                              {skuPrefix && `${skuPrefix}…`}
                              {skuPrefix && skuSuffix && ' '}
                              {skuSuffix && `…${skuSuffix}`}
                            </span>
                          </>
                        )}
                      </p>
                      {lot.notes && (
                        <p className="text-xs text-fg-muted mt-1 line-clamp-1 italic">{lot.notes}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => allocatingLotId === lot.id ? setAllocatingLotId(null) : openAllocator(lot)}
                        title="Allocate lot cost per item"
                        className={`p-1.5 rounded-lg border transition-colors ${
                          allocatingLotId === lot.id
                            ? 'bg-primary text-white border-primary'
                            : 'border-border text-fg-muted hover:bg-muted/40 hover:text-fg'
                        }`}
                      >
                        <Sliders className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => startEdit(lot)}
                        title="Edit lot"
                        className="p-1.5 border border-border text-fg-muted rounded-lg hover:bg-muted/40 hover:text-fg transition-colors"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      {deleteConfirmId === lot.id ? (
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs text-danger font-medium whitespace-nowrap">Delete?</span>
                          <button
                            onClick={() => confirmDeleteLot(lot.id)}
                            className="px-2 py-1 text-xs bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setDeleteConfirmId(null)}
                            className="px-2 py-1 text-xs border border-border text-fg-muted rounded-lg hover:bg-muted/40 transition-colors"
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirmId(lot.id)}
                          title="Delete lot"
                          className="p-1.5 border border-danger/30 text-danger rounded-lg hover:bg-danger/5 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Stats row — 4 metrics that matter most. Avg/unit and
                      Logged are folded into the existing values' subtitles
                      (e.g. "12 / 17 items") to reduce density. */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 pb-4 pt-3 border-t border-border-subtle">
                    <LotStat
                      label="Cost"
                      value={formatCurrency(lot.cost)}
                      mono
                    />
                    <LotStat
                      label="Avg / unit"
                      value={formatCurrency(avgCost)}
                      mono
                    />
                    <LotStat
                      label="Sold"
                      value={`${soldCount} / ${lot.itemCount}`}
                      valueClass={soldCount > 0 ? 'text-success font-semibold' : ''}
                    />
                    <LotStat
                      label="Available"
                      value={availCount}
                      valueClass={availCount > 0 ? 'text-accent font-semibold' : ''}
                    />
                  </div>

                  {/* SKU pattern footer — only shown when the inline editor
                      is open OR the user explicitly wants to set one. Hides
                      it from the always-visible header to declutter. */}
                  {skuEditing === lot.id ? (
                    <div className="flex flex-wrap items-center gap-2 px-4 pb-4 -mt-1">
                      <input
                        className="border border-border rounded px-2 py-1 text-xs font-mono w-28 focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="Prefix"
                        value={skuForm.skuPrefix}
                        onChange={(e) => setSkuForm((f) => ({ ...f, skuPrefix: e.target.value.toUpperCase() }))}
                      />
                      <input
                        className="border border-border rounded px-2 py-1 text-xs font-mono w-28 focus:outline-none focus:ring-1 focus:ring-primary"
                        placeholder="Suffix"
                        value={skuForm.skuSuffix}
                        onChange={(e) => setSkuForm((f) => ({ ...f, skuSuffix: e.target.value.toUpperCase() }))}
                      />
                      <button onClick={() => saveSkuEdit(lot.id)} className="px-2 py-1 bg-primary text-white text-xs rounded hover:bg-primary/90 transition-colors">Save</button>
                      <button onClick={() => setSkuEditing(null)} className="px-2 py-1 border border-border text-fg-muted text-xs rounded hover:bg-muted/40 transition-colors">Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => openSkuEdit(lot)}
                      className="block px-4 pb-3 -mt-1 text-[11px] text-fg-muted hover:text-primary hover:underline transition-colors"
                    >
                      {hasSkuPattern ? 'Edit SKU pattern' : '+ Set SKU pattern'}
                    </button>
                  )}

                  {/* ── Cost Allocator panel ── */}
                  {allocatingLotId === lot.id && (() => {
                    const items      = lot.items || [];
                    const lotCost    = parseFloat(lot.cost) || 0;
                    const totalW     = items.reduce((s, i) => s + (parseFloat(weights[i.id]) || 1), 0);
                    const hasSold    = items.some((i) => i.status === 'sold');
                    return (
                      <div className="px-4 pb-4 pt-4 border-t border-border bg-muted/20">
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="text-xs font-semibold text-fg uppercase tracking-wide flex items-center gap-1.5">
                            <Sliders className="w-3.5 h-3.5 text-primary" /> Cost Allocator
                          </h4>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setEqualWeights(lot)}
                              className="text-[11px] px-2 py-1 border border-border rounded text-fg-muted hover:bg-muted/40 transition-colors"
                            >
                              Equal
                            </button>
                            <button
                              onClick={() => setPriceWeights(lot)}
                              className="text-[11px] px-2 py-1 border border-border rounded text-fg-muted hover:bg-muted/40 transition-colors"
                              title="Weight by listing/sale price"
                            >
                              By Price
                            </button>
                            {hasSold && (
                              <button
                                onClick={() => redistributeToUnsold(lot)}
                                className="flex items-center gap-1 text-[11px] px-2 py-1 border border-secondary/30 text-secondary rounded hover:bg-secondary/5 transition-colors"
                                title="Lock sold items' cost basis, split remaining cost to unsold items"
                              >
                                <RotateCcw className="w-3 h-3" /> Split to Unsold
                              </button>
                            )}
                            <button onClick={() => setAllocatingLotId(null)} className="p-1 text-fg-muted hover:text-fg">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        {items.length === 0 ? (
                          <EmptyState
                            icon={Package}
                            title="No items logged for this lot yet"
                            size="sm"
                          />
                        ) : (
                          <>
                            <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1 mb-3">
                              {items.map((item) => {
                                const w       = parseFloat(weights[item.id]) || 1;
                                const cost    = totalW > 0 ? (w / totalW) * lotCost : 0;
                                const isSold  = item.status === 'sold';
                                return (
                                  <div key={item.id} className="flex items-center gap-3 text-xs">
                                    <div className="flex-1 min-w-0">
                                      <p className="truncate font-medium text-fg">
                                        {item.model || item.brand || 'Item'}{' '}
                                        {isSold && <span className="text-[10px] text-success font-normal">(sold)</span>}
                                      </p>
                                      {item.serialNumber && (
                                        <p className="font-mono text-[11px] text-fg-muted truncate">{item.serialNumber}</p>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {removeItemConfirmId === item.id ? (
                                        <span className="flex items-center gap-1.5">
                                          <span className="text-[10px] text-danger font-medium">Remove?</span>
                                          <button
                                            type="button"
                                            onClick={() => removeItemFromLot(lot.id, item.id)}
                                            className="px-1.5 py-0.5 text-[10px] bg-danger text-white rounded hover:bg-danger/90 transition-colors"
                                          >
                                            Yes
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setRemoveItemConfirmId(null)}
                                            className="px-1.5 py-0.5 text-[10px] border border-border text-fg-muted rounded hover:bg-muted/40 transition-colors"
                                          >
                                            No
                                          </button>
                                        </span>
                                      ) : (
                                        <>
                                          <label className="text-fg-muted">Wt</label>
                                          <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={weights[item.id] ?? '1'}
                                            onChange={(e) => setWeights((prev) => ({ ...prev, [item.id]: e.target.value }))}
                                            className="w-16 border border-border rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary text-right"
                                          />
                                          <span className="w-20 text-right font-mono font-semibold text-fg">{formatCurrency(cost)}</span>
                                          <button
                                            type="button"
                                            onClick={() => setRemoveItemConfirmId(item.id)}
                                            disabled={item.status === 'listed' || item.status === 'sold' || !!item.ebayItemId}
                                            title={
                                              item.status === 'listed' || item.status === 'sold'
                                                ? `Cannot remove a ${item.status} item — unlist or undo the sale first`
                                                : item.ebayItemId
                                                ? 'Linked to an eBay listing — end the listing first'
                                                : 'Remove item from lot'
                                            }
                                            className="p-1 rounded transition-colors text-fg-muted/70 hover:text-danger hover:bg-danger/5 disabled:opacity-40 disabled:cursor-not-allowed disabled:text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="flex items-center justify-between text-xs border-t border-border pt-2">
                              <span className="text-fg-muted">Total allocated: <span className="font-mono font-semibold text-fg">{formatCurrency(lotCost)}</span></span>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => setAllocatingLotId(null)}
                                  className="px-3 py-1.5 border border-border text-fg-muted rounded-lg hover:bg-muted/40 transition-colors"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => applyAllocation(lot)}
                                  className="px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
                                >
                                  Save Cost Basis
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })
          )}
      </div>
    </div>
  );
}

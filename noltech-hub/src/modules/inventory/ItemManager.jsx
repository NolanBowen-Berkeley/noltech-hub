import { useState, useMemo, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { Plus, X, Package, Package2, ArrowUpDown, ChevronUp, ChevronDown, RefreshCw, BarChart3 } from 'lucide-react';
import DatePicker from '../../components/DatePicker';
import { Modal } from '../../components/ui';
import EmptyState from '../../components/EmptyState';
const SoldCompsPanel = lazy(() => import('../../components/SoldCompsPanel'));
import { useApp } from '../../context/AppContext';
import {
  SOURCES, CATEGORIES, PLATFORMS, ITEM_STATUSES, CONDITIONS, GRADES,
  EBAY_TOKEN_KEY, EBAY_SYNC_LOT_ID, PIPELINE_BASE,
} from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import BundleModal from './BundleModal';
import { modalBackdrop, modalPanel } from '../../components/ui/motion';
import { parseBrand, mapCategory, mapCondition } from '../../utils/itemMapping';

// ─── SKU → lot matching (mirrors LotProfitTracker logic) ─────────────────────
// Stays here (not in utils/itemMapping) because it depends on the overlay
// state shape that's specific to inventory/lot-profit modules.
function findLotBySku(sku, lots, overlay) {
  if (!sku) return null;
  const skuU = sku.toUpperCase();
  const match = lots.find((l) => {
    const pre = overlay[l.id]?.skuPrefix?.trim().toUpperCase();
    const suf = overlay[l.id]?.skuSuffix?.trim().toUpperCase();
    if (pre && suf) return skuU.startsWith(pre) && skuU.endsWith(suf);
    if (pre)        return skuU.startsWith(pre);
    if (suf)        return skuU.endsWith(suf);
    return false;
  });
  return match || null;
}
import { calcPlatformFees, calcItemProfit, getItemCostBasis, FEE_DESCRIPTION } from '../../utils/fees';
import { formatCurrency, formatPct, formatDate, today } from '../../utils/formatters';

// ─── Style Maps ───────────────────────────────────────────────────────────────

const COND_CLS = {
  new:      'bg-success-subtle text-success border-success/30',
  like_new: 'bg-info-subtle text-info border-info/30',
  good:     'bg-accent-subtle text-accent border-accent/30',
  fair:     'bg-warning-subtle text-warning border-warning/30',
  poor:     'bg-warning-subtle text-warning border-warning/30',
  broken:   'bg-danger-subtle text-danger border-danger/30',
};

const STATUS_CLS = {
  received:   'bg-muted text-fg-muted border-border',
  testing:    'bg-info-subtle text-info border-info/30',
  listed:     'bg-accent-subtle text-accent border-accent/30',
  sold:       'bg-success-subtle text-success border-success/30',
  parted_out: 'bg-warning-subtle text-warning border-warning/30',
  recycled:   'bg-muted/40 text-fg-muted border-border',
};

// ─── Label lookup maps ────────────────────────────────────────────────────────

const SRC_LABELS  = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));
const CAT_LABELS  = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));
const PLT_LABELS  = Object.fromEntries(PLATFORMS.map((p) => [p.value, p.label]));
const COND_LABELS = Object.fromEntries(CONDITIONS.map((c) => [c.value, c.label]));
const STAT_LABELS = Object.fromEntries(ITEM_STATUSES.map((s) => [s.value, s.label]));

// ─── Blank form state ─────────────────────────────────────────────────────────

const BLANK_SALE = {
  platform: 'ebay',
  salePrice: '',
  buyerShipping: '',   // what the buyer paid for shipping (revenue)
  shippingCost: '',    // what the SELLER paid for the label (expense) — aka labelCost
  platformFees: '',    // FVF — auto-computed or synced from eBay GetOrders
  adFee: '',           // Promoted Listings / Ad Fee General — MANUAL (not in GetOrders)
  soldAt: today(),
  buyerName: '',
};

const BLANK = {
  lotId: '',
  dateAdded: today(),
  brand: '',
  model: '',
  category: 'laptop',
  serialNumber: '',
  conditionOnArrival: 'good',
  conditionGrade: '',
  status: 'received',
  notes: '',
  sold: false,
  sale: { ...BLANK_SALE },
};

// ─── Badge ────────────────────────────────────────────────────────────────────

function Badge({ children, className }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${className}`}>
      {children}
    </span>
  );
}

// ─── Profit Preview ───────────────────────────────────────────────────────────

function ProfitPreview({ form, lot }) {
  const costBasis     = (parseFloat(lot.cost) || 0) / (parseInt(lot.itemCount) || 1);
  const salePrice     = parseFloat(form.sale.salePrice) || 0;
  const buyerShipping = parseFloat(form.sale.buyerShipping) || 0;
  const labelCost     = parseFloat(form.sale.shippingCost) || 0; // seller's actual label
  const fees          = parseFloat(form.sale.platformFees) || 0;
  const adFee         = parseFloat(form.sale.adFee) || 0;
  const orderTotal    = parseFloat(form.sale.orderTotal) || 0; // true buyer-paid (incl tax)
  const salesTax      = parseFloat(form.sale.salesTax) || 0;
  const grossRevenue  = salePrice + buyerShipping;
  const netRevenue    = grossRevenue - labelCost - fees - adFee;
  const profit        = netRevenue - costBasis;
  const margin        = grossRevenue > 0 ? (profit / grossRevenue) * 100 : 0;
  const roi           = costBasis > 0 ? (profit / costBasis) * 100 : 0;
  const pos           = profit >= 0;
  const mono          = { fontFamily: "'JetBrains Mono', monospace" };
  const shipDelta     = buyerShipping - labelCost;

  const rows = [
    ['Sale Price',          salePrice,     false],
    ['Buyer-Paid Shipping', buyerShipping, false],
    ['Cost Basis',          costBasis,     true],
    ['Label Cost (seller)', labelCost,     true],
    ['Platform Fees',       fees,          true],
    ['Ad Fee (Promoted)',   adFee,         true],
  ];

  // If the sale record carries a fee breakdown (from eBay sync), surface it
  // as a small secondary line so the user can see what's in Platform Fees.
  const feeBreakdown = form.sale?.feeBreakdown && typeof form.sale.feeBreakdown === 'object'
    ? Object.entries(form.sale.feeBreakdown)
        .filter(([, v]) => Number(v) > 0)
        .sort((a, b) => b[1] - a[1])
    : null;

  return (
    <div
      className={`rounded-lg border p-4 mt-2 ${
        pos ? 'bg-success-subtle/50 border-success/30' : 'bg-danger-subtle/50 border-danger/30'
      }`}
    >
      <p className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-3">
        Profit Preview
      </p>
      {orderTotal > 0 && (
        <div className="bg-surface/60 border border-border-subtle rounded-md px-3 py-2 mb-3">
          <div className="flex justify-between text-[11px] text-fg-muted">
            <span>Order Total (buyer paid)</span>
            <span style={mono} className="font-semibold text-fg">{formatCurrency(orderTotal)}</span>
          </div>
          {salesTax > 0 && (
            <div className="flex justify-between text-[10px] text-fg-subtle mt-0.5">
              <span>incl. sales tax (eBay-remitted, not your income)</span>
              <span style={mono}>{formatCurrency(salesTax)}</span>
            </div>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        {rows.map(([label, val, deduct]) => (
          <div key={label} className="flex justify-between text-sm text-fg-muted">
            <span>{label}</span>
            <span style={mono} className={deduct ? 'text-danger' : ''}>
              {deduct ? '− ' : ''}{formatCurrency(val)}
            </span>
          </div>
        ))}
        <div className="border-t border-border pt-2 mt-1 flex justify-between font-semibold text-fg">
          <span>Net Profit</span>
          <span style={{ ...mono, color: pos ? 'var(--success)' : 'var(--danger)' }}>
            {formatCurrency(profit)}
          </span>
        </div>
        <div className="flex justify-between text-xs text-fg-muted">
          <span>Margin / ROI</span>
          <span style={{ ...mono, color: pos ? 'var(--success)' : 'var(--danger)' }}>
            {formatPct(margin)} / {formatPct(roi)}
          </span>
        </div>
        {(buyerShipping > 0 || labelCost > 0) && (
          <div className="flex justify-between text-[11px] text-fg-subtle pt-1 border-t border-border/30 mt-1">
            <span>Shipping Δ (buyer − label)</span>
            <span style={{ ...mono, color: shipDelta > 0 ? 'var(--success)' : shipDelta < 0 ? 'var(--danger)' : 'var(--fg-muted)' }}>
              {shipDelta > 0 ? '+' : ''}{formatCurrency(shipDelta)}
            </span>
          </div>
        )}
        {feeBreakdown && feeBreakdown.length > 1 && (
          <div className="pt-1 border-t border-border/30 mt-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle mb-1">Fee Breakdown</p>
            {feeBreakdown.map(([name, val]) => (
              <div key={name} className="flex justify-between text-[11px] text-fg-subtle">
                <span>{name.replace(/([A-Z])/g, ' $1').replace(/^ /, '')}</span>
                <span style={{ ...mono }}>{formatCurrency(val)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Cost Basis Modal ─────────────────────────────────────────────────────────
function CostBasisModal({ items, onConfirm, onCancel }) {
  const [mode, setMode]     = useState('fixed'); // 'fixed' | 'split'
  const [amount, setAmount] = useState('');

  const parsed   = parseFloat(amount) || 0;
  const perItem  = mode === 'fixed' ? parsed : (items.length > 0 ? parsed / items.length : 0);
  const total    = mode === 'fixed' ? parsed * items.length : parsed;

  return (
    <motion.div {...modalBackdrop} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onCancel}>
      <motion.div {...modalPanel} onClick={(e) => e.stopPropagation()} className="glossy-elevated w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border-subtle">
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Package className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-fg">Set Cost Basis</p>
            <p className="text-xs text-fg-muted">{items.length} item{items.length !== 1 ? 's' : ''} selected</p>
          </div>
          <button onClick={onCancel} className="ml-auto text-fg-muted hover:text-fg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Mode toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm font-medium">
            <button
              onClick={() => setMode('fixed')}
              className={`flex-1 px-4 py-2 transition-colors ${mode === 'fixed' ? 'bg-primary text-white' : 'bg-surface text-fg-muted hover:bg-muted/40'}`}
            >
              Per-item amount
            </button>
            <button
              onClick={() => setMode('split')}
              className={`flex-1 px-4 py-2 transition-colors ${mode === 'split' ? 'bg-primary text-white' : 'bg-surface text-fg-muted hover:bg-muted/40'}`}
            >
              Split total cost
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1">
              {mode === 'fixed' ? 'Cost per item ($)' : 'Total lot cost to split ($)'}
            </label>
            <input
              type="number" step="0.01" min="0" autoFocus
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary"
            />
          </div>

          {/* Summary */}
          {parsed > 0 && (
            <div className="bg-muted/40 rounded-lg px-4 py-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-fg-muted">Per item</span>
                <span className="font-mono font-semibold text-fg">{formatCurrency(perItem)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-fg-muted">Total across {items.length} items</span>
                <span className="font-mono text-fg-muted">{formatCurrency(total)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-border-subtle">
          <button onClick={onCancel}
            className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium text-fg-muted hover:bg-muted/40 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => perItem > 0 && onConfirm(perItem)}
            disabled={perItem <= 0}
            className="flex-1 px-4 py-2 bg-primary text-white rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 transition-colors">
            Apply to {items.length} item{items.length !== 1 ? 's' : ''}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ItemManager({ filters, setFilters, clearFilters }) {
  const { state, dispatch } = useApp();
  const [form, setForm]       = useState(BLANK);
  const [editId, setEditId]   = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [errors, setErrors]   = useState({});
  const [sort, setSort]       = useState({ field: 'dateAdded', dir: 'desc' });
  const [syncing, setSyncing]       = useState(false);
  const [syncMsg, setSyncMsg]       = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [costBasisModal, setCostBasisModal] = useState(false);
  // Sold-comps lookup modal for a single item (brand + model query).
  const [compsItem, setCompsItem] = useState(null);
  const [bundleModal, setBundleModal] = useState(false);
  const [bundleToast, setBundleToast] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkActionOpen, setBulkActionOpen] = useState(false);

  // ── eBay listing sync ──────────────────────────────────────────────────────

  const syncEbay = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(rawCreds || {});
      if (!creds?.token) {
        setSyncMsg('No eBay token saved. Add it in Settings → eBay Credentials.');
        return;
      }

      const params = new URLSearchParams({ userToken: creds.token });
      if (creds.appId)  params.set('appId',  creds.appId);
      if (creds.devId)  params.set('devId',  creds.devId);
      if (creds.certId) params.set('certId', creds.certId);

      const res  = await fetch(`${PIPELINE_BASE}/api/ebay/listings?${params}`, { signal: AbortSignal.timeout(45000) });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'eBay API error');


      // Load SKU overlay so new items can be assigned to the right lot by SKU
      const skuOverlay = await window.storage.get('noltech:lotprofit:overlay').catch(() => ({})) || {};

      // Build a map of ebayItemId → existing item id for dedup + updates
      const existingMap = new Map(
        state.lots.flatMap((l) => (l.items || [])
          .filter((i) => i.ebayItemId)
          .map((i) => [i.ebayItemId, i.id])
        )
      );

      // Ensure the sync lot exists
      const syncLotExists = state.lots.some((l) => l.id === EBAY_SYNC_LOT_ID);
      if (!syncLotExists) {
        dispatch({
          type: 'ADD_LOT',
          lot: {
            id:           EBAY_SYNC_LOT_ID,
            source:       'other',
            sourceName:   'eBay Active Listings',
            purchaseDate: new Date().toISOString().slice(0, 10),
            cost:         0,
            itemCount:    0,
            status:       'listed',
            notes:        'Auto-synced from eBay. Do not delete.',
            items:        [],
          },
        });
      }

      let added = 0, updated = 0;
      for (const listing of data.listings) {
        const notes = [
          listing.conditionName || '',
          listing.watchCount  > 0 ? `${listing.watchCount} watching`  : '',
          listing.hitCount    > 0 ? `${listing.hitCount} views`        : '',
          listing.quantitySold > 0 ? `${listing.quantitySold} sold`   : '',
        ].filter(Boolean).join(' · ');

        const category  = listing.categoryInternal  || mapCategory(listing.categoryName);
        const condition = listing.conditionId
          ? mapCondition(listing.conditionId, listing.conditionName)
          : '';

        const listingQuantity = Math.max(1, parseInt(listing.quantity) || 1);

        if (existingMap.has(listing.itemId)) {
          const matchedLot = findLotBySku(listing.sku, state.lots, skuOverlay);
          dispatch({
            type: 'UPDATE_ITEM',
            id:   existingMap.get(listing.itemId),
            updates: {
              conditionOnArrival:  condition,
              ebayConditionName:   listing.conditionName || '',
              category,
              listingPrice:        listing.currentPrice,
              listingQuantity,
              notes,
              ...(matchedLot ? { lotId: matchedLot.id } : {}),
            },
          });
          updated++;
        } else {
          const matchedLot = findLotBySku(listing.sku, state.lots, skuOverlay);
          dispatch({
            type: 'ADD_ITEM',
            item: {
              id:                 crypto.randomUUID(),
              lotId:              matchedLot ? matchedLot.id : EBAY_SYNC_LOT_ID,
              ebayItemId:         listing.itemId,
              dateAdded:          listing.startTime ? listing.startTime.slice(0, 10) : new Date().toISOString().slice(0, 10),
              brand:              parseBrand(listing.title),
              model:              listing.title,
              category,
              serialNumber:       listing.sku || '',
              conditionOnArrival:  condition,
              ebayConditionName:   listing.conditionName || '',
              conditionGrade:      '',
              status:              'listed',
              notes,
              listingPrice:       listing.currentPrice,
              listingQuantity,
              listingUrl:         `https://www.ebay.com/itm/${listing.itemId}`,
              sale:               null,
            },
          });
          added++;
        }
      }

      // ── Step 2: Sync sold orders (last 89 days) ───────────────────────────
      setSyncMsg('Syncing sold orders…');

      // Build SKU → item id fallback map
      const skuMap = new Map(
        state.lots.flatMap((l) => (l.items || [])
          .filter((i) => i.serialNumber)
          .map((i) => [i.serialNumber, i.id])
        )
      );
      // Build item id → full item map for costBasis lookup
      const itemById = new Map(
        state.lots.flatMap((l) => (l.items || []).map((i) => [i.id, i]))
      );

      const ordersRes = await fetch(`${PIPELINE_BASE}/api/ebay/orders`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userToken: creds.token,
          appId:     creds.appId  || '',
          devId:     creds.devId  || '',
          certId:    creds.certId || '',
        }),
        signal: AbortSignal.timeout(60000),
      });
      const ordersData = await ordersRes.json();

      let soldCount = 0;
      if (ordersData.success) {
        for (const order of ordersData.orders) {
          const itemId = existingMap.get(order.ebayItemId) || skuMap.get(order.sku);
          if (!itemId) continue;

          const existing = itemById.get(itemId);
          if (existing?.status === 'sold') continue; // already recorded

          const costBasis = existing?.costBasis || 0;
          const profit    = Math.round((order.netPayout - costBasis) * 100) / 100;

          const labelCost = parseFloat(order.labelCost) || 0;
          const buyerShipping = parseFloat(order.buyerShipping) || 0;
          const trueNet = order.netPayout - labelCost;
          const trueProfit = Math.round((trueNet - costBasis) * 100) / 100;
          dispatch({
            type: 'UPDATE_ITEM',
            id:   itemId,
            updates: {
              status: 'sold',
              sale: {
                id:           order.orderId,
                platform:     'ebay',
                // Seller revenue: item price + buyer shipping + adjustments (no tax)
                salePrice:    order.totalRevenue,
                subtotal:     order.subtotal || 0,
                buyerShipping,
                // eBay-remitted sales tax (informational, not seller income)
                salesTax:     parseFloat(order.salesTax) || 0,
                // True buyer-paid total (matches eBay's "Order total" + 1099-K)
                orderTotal:   parseFloat(order.orderTotal) || 0,
                labelCost,
                labelCostKnown: !!order.labelCostKnown,
                shippingCost: labelCost,
                platformFees: order.ebayFees,
                feeBreakdown: order.feeBreakdown || null,
                netRevenue:   trueNet,
                profit:       trueProfit,
                soldAt:       order.date,
                buyerName:    order.buyer || '',
              },
            },
          });
          soldCount++;
        }
      }

      setSyncMsg(
        `Synced ${data.total} listing${data.total !== 1 ? 's' : ''} — ${added} new, ${updated} updated · ${soldCount} marked sold.`
      );
    } catch (err) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 10000);
    }
  };

  const hasFilters = Object.values(filters).some(Boolean);

  const inputCls =
    'w-full border border-border rounded-lg px-3 py-2 text-sm text-fg bg-surface ' +
    'focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary transition-colors';
  const labelCls = 'block text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1';

  // ── Form field helpers ─────────────────────────────────────────────────────

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Updates a sale field and auto-recalcs fees when platform/price/shipping change.
  // Fees field itself is NOT auto-recalced (user override preserved).
  const updateSaleField = (k, v) => {
    setForm((prev) => {
      const nextSale = { ...prev.sale, [k]: v };
      if (['platform', 'salePrice', 'shippingCost'].includes(k)) {
        const auto = calcPlatformFees(nextSale.platform, nextSale.salePrice, nextSale.shippingCost);
        nextSale.platformFees = auto.toFixed(2);
      }
      return { ...prev, sale: nextSale };
    });
  };

  const toggleSold = (checked) => {
    setForm((prev) => {
      const next = { ...prev, sold: checked, status: checked ? 'sold' : 'received' };
      if (checked) {
        const auto = calcPlatformFees(prev.sale.platform, prev.sale.salePrice, prev.sale.shippingCost);
        next.sale = {
          ...prev.sale,
          soldAt: prev.sale.soldAt || today(),
          platformFees: auto.toFixed(2),
        };
      }
      return next;
    });
  };

  // ── Validation ─────────────────────────────────────────────────────────────

  const validate = () => {
    const e = {};
    if (!form.lotId) e.lotId = 'Select a lot';
    if (!form.brand.trim()) e.brand = 'Required';
    if (!form.model.trim()) e.model = 'Required';
    if (form.sold && (!form.sale.salePrice || parseFloat(form.sale.salePrice) <= 0)) {
      e.salePrice = 'Required for sold items';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Submit ─────────────────────────────────────────────────────────────────

  const submit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    let sale = null;
    if (form.sold) {
      const sp  = parseFloat(form.sale.salePrice) || 0;
      const bs  = parseFloat(form.sale.buyerShipping) || 0;
      const sh  = parseFloat(form.sale.shippingCost) || 0;   // label cost (seller)
      const pfBase = parseFloat(form.sale.platformFees) || 0;
      const adFee  = parseFloat(form.sale.adFee) || 0;
      const pf  = pfBase + adFee;                            // total fees = platform + ad
      const gross = sp + bs;                                 // total revenue
      const net = gross - sh - pf;                           // net after fees + label
      const lot = state.lots.find((l) => l.id === form.lotId);
      const cb  = lot ? (parseFloat(lot.cost) || 0) / (parseInt(lot.itemCount) || 1) : 0;
      // Merge ad fee into feeBreakdown (preserve any existing breakdown from sync)
      const prevBreakdown = (form.sale.feeBreakdown && typeof form.sale.feeBreakdown === 'object')
        ? { ...form.sale.feeBreakdown }
        : {};
      // Rebuild breakdown so it never drifts from pf: keep existing split if any,
      // otherwise record FVF + Ad Fee as two lines.
      let feeBreakdown = prevBreakdown;
      if (Object.keys(feeBreakdown).length > 0) {
        // Update the ad-fee bucket; keep other buckets as eBay reported them
        if (adFee > 0) feeBreakdown.AdFeeGeneral = adFee;
        else delete feeBreakdown.AdFeeGeneral;
        // If manual platform-fee edit diverges from the non-ad buckets, reconcile:
        const nonAdSum = Object.entries(feeBreakdown)
          .filter(([k]) => k !== 'AdFeeGeneral')
          .reduce((s, [, v]) => s + (Number(v) || 0), 0);
        if (Math.abs(nonAdSum - pfBase) > 0.01) {
          feeBreakdown = { ...feeBreakdown, FinalValueFee: pfBase };
        }
      } else if (pfBase > 0 || adFee > 0) {
        feeBreakdown = {};
        if (pfBase > 0) feeBreakdown.FinalValueFee = pfBase;
        if (adFee > 0)  feeBreakdown.AdFeeGeneral = adFee;
      } else {
        feeBreakdown = null;
      }
      sale = {
        platform:      form.sale.platform,
        salePrice:     gross,                                // rev side (incl buyer ship)
        buyerShipping: bs,
        labelCost:     sh,
        labelCostKnown: sh > 0,
        shippingCost:  sh,                                   // legacy mirror
        platformFees:  pf,
        feeBreakdown,
        netRevenue:    net,
        profit:        net - cb,
        soldAt:        form.sale.soldAt || today(),
        buyerName:     form.sale.buyerName.trim(),
      };
    }

    const itemData = {
      lotId:             form.lotId,
      dateAdded:         form.dateAdded,
      brand:             form.brand.trim(),
      model:             form.model.trim(),
      category:          form.category,
      serialNumber:      form.serialNumber.trim(),
      conditionOnArrival: form.conditionOnArrival,
      conditionGrade:    form.conditionGrade,
      status:            form.sold ? 'sold' : form.status,
      notes:             form.notes.trim(),
      sale,
    };

    if (editId) {
      dispatch({ type: 'UPDATE_ITEM', id: editId, updates: itemData });
      setEditId(null);
    } else {
      dispatch({ type: 'ADD_ITEM', item: { id: crypto.randomUUID(), ...itemData } });
    }

    setForm(BLANK);
    setShowForm(false);
    setErrors({});
  };

  // ── Edit helpers ───────────────────────────────────────────────────────────

  const startEdit = (item) => {
    setEditId(item.id);
    setShowForm(true);
    const isSold = item.status === 'sold' && !!item.sale;
    setForm({
      lotId:              item.lotId,
      dateAdded:          item.dateAdded || today(),
      brand:              item.brand || '',
      model:              item.model || '',
      category:           item.category || 'laptop',
      serialNumber:       item.serialNumber || '',
      conditionOnArrival: item.conditionOnArrival || 'good',
      conditionGrade:     item.conditionGrade || '',
      status:             item.status || 'received',
      notes:              item.notes || '',
      sold:               isSold,
      sale: item.sale
        ? (() => {
            // Split stored platformFees back into (platform base) + (ad fee)
            // using the preserved breakdown if we have it.
            const breakdown = item.sale.feeBreakdown && typeof item.sale.feeBreakdown === 'object'
              ? item.sale.feeBreakdown
              : null;
            const adFee = breakdown
              ? Number(breakdown.AdFeeGeneral || breakdown.AdFee || breakdown.PromotedListingsStandardFee || 0) || 0
              : 0;
            const totalFees = Number(item.sale.platformFees) || 0;
            const baseFees = breakdown
              ? Math.max(0, Math.round((totalFees - adFee) * 100) / 100)
              : totalFees;
            return {
              platform:      item.sale.platform || 'ebay',
              salePrice:     String(item.sale.salePrice ?? ''),
              buyerShipping: String(item.sale.buyerShipping ?? ''),
              // Label cost is the canonical field; fall back to legacy shippingCost
              shippingCost:  String(item.sale.labelCost ?? item.sale.shippingCost ?? ''),
              platformFees:  baseFees ? String(baseFees) : '',
              adFee:         adFee ? String(adFee) : '',
              feeBreakdown:  breakdown,
              soldAt:        item.sale.soldAt || today(),
              buyerName:     item.sale.buyerName || '',
            };
          })()
        : { ...BLANK_SALE },
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const markSold = (item) => {
    setEditId(item.id);
    setForm({
      lotId:              item.lotId,
      dateAdded:          item.dateAdded || today(),
      brand:              item.brand || '',
      model:              item.model || '',
      category:           item.category || 'laptop',
      serialNumber:       item.serialNumber || '',
      conditionOnArrival: item.conditionOnArrival || 'good',
      conditionGrade:     item.conditionGrade || '',
      status:             'sold',
      notes:              item.notes || '',
      sold:               true,
      sale:               { ...BLANK_SALE, soldAt: today() },
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelForm = () => {
    setEditId(null);
    setForm(BLANK);
    setShowForm(false);
    setErrors({});
  };

  const confirmDeleteItem = (itemId) => {
    dispatch({ type: 'DELETE_ITEM', id: itemId });
    setDeleteConfirmId(null);
  };

  // ── Derived data ───────────────────────────────────────────────────────────

  const allItems = useMemo(
    () => state.lots.flatMap((l) => (l.items || []).map((item) => ({ ...item, _lot: l }))),
    [state.lots]
  );

  const filtered = useMemo(
    () =>
      allItems.filter((item) => {
        if (filters.source   && item._lot.source         !== filters.source)   return false;
        if (filters.category && item.category            !== filters.category) return false;
        if (filters.platform && item.sale?.platform      !== filters.platform) return false;
        if (filters.dateFrom && item.sale?.soldAt && item.sale.soldAt < filters.dateFrom) return false;
        if (filters.dateTo   && item.sale?.soldAt && item.sale.soldAt > filters.dateTo)   return false;
        return true;
      }),
    [allItems, filters]
  );

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aM = a.status === 'sold' && a.sale ? calcItemProfit(a, a._lot) : null;
      const bM = b.status === 'sold' && b.sale ? calcItemProfit(b, b._lot) : null;
      const aCB = (parseFloat(a._lot.cost) || 0) / (parseInt(a._lot.itemCount) || 1);
      const bCB = (parseFloat(b._lot.cost) || 0) / (parseInt(b._lot.itemCount) || 1);

      let av, bv;
      switch (sort.field) {
        case 'brand':             av = `${a.brand} ${a.model}`.toLowerCase(); bv = `${b.brand} ${b.model}`.toLowerCase(); break;
        case 'category':          av = a.category;           bv = b.category;           break;
        case 'conditionOnArrival':av = a.conditionOnArrival; bv = b.conditionOnArrival; break;
        case 'costBasis':         av = aCB;                  bv = bCB;                  break;
        case 'salePrice':         av = a.sale?.salePrice  ?? -Infinity; bv = b.sale?.salePrice  ?? -Infinity; break;
        case 'profit':            av = aM?.profit         ?? -Infinity; bv = bM?.profit         ?? -Infinity; break;
        case 'roi':               av = aM?.roi            ?? -Infinity; bv = bM?.roi            ?? -Infinity; break;
        case 'soldAt':            av = a.sale?.soldAt     || '';        bv = b.sale?.soldAt     || '';        break;
        case 'status':            av = a.status;             bv = b.status;             break;
        default:                  av = a.dateAdded || '';    bv = b.dateAdded || '';    break;
      }

      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ?  1 : -1;
      return 0;
    });
  }, [filtered, sort]);

  const handleSort = (field) =>
    setSort((s) => ({ field, dir: s.field === field && s.dir === 'asc' ? 'desc' : 'asc' }));

  // ── Bulk selection helpers (must be after sorted) ──────────────────────────
  const visibleIds    = sorted.map((i) => i.id);
  const allSelected   = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someSelected  = visibleIds.some((id) => selectedIds.has(id));
  const selectedItems = sorted.filter((i) => selectedIds.has(i.id));

  const toggleItem = (id) =>
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(visibleIds));

  const applyBulkCostBasis = (perItem) => {
    selectedItems.forEach((item) =>
      dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { costBasis: perItem } })
    );
    setSelectedIds(new Set());
    setCostBasisModal(false);
  };

  // ── Bulk actions v2 ───────────────────────────────────────────────────────
  const applyBulkStatus = (status) => {
    if (!status) return;
    selectedItems.forEach((item) =>
      dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { status } })
    );
    setBulkStatus(`Updated ${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''} to ${status}`);
    setTimeout(() => setBulkStatus(''), 3000);
    setSelectedIds(new Set());
    setBulkActionOpen(false);
  };

  const bulkDelete = () => {
    const n = selectedItems.length;
    if (!confirm(`Delete ${n} selected item${n !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    selectedItems.forEach((item) => dispatch({ type: 'DELETE_ITEM', id: item.id }));
    setBulkStatus(`Deleted ${n} item${n !== 1 ? 's' : ''}`);
    setTimeout(() => setBulkStatus(''), 3000);
    setSelectedIds(new Set());
    setBulkActionOpen(false);
  };

  const bulkPrintSlips = async () => {
    // Print slips for any selected item that has a sale object
    const { printShippingSlip } = await import('../../utils/shippingSlip');
    const withSales = selectedItems.filter((i) => i.sale);
    if (withSales.length === 0) {
      setBulkStatus('No sold items in selection');
      setTimeout(() => setBulkStatus(''), 3000);
      return;
    }
    withSales.forEach((i, idx) => {
      setTimeout(() => printShippingSlip({
        orderId: i.sale?.id,
        title: i.model || i.brand,
        sku: i.sku || i.serialNumber,
        qty: 1,
        buyer: i.sale?.buyerName,
        shipTo: i.sale?.shipTo,
        date: i.sale?.soldAt,
      }), idx * 250);  // Stagger so popups don't get blocked
    });
    setBulkActionOpen(false);
  };

  const bulkExportCsv = () => {
    const headers = ['sku', 'brand', 'model', 'category', 'condition', 'status', 'costBasis', 'listingPrice', 'salePrice', 'lotId'];
    const rows = selectedItems.map((i) => [
      i.sku || i.serialNumber || '', i.brand || '', i.model || '', i.category || '',
      i.conditionOnArrival || '', i.status || '', i.costBasis || '',
      i.listingPrice || '', i.sale?.salePrice || '', i.lotId || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-selection-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setBulkActionOpen(false);
  };

  const selectedLot = state.lots.find((l) => l.id === form.lotId);
  const soldCount   = allItems.filter((i) => i.status === 'sold').length;
  const availCount  = allItems.filter(
    (i) => i.status !== 'sold' && i.status !== 'recycled' && i.status !== 'parted_out'
  ).length;

  // ── Sort header ────────────────────────────────────────────────────────────

  const SortTh = ({ field, children, right }) => {
    const active = sort.field === field;
    return (
      <th
        onClick={() => handleSort(field)}
        className={`py-3 px-3 text-xs font-semibold text-fg-muted uppercase tracking-wide
          cursor-pointer select-none hover:text-fg transition-colors whitespace-nowrap
          ${right ? 'text-right' : 'text-left'}`}
      >
        <span className="inline-flex items-center gap-1">
          {children}
          {active
            ? sort.dir === 'asc'
              ? <ChevronUp   className="w-3 h-3 text-secondary" />
              : <ChevronDown className="w-3 h-3 text-secondary" />
            : <ArrowUpDown className="w-3 h-3 opacity-30" />
          }
        </span>
      </th>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-screen-2xl">

      {/* Page Header */}
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-fg tracking-tight">Inventory</h1>
          <p className="text-sm text-fg-muted mt-0.5">
            {allItems.length} items total ·{' '}
            <span className="text-success font-medium">{soldCount} sold</span> ·{' '}
            <span className="text-accent font-medium">{availCount} available</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={syncEbay}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm font-medium text-fg-muted hover:bg-muted/40 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync eBay'}
          </button>
          <button
            onClick={() => {
              if (showForm && !editId) cancelForm();
              else { setEditId(null); setForm(BLANK); setShowForm(true); }
            }}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors"
          >
            {showForm && !editId ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {showForm && !editId ? 'Cancel' : 'Add Item'}
          </button>
        </div>
      </div>

      {/* Cost basis modal */}
      {costBasisModal && (
        <CostBasisModal
          items={selectedItems}
          onConfirm={applyBulkCostBasis}
          onCancel={() => setCostBasisModal(false)}
        />
      )}

      {/* Bundle modal */}
      {bundleModal && (
        <BundleModal
          selectedItems={selectedItems}
          onClose={() => setBundleModal(false)}
          onCreated={(bundle) => {
            setBundleModal(false);
            setSelectedIds(new Set());
            setBundleToast(`Bundle "${bundle.title}" created with ${bundle.itemIds.length} items`);
            setTimeout(() => setBundleToast(''), 4000);
          }}
        />
      )}

      {bundleToast && (
        <div className="mb-4 px-4 py-2.5 rounded-lg text-sm font-medium border bg-success/10 border-success/20 text-success">
          {bundleToast}
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-accent-subtle border border-accent/20 rounded-lg flex-wrap">
          <span className="text-sm font-medium text-accent-fg">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => setCostBasisModal(true)}
            className="flex items-center gap-1 px-2.5 py-1 bg-accent text-accent-fg text-xs font-semibold rounded-md hover:bg-accent-hover transition-colors"
          >
            <Package className="w-3 h-3" /> Cost Basis
          </button>
          {selectedIds.size >= 2 && (
            <button
              onClick={() => setBundleModal(true)}
              className="flex items-center gap-1 px-2.5 py-1 border border-accent/30 text-accent text-xs font-semibold rounded-md hover:bg-accent/10 transition-colors"
            >
              <Package className="w-3 h-3" /> Bundle
            </button>
          )}

          {/* Status dropdown */}
          <select
            value=""
            onChange={(e) => applyBulkStatus(e.target.value)}
            className="px-2 py-1 border border-accent/30 bg-surface text-accent text-xs font-semibold rounded-md cursor-pointer"
          >
            <option value="">Set status…</option>
            {ITEM_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          <button
            onClick={bulkPrintSlips}
            className="flex items-center gap-1 px-2.5 py-1 border border-accent/30 text-accent text-xs font-semibold rounded-md hover:bg-accent/10 transition-colors"
            title="Print shipping slips for sold items in selection"
          >
            <Package className="w-3 h-3" /> Print Slips
          </button>

          <button
            onClick={bulkExportCsv}
            className="flex items-center gap-1 px-2.5 py-1 border border-accent/30 text-accent text-xs font-semibold rounded-md hover:bg-accent/10 transition-colors"
          >
            Export CSV
          </button>

          <button
            onClick={bulkDelete}
            className="flex items-center gap-1 px-2.5 py-1 border border-danger/30 text-danger text-xs font-semibold rounded-md hover:bg-danger/10 transition-colors"
          >
            Delete
          </button>

          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-fg-muted hover:text-fg transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {bulkStatus && (
        <div className="mb-4 px-3 py-2 bg-success-subtle border border-success/20 rounded-lg text-sm text-success-fg font-medium">
          {bulkStatus}
        </div>
      )}

      {/* Sync status message */}
      {syncMsg && (
        <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm font-medium border ${
          syncMsg.startsWith('Sync failed') || syncMsg.startsWith('No eBay')
            ? 'bg-danger/5 border-danger/20 text-danger'
            : 'bg-success/10 border-success/20 text-success'
        }`}>
          {syncMsg}
        </div>
      )}

      {/* ── Item Form ── */}
      {showForm && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-6 mb-5">
          <h2 className="text-base font-semibold text-fg mb-5">
            {editId ? 'Edit Item' : 'Add Item to Inventory'}
          </h2>

          <form onSubmit={submit} className="space-y-4">

            {/* Lot + Date Added */}
            <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-3">
              <div>
                <label className={labelCls}>Lot *</label>
                <select
                  value={form.lotId}
                  onChange={(e) => setField('lotId', e.target.value)}
                  className={inputCls}
                >
                  <option value="">— Select a lot —</option>
                  {[...state.lots]
                    .sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''))
                    .map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        {lot.purchaseDate} · {SRC_LABELS[lot.source] || lot.source}
                        {lot.sourceName ? ` · ${lot.sourceName}` : ''} · avg{' '}
                        {formatCurrency((parseFloat(lot.cost) || 0) / (parseInt(lot.itemCount) || 1))}/unit
                      </option>
                    ))}
                </select>
                {errors.lotId && <p className="text-xs text-danger mt-1">{errors.lotId}</p>}
              </div>
              <div>
                <label className={labelCls}>Date Added</label>
                <DatePicker value={form.dateAdded} onChange={v => setField('dateAdded', v)} />
              </div>
            </div>

            {/* Brand + Model + Category */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Brand *</label>
                <input
                  type="text"
                  placeholder="e.g. Lenovo, Dell, EVGA"
                  value={form.brand}
                  onChange={(e) => setField('brand', e.target.value)}
                  className={inputCls}
                />
                {errors.brand && <p className="text-xs text-danger mt-1">{errors.brand}</p>}
              </div>
              <div>
                <label className={labelCls}>Model *</label>
                <input
                  type="text"
                  placeholder="e.g. ThinkPad T490, RTX 3080"
                  value={form.model}
                  onChange={(e) => setField('model', e.target.value)}
                  className={inputCls}
                />
                {errors.model && <p className="text-xs text-danger mt-1">{errors.model}</p>}
              </div>
              <div>
                <label className={labelCls}>Category</label>
                <select
                  value={form.category}
                  onChange={(e) => setField('category', e.target.value)}
                  className={inputCls}
                >
                  {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>

            {/* Condition + Grade + Status + Serial */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className={labelCls}>Condition</label>
                <select
                  value={form.conditionOnArrival}
                  onChange={(e) => setField('conditionOnArrival', e.target.value)}
                  className={inputCls}
                >
                  {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Grade</label>
                <select
                  value={form.conditionGrade}
                  onChange={(e) => setField('conditionGrade', e.target.value)}
                  className={inputCls}
                >
                  <option value="">— None —</option>
                  {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Status</label>
                <select
                  value={form.sold ? 'sold' : form.status}
                  onChange={(e) => setField('status', e.target.value)}
                  disabled={form.sold}
                  className={inputCls + (form.sold ? ' opacity-60 cursor-not-allowed' : '')}
                >
                  {ITEM_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Serial #</label>
                <input
                  type="text"
                  placeholder="Optional"
                  value={form.serialNumber}
                  onChange={(e) => setField('serialNumber', e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className={labelCls}>Notes</label>
              <input
                type="text"
                placeholder="Specs, issues, anything worth noting..."
                value={form.notes}
                onChange={(e) => setField('notes', e.target.value)}
                className={inputCls}
              />
            </div>

            {/* Sold toggle */}
            <div className="border-t border-border-subtle pt-4">
              <label className="inline-flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.sold}
                  onChange={(e) => toggleSold(e.target.checked)}
                  className="w-4 h-4 rounded accent-secondary"
                />
                <span className="text-sm font-semibold text-fg">Mark as Sold</span>
              </label>
            </div>

            {/* Sale panel */}
            {form.sold && (
              <div className="bg-secondary/5 border border-secondary/20 rounded-xl p-5 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div>
                    <label className={labelCls}>Date Sold</label>
                    <DatePicker value={form.sale.soldAt} onChange={v => updateSaleField('soldAt', v)} />
                  </div>
                  <div>
                    <label className={labelCls}>Platform</label>
                    <select
                      value={form.sale.platform}
                      onChange={(e) => updateSaleField('platform', e.target.value)}
                      className={inputCls}
                    >
                      {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Buyer Name</label>
                    <input
                      type="text"
                      placeholder="Optional"
                      value={form.sale.buyerName}
                      onChange={(e) => updateSaleField('buyerName', e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Sale Price ($) *</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={form.sale.salePrice}
                      onChange={(e) => updateSaleField('salePrice', e.target.value)}
                      className={inputCls}
                    />
                    {errors.salePrice && (
                      <p className="text-xs text-danger mt-1">{errors.salePrice}</p>
                    )}
                  </div>
                  <div>
                    <label className={labelCls}>
                      Buyer-Paid Shipping ($)
                      <span className="ml-1.5 text-[10px] text-fg-subtle font-normal normal-case tracking-normal">revenue</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={form.sale.buyerShipping}
                      onChange={(e) => updateSaleField('buyerShipping', e.target.value)}
                      className={inputCls}
                    />
                    <p className="text-[11px] text-fg-subtle mt-1">What the buyer paid for shipping.</p>
                  </div>
                  <div>
                    <label className={labelCls}>
                      Label Cost ($)
                      <span className="ml-1.5 text-[10px] text-fg-subtle font-normal normal-case tracking-normal">expense</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={form.sale.shippingCost}
                      onChange={(e) => updateSaleField('shippingCost', e.target.value)}
                      className={inputCls}
                    />
                    <p className="text-[11px] text-fg-subtle mt-1">What you paid for the actual label.</p>
                  </div>
                  <div>
                    <label className={labelCls}>
                      Platform Fees ($)
                      <span className="ml-1.5 text-[10px] bg-secondary/15 text-secondary px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">
                        auto
                      </span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={form.sale.platformFees}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, sale: { ...f.sale, platformFees: e.target.value } }))
                      }
                      className={inputCls}
                    />
                    <p className="text-xs text-fg-muted mt-1">
                      {FEE_DESCRIPTION[form.sale.platform] || '0%'}
                    </p>
                  </div>
                  {form.sale.platform === 'ebay' && (
                    <div className="md:col-span-2">
                      <label className={labelCls}>
                        Ad Fee / Promoted Listings ($)
                        <span className="ml-1.5 text-[10px] bg-warning-subtle text-warning-fg px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">
                          manual
                        </span>
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        value={form.sale.adFee}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, sale: { ...f.sale, adFee: e.target.value } }))
                        }
                        className={inputCls}
                      />
                      <p className="text-[11px] text-fg-muted mt-1 leading-relaxed">
                        eBay doesn't return Promoted Listings fees in the order API — they're billed separately.
                        Grab this from <span className="font-medium">Seller Hub → Performance → Promoted Listings</span>,
                        or from your monthly eBay invoice. It'll be added to Platform Fees on save and surface in the fee
                        breakdown.
                      </p>
                    </div>
                  )}
                </div>

                {selectedLot && form.sale.salePrice && (
                  <ProfitPreview form={form} lot={selectedLot} />
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={cancelForm}
                className="px-4 py-2 border border-border text-fg-muted rounded-lg text-sm font-medium hover:bg-muted/40 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors"
              >
                {editId ? 'Save Changes' : 'Add Item'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Table Card ── */}
      <div className="bg-surface rounded-xl border border-border shadow-sm">

        {/* Filter bar */}
        <div className="p-4 border-b border-border-subtle flex flex-wrap items-end gap-3">
          {[
            { key: 'source',   label: 'Source',   opts: SOURCES },
            { key: 'category', label: 'Category', opts: CATEGORIES },
            { key: 'platform', label: 'Platform', opts: PLATFORMS },
          ].map(({ key, label, opts }) => (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">{label}</label>
              <select
                value={filters[key]}
                onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}
                className="border border-border rounded-lg px-2.5 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-secondary/30 focus:border-secondary"
              >
                <option value="">All</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Sold From</label>
            <DatePicker value={filters.dateFrom} onChange={v => setFilters(f => ({ ...f, dateFrom: v }))} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Sold To</label>
            <DatePicker value={filters.dateTo} onChange={v => setFilters(f => ({ ...f, dateTo: v }))} />
          </div>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="self-end flex items-center gap-1.5 px-3 py-1.5 text-sm text-danger border border-danger/30 rounded-lg hover:bg-danger/5 transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>

        {/* Empty state */}
        {sorted.length === 0 ? (
          <EmptyState
            icon={Package2}
            title={allItems.length === 0 ? 'Nothing here yet' : 'No items match current filters'}
            description={allItems.length === 0
              ? 'Add a lot first, then log items from that lot.'
              : 'Try clearing filters to see all items.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 border-b border-border">
                <tr>
                  <th className="py-3 px-3 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                      onChange={toggleAll}
                      className="accent-primary w-3.5 h-3.5 cursor-pointer"
                    />
                  </th>
                  <SortTh field="brand">Item</SortTh>
                  <SortTh field="category">Category</SortTh>
                  <SortTh field="conditionOnArrival">Condition</SortTh>
                  <SortTh field="costBasis" right>Cost Basis</SortTh>
                  <SortTh field="salePrice" right>Sale Price</SortTh>
                  <SortTh field="profit" right>Profit</SortTh>
                  <SortTh field="roi" right>ROI</SortTh>
                  <th className="py-3 px-3 text-xs font-semibold text-fg-muted uppercase tracking-wide text-left whitespace-nowrap">
                    Platform
                  </th>
                  <SortTh field="soldAt">Sold Date</SortTh>
                  <SortTh field="status">Status</SortTh>
                  <th className="py-3 px-3 text-xs font-semibold text-fg-muted uppercase tracking-wide text-left">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((item, idx) => {
                  const isSold    = item.status === 'sold' && !!item.sale;
                  const metrics   = isSold ? calcItemProfit(item, item._lot) : null;
                  const costBasis = getItemCostBasis(item, item._lot);
                  const isSelected = selectedIds.has(item.id);
                  const mono = { fontFamily: "'JetBrains Mono', monospace" };
                  const rowBg = isSelected ? 'bg-primary/5' : idx % 2 === 1 ? 'bg-muted/40' : 'bg-surface';

                  return (
                    <tr
                      key={item.id}
                      className={`border-b border-border-subtle ${rowBg} ${
                        !isSold && !isSelected ? 'opacity-70' : ''
                      } hover:bg-info-subtle/20 transition-colors`}
                    >
                      {/* Checkbox */}
                      <td className="py-2.5 px-3 w-8">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleItem(item.id)}
                          className="accent-primary w-3.5 h-3.5 cursor-pointer"
                        />
                      </td>
                      {/* Item name */}
                      <td className="py-2.5 px-3 min-w-[160px]">
                        <div className="font-semibold text-fg text-xs leading-tight">
                          {item.brand} {item.model}
                        </div>
                        {item.notes && (
                          <div className="text-xs text-fg-muted mt-0.5 line-clamp-1 max-w-[200px]">
                            {item.notes}
                          </div>
                        )}
                        {item.serialNumber && (
                          <div className="text-[10px] text-fg-muted/70 mt-0.5" style={mono}>
                            {item.serialNumber}
                          </div>
                        )}
                      </td>

                      {/* Category */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <Badge className="bg-muted text-fg-muted border-border">
                          {CAT_LABELS[item.category] || item.category}
                        </Badge>
                      </td>

                      {/* Condition */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <Badge className={COND_CLS[item.conditionOnArrival] || 'bg-muted text-fg-muted border-border'}>
                            {item.ebayConditionName || COND_LABELS[item.conditionOnArrival] || item.conditionOnArrival || 'N/A'}
                          </Badge>
                          {item.conditionGrade && (
                            <span className="text-[10px] text-fg-muted" style={mono}>
                              Grade {item.conditionGrade}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Cost basis */}
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        <span className="text-xs text-fg-muted" style={mono}>
                          {formatCurrency(costBasis)}
                        </span>
                      </td>

                      {/* Sale price / Listing price */}
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        {isSold
                          ? <span className="text-xs font-medium text-fg" style={mono}>{formatCurrency(item.sale.salePrice)}</span>
                          : item.listingPrice > 0
                            ? <div className="flex flex-col items-end gap-0.5">
                                <span className="text-xs font-medium text-secondary" style={mono}>{formatCurrency(item.listingPrice)}</span>
                                <span className="text-[10px] text-fg-muted">listed</span>
                              </div>
                            : <span className="text-xs text-fg-subtle">—</span>
                        }
                      </td>

                      {/* Profit */}
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        {metrics
                          ? <span className="text-xs font-semibold" style={{ ...mono, color: metrics.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                              {formatCurrency(metrics.profit)}
                            </span>
                          : <span className="text-xs text-fg-subtle">—</span>
                        }
                      </td>

                      {/* ROI */}
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        {metrics
                          ? <span className="text-xs font-medium" style={{ ...mono, color: metrics.roi >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                              {formatPct(metrics.roi)}
                            </span>
                          : <span className="text-xs text-fg-subtle">—</span>
                        }
                      </td>

                      {/* Platform */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {isSold
                          ? <span className="text-xs text-fg">{PLT_LABELS[item.sale.platform] || item.sale.platform}</span>
                          : <span className="text-xs text-fg-subtle">—</span>
                        }
                      </td>

                      {/* Sold date */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {isSold
                          ? <span className="text-xs text-fg">{formatDate(item.sale.soldAt)}</span>
                          : <span className="text-xs text-fg-subtle">—</span>
                        }
                      </td>

                      {/* Status */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <Badge className={STATUS_CLS[item.status] || STATUS_CLS.received}>
                          {STAT_LABELS[item.status] || item.status}
                        </Badge>
                      </td>

                      {/* Actions */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          {!isSold && item.status !== 'recycled' && item.status !== 'parted_out' && (
                            <button
                              onClick={() => markSold(item)}
                              className="px-2 py-1 text-xs border border-success/30 text-success rounded hover:bg-success/5 transition-colors font-medium"
                            >
                              Sell
                            </button>
                          )}
                          <button
                            onClick={() => setCompsItem(item)}
                            className="px-2 py-1 text-xs border border-border text-fg-muted rounded hover:bg-muted/40 transition-colors inline-flex items-center gap-1"
                            title="Look up recent eBay sold prices"
                          >
                            <BarChart3 className="w-3 h-3" />
                            Comps
                          </button>
                          <button
                            onClick={() => startEdit(item)}
                            className="px-2 py-1 text-xs border border-border text-fg-muted rounded hover:bg-muted/40 transition-colors"
                          >
                            Edit
                          </button>
                          {deleteConfirmId === item.id ? (
                            <span className="flex items-center gap-1">
                              <button
                                onClick={() => confirmDeleteItem(item.id)}
                                className="px-2 py-1 text-xs bg-danger text-white rounded hover:bg-danger/90 transition-colors"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="px-2 py-1 text-xs border border-border text-fg-muted rounded hover:bg-muted/40 transition-colors"
                              >
                                No
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirmId(item.id)}
                              className="px-2 py-1 text-xs border border-danger/30 text-danger rounded hover:bg-danger/5 transition-colors"
                            >
                              Del
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sold-comps lookup modal — auto-fetches "{brand} {model}" for the row. */}
      <Modal
        open={!!compsItem}
        onClose={() => setCompsItem(null)}
        size="2xl"
        title="Recent eBay Sold Comps"
        subtitle={
          compsItem
            ? [compsItem.brand, compsItem.model].filter(Boolean).join(' ') || 'No brand/model on this item'
            : ''
        }
      >
        {compsItem && (
          <Suspense fallback={<div className="h-32 bg-muted rounded-xl animate-pulse" />}>
            <SoldCompsPanel
              initialQuery={[compsItem.brand, compsItem.model].filter(Boolean).join(' ')}
              autoFetch
              compact
            />
          </Suspense>
        )}
      </Modal>
    </div>
  );
}

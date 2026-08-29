import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  RefreshCw, CheckCircle2, AlertTriangle, Link, Unlink,
  ShoppingCart, ExternalLink, ChevronDown, Calendar, Filter, Printer,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import eventBus from '../../services/eventBus';
import { EBAY_TOKEN_KEY, PIPELINE_BASE } from '../../utils/constants';
import { decryptObject } from '../../services/crypto';
import { printShippingSlip } from '../../utils/shippingSlip';
import { fmt, formatDate } from '../../utils/formatters';

// ─── Constants ───────────────────────────────────────────────────────────────
const SYNCED_ORDERS_KEY = 'noltech:ebay:synced-orders';

function defaultStartDate() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultEndDate() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Matching helpers ────────────────────────────────────────────────────────

function findMatches(order, allItems) {
  const matches = [];

  // 1. SKU exact match against item.sku or item.serialNumber
  if (order.sku) {
    const skuUpper = order.sku.toUpperCase().trim();
    for (const item of allItems) {
      const itemSku = (item.sku || '').toUpperCase().trim();
      const itemSerial = (item.serialNumber || '').toUpperCase().trim();
      if (itemSku && itemSku === skuUpper) {
        matches.push({ item, reason: 'sku' });
      } else if (itemSerial && itemSerial === skuUpper) {
        matches.push({ item, reason: 'serial' });
      }
    }
  }

  // 2. UPC match
  if (order.sku && matches.length === 0) {
    const skuUpper = order.sku.toUpperCase().trim();
    for (const item of allItems) {
      const upc = (item.upc || '').toUpperCase().trim();
      if (upc && upc === skuUpper) {
        matches.push({ item, reason: 'upc' });
      }
    }
  }

  // 3. Title fuzzy match (substring on model) — only if no SKU/UPC match
  if (matches.length === 0 && order.title) {
    const titleLower = order.title.toLowerCase();
    for (const item of allItems) {
      const model = (item.model || '').toLowerCase().trim();
      if (model && model.length > 4 && titleLower.includes(model)) {
        matches.push({ item, reason: 'title' });
      }
    }
  }

  return matches;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function EbayOrderSync() {
  const { state, dispatch } = useApp();

  // State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orders, setOrders] = useState([]);
  const [syncedIds, setSyncedIds] = useState(new Set());
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);

  // Manual match overrides: { orderId: itemId }
  const [manualMatches, setManualMatches] = useState({});

  // Load previously synced order IDs
  useEffect(() => {
    window.storage.get(SYNCED_ORDERS_KEY)
      .then((ids) => { if (Array.isArray(ids)) setSyncedIds(new Set(ids)); })
      .catch(e => console.error('[EbayOrderSync] synced IDs load failed:', e));
  }, []);

  // Flatten all inventory items
  const allItems = useMemo(() => {
    return state.lots.flatMap((l) => (l.items || []).map((i) => ({ ...i, _lotId: l.id })));
  }, [state.lots]);

  // Available (unsold) items for manual match dropdown
  const availableItems = useMemo(() => {
    return allItems.filter((i) => i.status !== 'sold' && i.status !== 'recycled');
  }, [allItems]);

  // Compute matches for each order
  const orderRows = useMemo(() => {
    return orders.map((order) => {
      const alreadySynced = syncedIds.has(order.orderId);
      const matches = findMatches(order, allItems);
      const manualItemId = manualMatches[order.orderId];

      let matchStatus = 'unmatched';
      let matchedItem = null;

      if (alreadySynced) {
        matchStatus = 'synced';
      } else if (manualItemId) {
        matchStatus = 'manual';
        matchedItem = allItems.find((i) => i.id === manualItemId) || null;
      } else if (matches.length === 1) {
        matchStatus = 'matched';
        matchedItem = matches[0].item;
      } else if (matches.length > 1) {
        matchStatus = 'multi';
      }

      return { order, matches, matchStatus, matchedItem, alreadySynced };
    });
  }, [orders, allItems, syncedIds, manualMatches]);

  // Summary stats
  const stats = useMemo(() => {
    let fetched = orderRows.length;
    let autoMatched = 0, manual = 0, unmatched = 0, multi = 0, alreadySynced = 0;
    for (const r of orderRows) {
      if (r.matchStatus === 'synced')    alreadySynced++;
      else if (r.matchStatus === 'matched') autoMatched++;
      else if (r.matchStatus === 'manual')  manual++;
      else if (r.matchStatus === 'multi')   multi++;
      else                                   unmatched++;
    }
    return { fetched, autoMatched, manual, unmatched, multi, alreadySynced };
  }, [orderRows]);

  // ── Fetch orders ───────────────────────────────────────────────────────────

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    setApplyResult(null);
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(rawCreds || {});
      if (!creds?.token) {
        setError('No eBay token found. Add credentials in Settings.');
        return;
      }

      const res = await fetch(`${PIPELINE_BASE}/api/ebay/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userToken: creds.token,
          appId: creds.appId || '',
          devId: creds.devId || '',
          certId: creds.certId || '',
          startDate,
          endDate,
        }),
        signal: AbortSignal.timeout(60000),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to fetch orders');
      setOrders(data.orders || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  // ── Apply matches ──────────────────────────────────────────────────────────

  const applyMatches = useCallback(async () => {
    setApplying(true);
    setApplyResult(null);
    let applied = 0;
    let errors = 0;
    const newSyncedIds = new Set(syncedIds);

    try {
      for (const row of orderRows) {
        if (row.alreadySynced) continue;
        if (row.matchStatus !== 'matched' && row.matchStatus !== 'manual') continue;
        if (!row.matchedItem) continue;

        try {
          const costBasis = row.matchedItem.costBasis || 0;
          dispatch({
            type: 'UPDATE_ITEM',
            id: row.matchedItem.id,
            updates: {
              status: 'sold',
              sale: {
                id: row.order.orderId,
                platform: 'ebay',
                salePrice: row.order.price,
                platformFees: row.order.ebayFees,
                shippingCost: row.order.buyerShipping || 0,
                labelCost: row.order.labelCost || 0,
                netRevenue: row.order.netPayout,
                profit: Math.round((row.order.netPayout - costBasis) * 100) / 100,
                soldAt: row.order.date,
                buyerName: row.order.buyer || '',
              },
            },
          });
          newSyncedIds.add(row.order.orderId);
          applied++;
        } catch {
          errors++;
        }
      }

      // Persist synced IDs
      await window.storage.set(SYNCED_ORDERS_KEY, [...newSyncedIds]).catch(e => console.error('[EbayOrderSync] synced IDs save failed:', e));
      setSyncedIds(newSyncedIds);
      setApplyResult({ applied, errors });
    } catch (err) {
      setApplyResult({ applied, errors: errors + 1, message: err.message });
    } finally {
      setApplying(false);
    }
  }, [orderRows, syncedIds, dispatch]);

  // ── Manual match handler ───────────────────────────────────────────────────

  const setManualMatch = (orderId, itemId) => {
    setManualMatches((prev) => {
      if (!itemId) {
        const next = { ...prev };
        delete next[orderId];
        return next;
      }
      return { ...prev, [orderId]: itemId };
    });
  };

  // ── Match status badge ─────────────────────────────────────────────────────

  const MatchBadge = ({ status }) => {
    const config = {
      matched:   { bg: 'bg-success-subtle', text: 'text-success', label: 'Matched', Icon: CheckCircle2 },
      manual:    { bg: 'bg-success-subtle', text: 'text-success', label: 'Manual Match', Icon: Link },
      multi:     { bg: 'bg-warning-subtle',   text: 'text-warning',   label: 'Multi-match', Icon: AlertTriangle },
      unmatched: { bg: 'bg-danger-subtle',     text: 'text-danger',     label: 'Unmatched', Icon: Unlink },
      synced:    { bg: 'bg-muted',   text: 'text-fg-muted',   label: 'Already Synced', Icon: CheckCircle2 },
    };
    const c = config[status] || config.unmatched;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
        <c.Icon size={12} />
        {c.label}
      </span>
    );
  };

  // ── Count of actionable matches ────────────────────────────────────────────
  const actionableCount = orderRows.filter(
    (r) => (r.matchStatus === 'matched' || r.matchStatus === 'manual') && !r.alreadySynced
  ).length;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="bg-surface rounded-xl border border-border shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-fg flex items-center gap-2">
              <ShoppingCart size={20} className="text-accent" />
              eBay Order Sync
            </h2>
            <p className="text-sm text-fg-muted mt-1">
              Fetch sold orders from eBay and auto-match them to inventory items by SKU.
            </p>
          </div>
          <button
            onClick={fetchOrders}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                       bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Syncing...' : 'Sync eBay Orders'}
          </button>
        </div>

        {/* Date range */}
        <div className="flex flex-wrap items-end gap-4 mt-4">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-danger-subtle border border-danger/30 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-danger mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-danger">Sync Error</p>
            <p className="text-sm text-danger mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Apply result */}
      {applyResult && (
        <div className={`rounded-xl border p-4 flex items-start gap-3 ${
          applyResult.errors ? 'bg-warning-subtle border-warning/30' : 'bg-success-subtle border-success/30'
        }`}>
          <CheckCircle2 size={18} className={applyResult.errors ? 'text-warning mt-0.5' : 'text-success mt-0.5'} />
          <p className="text-sm">
            Applied <span className="font-semibold">{applyResult.applied}</span> match{applyResult.applied !== 1 ? 'es' : ''} to inventory.
            {applyResult.errors > 0 && (
              <span className="text-warning ml-1">{applyResult.errors} error{applyResult.errors !== 1 ? 's' : ''}.</span>
            )}
          </p>
        </div>
      )}

      {/* Summary stats */}
      {orders.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Fetched',        value: stats.fetched,        color: 'text-fg' },
            { label: 'Auto-Matched',   value: stats.autoMatched,    color: 'text-success' },
            { label: 'Manual Match',   value: stats.manual,         color: 'text-success' },
            { label: 'Multi-Match',    value: stats.multi,          color: 'text-warning' },
            { label: 'Unmatched',      value: stats.unmatched,      color: 'text-danger' },
            { label: 'Already Synced', value: stats.alreadySynced,  color: 'text-fg-subtle' },
          ].map((s) => (
            <div key={s.label} className="bg-surface rounded-xl border border-border shadow-sm p-4 text-center">
              <p className={`text-2xl font-bold font-mono ${s.color}`}>{s.value}</p>
              <p className="text-xs text-fg-muted mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Orders table */}
      {orders.length > 0 && (
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
            <h3 className="text-sm font-semibold text-fg">
              Orders ({orders.length})
            </h3>
            <button
              onClick={applyMatches}
              disabled={applying || actionableCount === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                         bg-success text-white hover:bg-success/90 disabled:opacity-50 transition-colors"
            >
              <CheckCircle2 size={16} />
              {applying ? 'Applying...' : `Apply ${actionableCount} Match${actionableCount !== 1 ? 'es' : ''}`}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Fees</th>
                  <th className="px-4 py-3 text-right">Net</th>
                  <th className="px-4 py-3">Buyer</th>
                  <th className="px-4 py-3">Match</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {orderRows.map((row, idx) => (
                  <tr
                    key={row.order.orderId || idx}
                    className={`${idx % 2 === 0 ? 'bg-surface' : 'bg-muted/40'} hover:bg-info-subtle/40 transition-colors`}
                  >
                    <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                      {formatDate(row.order.date)}
                    </td>
                    <td className="px-4 py-3 text-fg max-w-[260px] truncate" title={row.order.title}>
                      {row.order.title}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-muted whitespace-nowrap">
                      {row.order.sku || '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-fg whitespace-nowrap">
                      {fmt(row.order.price)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-danger whitespace-nowrap">
                      -{fmt(row.order.ebayFees)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-success whitespace-nowrap">
                      {fmt(row.order.netPayout)}
                    </td>
                    <td className="px-4 py-3 text-fg-muted whitespace-nowrap max-w-[120px] truncate" title={row.order.buyer}>
                      {row.order.buyer || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <MatchBadge status={row.matchStatus} />
                      {row.matchedItem && (
                        <p className="text-[10px] text-fg-subtle mt-0.5 truncate max-w-[140px]" title={row.matchedItem.model}>
                          {row.matchedItem.model}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {/* Manual match dropdown for unmatched / multi-match */}
                      {(row.matchStatus === 'unmatched' || row.matchStatus === 'multi') && (
                        <select
                          value={manualMatches[row.order.orderId] || ''}
                          onChange={(e) => setManualMatch(row.order.orderId, e.target.value)}
                          className="text-xs px-2 py-1 rounded border border-border-strong bg-surface
                                     focus:outline-none focus:ring-1 focus:ring-accent max-w-[180px]"
                        >
                          <option value="">Assign item...</option>
                          {row.matchStatus === 'multi' && row.matches.map((m) => (
                            <option key={m.item.id} value={m.item.id}>
                              [{m.reason}] {m.item.serialNumber || m.item.sku || '?'} — {(m.item.model || '').slice(0, 40)}
                            </option>
                          ))}
                          {availableItems.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.serialNumber || item.sku || item.id.slice(0, 8)} — {(item.model || '').slice(0, 40)}
                            </option>
                          ))}
                        </select>
                      )}
                      {row.matchStatus === 'synced' && (
                        <span className="text-xs text-fg-subtle">Synced</span>
                      )}
                      {(row.matchStatus === 'matched' || row.matchStatus === 'manual') && (
                        <span className="text-xs text-success">Ready</span>
                      )}
                      <button
                        onClick={() => printShippingSlip(row.order)}
                        className="mt-1 flex items-center gap-1 text-[11px] text-fg-muted hover:text-primary transition-colors"
                        title="Print packing slip"
                      >
                        <Printer size={11} /> Slip
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && orders.length === 0 && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-12 text-center">
          <ShoppingCart size={40} className="mx-auto text-fg-subtle mb-4" />
          <h3 className="text-base font-semibold text-fg-muted">No Orders Loaded</h3>
          <p className="text-sm text-fg-subtle mt-1 max-w-md mx-auto">
            Click "Sync eBay Orders" to fetch your sold orders from eBay. Orders will be
            auto-matched to inventory items by SKU, serial number, or title.
          </p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && orders.length === 0 && (
        <div className="bg-surface rounded-xl border border-border shadow-sm p-6 space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="animate-pulse flex gap-4">
              <div className="h-4 bg-muted rounded w-20" />
              <div className="h-4 bg-muted rounded flex-1" />
              <div className="h-4 bg-muted rounded w-16" />
              <div className="h-4 bg-muted rounded w-16" />
              <div className="h-4 bg-muted rounded w-16" />
              <div className="h-4 bg-muted rounded w-20" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

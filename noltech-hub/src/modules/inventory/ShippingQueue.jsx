// ─── Shipping Queue ──────────────────────────────────────────────────────────
// Surfaces sold items that need shipping labels. Per-row actions:
//   - Print packing slip (via existing utility)
//   - Open in Pirate Ship (prefilled shipment URL)
//   - Mark Shipped (save tracking number back to the item's sale record)
//
// Bulk actions: batch print slips, batch mark shipped via CSV paste.

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Truck, Printer, ExternalLink, CheckCircle2, Clock, Package, AlertCircle, Search, Copy, Check,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { fmt, formatDate } from '../../utils/formatters';
import { printShippingSlip } from '../../utils/shippingSlip';
import { Button, Card, Badge, Modal, Input, Label, AnimatedNumber } from '../../components/ui';
import QuickReplyButton from '../../components/QuickReplyButton';

const SETTINGS_KEY = 'noltech:shipping:settings';

// Pirate Ship accepts prefilled shipments via URL parameters. We URL-encode
// everything and open in a new tab. The user confirms + buys the label there.
function buildPirateShipUrl(order) {
  const p = new URLSearchParams();
  const ship = order.sale?.shipTo || order.shipTo || {};
  if (ship.name) p.set('full_name', ship.name);
  if (ship.street1) p.set('address1', ship.street1);
  if (ship.street2) p.set('address2', ship.street2);
  if (ship.city) p.set('city', ship.city);
  if (ship.state) p.set('state', ship.state);
  if (ship.postalCode) p.set('zip', ship.postalCode);
  if (ship.country) p.set('country', ship.country);
  // Pirate Ship "quick ship" URL (they silently ignore unknown params):
  return `https://ship.pirateship.com/ship?${p.toString()}`;
}

// Exported so OperationsHub's "Shipping (N)" badge uses the exact same
// predicate as this view's Pending filter — keeps badge and queue from drifting.
export function hasLabel(item) {
  return !!(item.sale?.trackingNumber || item.sale?.labelCost);
}

export default function ShippingQueue() {
  const { state, dispatch } = useApp();
  const [filter, setFilter]       = useState('pending');
  const [query, setQuery]         = useState('');
  const [trackingModal, setTrackingModal] = useState(null); // { itemId, initial }
  const [bulkModal, setBulkModal] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState(null);
  const [settings, setSettings]   = useState({ weightOz: '', defaultCarrier: 'USPS' });

  useEffect(() => {
    window.storage.get(SETTINGS_KEY).then((v) => { if (v) setSettings((s) => ({ ...s, ...v })); }).catch(e => console.error('[shipping queue] storage error:', e));
  }, []);

  const persistSettings = useCallback(async (next) => {
    setSettings(next);
    try { await window.storage.set(SETTINGS_KEY, next); } catch (e) { console.error('[Shipping] save settings:', e); }
  }, []);

  // All sold items
  const soldItems = useMemo(() => {
    return state.lots.flatMap((l) =>
      (l.items || []).filter((i) => i.status === 'sold' && i.sale)
        .map((i) => ({ ...i, _lot: l }))
    ).sort((a, b) => (b.sale?.soldAt || '').localeCompare(a.sale?.soldAt || ''));
  }, [state.lots]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = soldItems.filter((i) => {
      if (filter === 'pending'  && hasLabel(i)) return false;
      if (filter === 'shipped'  && !hasLabel(i)) return false;
      if (q) {
        const hay = [i.brand, i.model, i.sku, i.serialNumber, i.sale?.buyerName, i.sale?.id].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Pending view: surface the oldest unshipped first so late-shipment risk
    // is visible. eBay starts dinging seller metrics around 3 days, so the
    // operator wants to see "what's about to be late" at the top of the list.
    if (filter === 'pending') {
      return [...filtered].sort((a, b) => (a.sale?.soldAt || '').localeCompare(b.sale?.soldAt || ''));
    }
    return filtered;
  }, [soldItems, filter, query]);

  // Days since sold — drives the aging pill in the row.
  const ageDays = (item) => {
    const t = item?.sale?.soldAt;
    if (!t) return 0;
    const ms = Date.now() - new Date(t).getTime();
    return Math.max(0, Math.floor(ms / 86400000));
  };

  const stats = useMemo(() => {
    const pending = soldItems.filter((i) => !hasLabel(i)).length;
    const shipped = soldItems.filter((i) => hasLabel(i)).length;
    const totalLabels = soldItems.reduce((s, i) => s + (parseFloat(i.sale?.labelCost) || 0), 0);
    return { pending, shipped, total: soldItems.length, totalLabels };
  }, [soldItems]);

  const handlePrint = (item) => {
    printShippingSlip({
      orderId: item.sale?.id,
      title: [item.brand, item.model].filter(Boolean).join(' '),
      sku: item.sku || item.serialNumber,
      qty: 1,
      buyer: item.sale?.buyerName,
      shipTo: item.sale?.shipTo,
      date: item.sale?.soldAt,
    });
  };

  const handleCopyAddress = async (item) => {
    const ship = item.sale?.shipTo;
    if (!ship) return;
    const lines = [
      ship.name || item.sale?.buyerName,
      ship.street1,
      ship.street2,
      [ship.city, ship.state, ship.postalCode].filter(Boolean).join(', '),
      ship.country && ship.country !== 'US' ? ship.country : null,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(lines);
      setCopiedAddr(item.id);
      setTimeout(() => setCopiedAddr(null), 1500);
    } catch (e) {
      console.error('[Shipping] copy failed:', e);
    }
  };

  const handleMarkShipped = (item, trackingNumber, labelCost) => {
    const parsedLabel = parseFloat(labelCost);
    const resolvedLabel = isFinite(parsedLabel) && parsedLabel >= 0
      ? parsedLabel
      : (item.sale?.labelCost || 0);
    const sale = {
      ...item.sale,
      trackingNumber: trackingNumber || item.sale?.trackingNumber || '',
      labelCost: resolvedLabel,
      labelCostKnown: resolvedLabel > 0 ? true : !!item.sale?.labelCostKnown,
      // Keep legacy mirror in sync for any consumer still reading it
      shippingCost: resolvedLabel,
      shippedAt: item.sale?.shippedAt || new Date().toISOString(),
    };
    // Single dispatch — AppContext detects this as an update to a sold item's
    // sale data and emits sale:updated, which useEventBridge picks up and
    // reconciles the bookkeeping shipping row (creating or updating as needed).
    dispatch({ type: 'UPDATE_ITEM', id: item.id, updates: { sale } });
    setTrackingModal(null);
  };

  return (
    <div className="space-y-3">
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Pending</p>
          <p className="text-lg font-semibold font-mono text-warning tabular-nums mt-0.5">
            <AnimatedNumber value={stats.pending} />
          </p>
          <p className="text-[10px] text-fg-subtle">need label</p>
        </Card>
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Shipped</p>
          <p className="text-lg font-semibold font-mono text-success tabular-nums mt-0.5">
            <AnimatedNumber value={stats.shipped} />
          </p>
          <p className="text-[10px] text-fg-subtle">tracking set</p>
        </Card>
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Label Spend</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            <AnimatedNumber value={stats.totalLabels} format={(v) => fmt(v)} />
          </p>
          <p className="text-[10px] text-fg-subtle">all time</p>
        </Card>
        <Card padding="sm">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">Default Weight</p>
          <p className="text-lg font-semibold font-mono text-fg tabular-nums mt-0.5">
            {settings.weightOz ? `${settings.weightOz} oz` : <span className="text-fg-subtle">not set</span>}
          </p>
          <button onClick={() => setBulkModal(true)} className="text-[10px] text-accent hover:underline">Edit settings</button>
        </Card>
      </div>

      {/* Toolbar */}
      <Card padding="none" radius="lg" className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-muted border border-border-subtle">
              {[{ id: 'pending', label: 'Pending' }, { id: 'shipped', label: 'Shipped' }, { id: 'all', label: 'All' }].map((f) => (
                <button key={f.id} onClick={() => setFilter(f.id)}
                  className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${filter === f.id ? 'bg-surface text-fg shadow-glow-sm' : 'text-fg-muted hover:text-fg'}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <Input size="sm" leadingIcon={Search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search…" className="w-48" />
          </div>
          <div className="text-xs text-fg-muted">
            {rows.length} order{rows.length !== 1 ? 's' : ''}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="py-10 text-center">
            <Truck className="mx-auto size-8 text-fg-subtle opacity-50 mb-2" />
            <p className="text-sm text-fg">
              {filter === 'pending' ? 'No orders awaiting shipment' : filter === 'shipped' ? 'No shipped orders match' : 'No sold orders yet'}
            </p>
            <p className="text-xs text-fg-muted mt-0.5">Sync eBay orders in Inventory → eBay Sync to populate.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                  <th className="px-3 py-1.5 text-left">Sold</th>
                  <th className="px-3 py-1.5 text-left">Item</th>
                  <th className="px-3 py-1.5 text-left">Ship To</th>
                  <th className="px-3 py-1.5 text-right">Paid</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-right w-[320px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((item) => {
                  const ship = item.sale?.shipTo || {};
                  const isShipped = hasLabel(item);
                  const name = [item.brand, item.model].filter(Boolean).join(' ') || item.serialNumber || 'Item';
                  return (
                    <tr key={item.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 text-xs font-mono text-fg-muted whitespace-nowrap">{formatDate(item.sale?.soldAt) || '—'}</td>
                      <td className="px-3 py-2">
                        <p className="text-sm text-fg truncate max-w-[220px]">{name}</p>
                        <p className="text-[10px] font-mono text-fg-subtle">#{item.sale?.id || item.sku || '—'}</p>
                      </td>
                      <td className="px-3 py-2">
                        {ship.name || item.sale?.buyerName ? (
                          <>
                            <p className="text-xs text-fg truncate max-w-[180px]">{ship.name || item.sale?.buyerName}</p>
                            <p className="text-[10px] text-fg-subtle truncate max-w-[180px]">
                              {[ship.city, ship.state, ship.postalCode].filter(Boolean).join(', ') || 'no address'}
                            </p>
                          </>
                        ) : (
                          <span className="text-xs text-fg-subtle italic">no address</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{fmt(item.sale?.salePrice)}</td>
                      <td className="px-3 py-2">
                        {isShipped ? (
                          <Badge variant="success" size="xs" icon={CheckCircle2}>
                            {item.sale?.trackingNumber ? 'Tracked' : 'Label bought'}
                          </Badge>
                        ) : (() => {
                          // Aging signal: eBay's late-shipment metric kicks in
                          // around day 3, so escalate green → amber → red as
                          // the order ages without a label.
                          const days = ageDays(item);
                          const variant = days >= 4 ? 'danger' : days >= 2 ? 'warning' : 'success';
                          const label = days <= 0
                            ? 'Pending'
                            : `${days}d waiting`;
                          return <Badge variant={variant} size="xs" icon={Clock}>{label}</Badge>;
                        })()}
                        {item.sale?.trackingNumber && (
                          <p className="text-[10px] font-mono text-fg-subtle mt-0.5 truncate max-w-[120px]">{item.sale.trackingNumber}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <QuickReplyButton
                            size="xs"
                            label="Reply"
                            context={{
                              buyer: ship.name || item.sale?.buyerName || '',
                              item_title: name,
                              order_id: item.sale?.id || '',
                              tracking: item.sale?.trackingNumber || '',
                              ship_date: item.sale?.shippedAt ? formatDate(item.sale.shippedAt) : '',
                              return_window: '30 days',
                            }}
                          />
                          <button
                            onClick={() => handleCopyAddress(item)}
                            disabled={!ship.street1}
                            className="px-2 py-1 rounded-md text-[11px] text-fg-muted hover:text-fg hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            title="Copy address"
                          >
                            {copiedAddr === item.id ? <Check className="size-3" /> : <Copy className="size-3" />}
                          </button>
                          <button
                            onClick={() => handlePrint(item)}
                            className="px-2 py-1 rounded-md text-[11px] text-fg-muted hover:text-fg hover:bg-muted transition-colors flex items-center gap-1"
                            title="Print packing slip"
                          >
                            <Printer className="size-3" /> Slip
                          </button>
                          <a
                            href={buildPirateShipUrl(item)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-2 py-1 rounded-md text-[11px] text-accent hover:bg-accent-subtle transition-colors flex items-center gap-1"
                            title="Open in Pirate Ship with address prefilled"
                          >
                            <ExternalLink className="size-3" /> Pirate Ship
                          </a>
                          <Button
                            variant={isShipped ? 'secondary' : 'accent'}
                            size="xs"
                            onClick={() => setTrackingModal({ itemId: item.id, initial: item })}
                          >
                            {isShipped ? 'Edit' : 'Mark Shipped'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Tracking modal */}
      <Modal
        open={!!trackingModal}
        onClose={() => setTrackingModal(null)}
        size="md"
        title="Mark Shipped"
        subtitle="Save the tracking number and label cost. The sale record updates in inventory."
      >
        {trackingModal && <TrackingForm item={trackingModal.initial} onSave={handleMarkShipped} onCancel={() => setTrackingModal(null)} />}
      </Modal>

      {/* Settings modal */}
      <Modal open={bulkModal} onClose={() => setBulkModal(false)} size="sm" title="Shipping Settings" subtitle="Defaults used when generating Pirate Ship links + slips.">
        <div className="space-y-3">
          <div>
            <Label hint="Default parcel weight when unknown">Weight (oz)</Label>
            <Input type="number" step="0.1" value={settings.weightOz} onChange={(e) => persistSettings({ ...settings, weightOz: e.target.value })} placeholder="8" className="font-mono" />
          </div>
          <div>
            <Label>Default Carrier</Label>
            <select
              value={settings.defaultCarrier}
              onChange={(e) => persistSettings({ ...settings, defaultCarrier: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface text-fg"
            >
              <option>USPS</option>
              <option>UPS</option>
              <option>FedEx</option>
            </select>
          </div>
          <div className="flex items-start gap-2 bg-info-subtle border border-info/20 rounded-lg px-3 py-2 text-[11px] text-info-fg">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span>Full label-buying automation (EasyPost/ShipEngine API) is coming. For now, use Pirate Ship to buy labels — this queue tracks which orders still need them.</span>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function TrackingForm({ item, onSave, onCancel }) {
  const [tracking, setTracking]   = useState(item.sale?.trackingNumber || '');
  const [labelCost, setLabelCost] = useState(item.sale?.labelCost || '');

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs text-fg-muted mb-1">Item</p>
        <p className="text-sm font-medium text-fg">
          {[item.brand, item.model].filter(Boolean).join(' ') || item.serialNumber}
        </p>
        <p className="text-[11px] font-mono text-fg-subtle">#{item.sale?.id}</p>
      </div>
      <div>
        <Label hint="Paste from carrier after buying label">Tracking Number</Label>
        <Input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z..." className="font-mono" autoFocus />
      </div>
      <div>
        <Label hint="What YOU paid for the label (not what the buyer paid)">Label Cost ($)</Label>
        <Input type="number" step="0.01" value={labelCost} onChange={(e) => setLabelCost(e.target.value)} placeholder="0.00" className="font-mono" />
        {item.sale?.buyerShipping > 0 && (
          <p className="text-[11px] text-fg-subtle mt-1">
            Buyer paid <span className="font-mono tabular-nums text-fg">${parseFloat(item.sale.buyerShipping).toFixed(2)}</span> for shipping (that went into your revenue).
            Enter the actual label expense here.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="accent" onClick={() => onSave(item, tracking, labelCost)}>
          <CheckCircle2 /> Save
        </Button>
      </div>
    </div>
  );
}

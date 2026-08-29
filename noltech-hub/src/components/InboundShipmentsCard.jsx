// ─── Inbound Shipments Tracker ───────────────────────────────────────────────
// Surfaces won lots that are still in transit — i.e. you bid + won, but
// haven't physically received them yet (or haven't imported them to inventory).
//
// Two cases handled:
//   1. Won bids that haven't been imported as a lot. Estimated delivery is
//      14 days after bidDate (heuristic — most TL/Liq lots ship in 5-14 days).
//   2. Imported lots whose status is still 'received' (not started processing).
//      These represent lots that arrived but haven't been opened yet.

import { useEffect, useMemo, useState } from 'react';
import { Truck, Package, ArrowRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { fmt, formatDate } from '../utils/formatters';
import eventBus from '../services/eventBus';

const BIDS_KEY = 'noltech:arbitrage:bids';
const TRANSIT_DAYS_DEFAULT = 14;

function daysAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

export default function InboundShipmentsCard({ setView }) {
  const { state } = useApp();
  const [bids, setBids] = useState([]);

  useEffect(() => {
    const load = () => window.storage.get(BIDS_KEY)
      .then((v) => setBids(Array.isArray(v) ? v : []))
      .catch(() => setBids([]));
    load();
    // Event-driven: bids change via BidTracker (bid:status-changed) or cloud
    // sync (sync:array-updated on the bids key). Beats a forever 8s poll.
    const offStatus = eventBus.on('bid:status-changed', load);
    const offSync = eventBus.on('sync:array-updated', (e) => {
      if (e?.storageKey === BIDS_KEY) load();
    });
    return () => { offStatus(); offSync(); };
  }, []);

  const inbound = useMemo(() => {
    // Map of "imported won bids" to skip duplicates. Bids and inventory lots
    // aren't strongly linked, so we match heuristically by bid id appearing in
    // a lot's notes (the WonLotImporter writes "Imported from Arbitrage
    // Scanner — {bid.lotTitle}"). Fall back to lotTitle similarity.
    const importedBidIds = new Set();
    const importedTitles = new Set();
    for (const lot of (state.lots || [])) {
      if (lot.notes && /Imported from Arbitrage Scanner/i.test(lot.notes)) {
        const m = (lot.notes || '').match(/Arbitrage Scanner\s+[—-]\s+(.+)$/);
        if (m) importedTitles.add(m[1].trim().toLowerCase());
      }
    }

    // 1) Won bids not yet matched to an inventory lot — these are inbound
    const wonInTransit = [];
    for (const bid of bids) {
      if (bid.status !== 'won') continue;
      if (bid.inventoryLotId) continue; // already imported (if we ever set this)
      const t = (bid.lotTitle || '').toLowerCase();
      if (t && importedTitles.has(t)) continue;
      const days = daysAgo(bid.bidDate);
      const eta = bid.bidDate ? new Date(new Date(bid.bidDate).getTime() + TRANSIT_DAYS_DEFAULT * 86400000) : null;
      const overdue = days != null && days > TRANSIT_DAYS_DEFAULT + 3;
      wonInTransit.push({
        kind: 'won_bid',
        id: bid.id,
        title: bid.lotTitle || '(untitled lot)',
        source: bid.source || '',
        wonPrice: parseFloat(bid.wonPrice) || parseFloat(bid.bidAmount) || 0,
        days,
        eta,
        overdue,
      });
    }

    // 2) Lots in 'received' status that haven't been processed yet (no items
    //    have moved past 'received'). Often signals "package arrived but
    //    haven't unpacked / inventoried yet."
    const arrivedNotProcessed = [];
    for (const lot of (state.lots || [])) {
      if (lot.status && lot.status !== 'received') continue;
      const items = lot.items || [];
      // Skip auto-sync lots
      if (lot.id === 'noltech-ebay-active-listings') continue;
      if (lot.source === 'other' && /eBay Active Listings/i.test(lot.sourceName || '')) continue;
      const anyProcessed = items.some((i) => ['testing', 'repair', 'listing', 'listed', 'sold'].includes(i.status));
      if (anyProcessed) continue;
      const days = daysAgo(lot.purchaseDate);
      // Only flag if recent (last 60 days) — older lots are probably abandoned
      if (days != null && days > 60) continue;
      arrivedNotProcessed.push({
        kind: 'received_lot',
        id: lot.id,
        title: lot.sourceName || lot.source || 'Lot',
        notes: (lot.notes || '').slice(0, 80),
        cost: parseFloat(lot.cost) || 0,
        itemCount: items.length,
        days,
      });
    }

    return { wonInTransit, arrivedNotProcessed };
  }, [bids, state.lots]);

  const total = inbound.wonInTransit.length + inbound.arrivedNotProcessed.length;
  if (total === 0) return null;

  const totalWonValue = inbound.wonInTransit.reduce((s, x) => s + x.wonPrice, 0);
  const overdueCount  = inbound.wonInTransit.filter((x) => x.overdue).length;

  return (
    <div className={`rounded-xl border shadow-sm p-4 mb-3 ${overdueCount > 0 ? 'border-warning/40 bg-warning-subtle' : 'border-border bg-surface'}`}>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Truck size={16} className={overdueCount > 0 ? 'text-warning' : 'text-fg-muted'} />
          <p className="text-sm font-semibold text-fg">
            {inbound.wonInTransit.length > 0 && (
              <>{inbound.wonInTransit.length} lot{inbound.wonInTransit.length !== 1 ? 's' : ''} in transit
                <span className="text-fg-muted font-normal"> · {fmt(totalWonValue)} en route</span></>
            )}
            {inbound.wonInTransit.length === 0 && inbound.arrivedNotProcessed.length > 0 && (
              <>{inbound.arrivedNotProcessed.length} arrived lot{inbound.arrivedNotProcessed.length !== 1 ? 's' : ''} awaiting processing</>
            )}
          </p>
          {overdueCount > 0 && (
            <span className="text-[10px] font-semibold uppercase tracking-wide bg-warning/20 text-warning-fg px-1.5 py-0.5 rounded">
              {overdueCount} overdue
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setView?.('bidding')}
          className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
        >
          Open Bid & Buy <ArrowRight size={12} />
        </button>
      </div>

      <ul className="space-y-1.5">
        {inbound.wonInTransit.slice(0, 5).map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 text-xs px-2 py-1.5 rounded-md bg-muted/30 border border-border-subtle"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-fg truncate">{row.title}</p>
              <p className="text-[10px] text-fg-muted">
                <span className="font-mono">{fmt(row.wonPrice)}</span>
                {row.source && <span> · {row.source}</span>}
                {row.days != null && (
                  <span className={row.overdue ? ' text-warning font-semibold' : ' text-fg-subtle'}>
                    {' · '}{row.days}d ago{row.eta ? ` · ETA ${formatDate(row.eta.toISOString())}` : ''}
                  </span>
                )}
              </p>
            </div>
            <span className="text-[10px] uppercase tracking-wide text-fg-muted shrink-0">in transit</span>
          </li>
        ))}
        {inbound.arrivedNotProcessed.slice(0, 3).map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 text-xs px-2 py-1.5 rounded-md bg-muted/30 border border-border-subtle"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-fg truncate">
                <Package size={11} className="inline mr-1 text-fg-muted" />
                {row.title}{row.itemCount > 0 ? ` · ${row.itemCount} items` : ''}
              </p>
              {row.cost > 0 && (
                <p className="text-[10px] text-fg-muted">
                  Cost <span className="font-mono">{fmt(row.cost)}</span>
                  {row.days != null && <span> · arrived {row.days}d ago</span>}
                </p>
              )}
            </div>
            <span className="text-[10px] uppercase tracking-wide text-fg-muted shrink-0">received</span>
          </li>
        ))}
        {(inbound.wonInTransit.length + inbound.arrivedNotProcessed.length > 8) && (
          <li className="text-[11px] text-fg-subtle italic px-2">
            +{inbound.wonInTransit.length + inbound.arrivedNotProcessed.length - 8} more — open Bid & Buy or Inventory
          </li>
        )}
      </ul>
    </div>
  );
}

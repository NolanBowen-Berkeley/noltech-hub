// ─── Event Bridge ─────────────────────────────────────────────────────────────
// Central hook that listens to cross-module events and dispatches AppContext
// actions + storage writes. Used inside AppProvider to bridge all modules.

import { useEffect } from 'react';
import eventBus from '../services/eventBus';
import { localDateStr } from '../utils/formatters';
import { isMonthLocked } from '../utils/lockedMonths';
import { normalize as normalizePriceReason, appendHistoryRow } from '../utils/priceHistoryReasons';

// Per-key write lock to prevent race conditions on rapid successive events
const writeLocks = {};
async function serialWrite(key, updater) {
  const prev = writeLocks[key] || Promise.resolve();
  const next = prev.then(async () => {
    const data = await window.storage.get(key);
    const updated = updater(data);
    if (updated !== undefined) await window.storage.set(key, updated);
  });
  writeLocks[key] = next.catch(e => console.error('[EventBridge] serialWrite failed:', e));
  return next;
}

export default function useEventBridge(dispatch) {
  useEffect(() => {
    const unsubs = [];

    // ── test:completed → write testResults + conditionGrade + auto-set status ──
    unsubs.push(eventBus.on('test:completed', ({ itemId, results, grade }) => {
      if (!itemId) return;
      const updates = {
        testResults: results.map(r => ({
          id: r.id,
          testName: r.label,
          passed: r.status === 'pass',
          notes: r.notes || '',
          value: r.value || '',
          testedAt: new Date().toISOString(),
        })),
        conditionGrade: grade,
      };
      dispatch({ type: 'UPDATE_ITEM', id: itemId, updates });
    }));

    // ── sku:generated → write sku to item record ──
    unsubs.push(eventBus.on('sku:generated', ({ itemId, sku }) => {
      if (!itemId || !sku) return;
      dispatch({
        type: 'UPDATE_ITEM',
        id: itemId,
        updates: { sku },
      });
    }));

    // ── Build canonical 3-row bookkeeping family from a sale ──────────────
    // Returns { rows, importIds } where rows = [income, fees?, shipping?].
    // Always includes the income row; fees + shipping rows only when their
    // values are present. importIds covers all three slots so callers can
    // remove any prior versions before reinserting (used by sale:updated).
    const buildAutoRowsForSale = ({ itemId, sale, brand, model, sku }, existingIdByImportId = {}) => {
      const idFor = (importId) => existingIdByImportId[importId] || crypto.randomUUID();
      const itemName = `${brand || ''} ${model || ''}`.trim() || 'Item Sale';
      // Convert UTC soldAt to local-time YYYY-MM-DD so the bookkeeping date
      // matches what eBay's seller UI displays (eBay UI uses seller-local
      // time; soldAt arrives as a UTC ISO timestamp from the Trading API).
      const txDate = localDateStr(sale.soldAt) || localDateStr(new Date());
      const platform = sale.platform || 'ebay';
      const skuVal = (sku || sale.sku || '').toString().trim() || null;
      const gross = parseFloat(sale.salePrice) || 0;
      const buyerShipping = parseFloat(sale.buyerShipping) || 0;
      const fees  = parseFloat(sale.platformFees) || 0;
      const labelCost = parseFloat(sale.labelCost) || 0;
      const labelCostKnown = !!sale.labelCostKnown || labelCost > 0;
      // Distinguish a Finances API real cost from a GetOrders estimate. When
      // ActualShippingCost from Trading API equals buyer-paid shipping, that's
      // a strong signal eBay returned the buyer-side value as a placeholder
      // rather than the real label expense — flag it so the user knows.
      const labelCostFromFinances = sale.labelCostSource === 'finances';
      const labelLooksEstimated   = labelCostKnown && !labelCostFromFinances
        && Math.abs(labelCost - buyerShipping) < 0.01 && buyerShipping > 0;

      // Split ad-fee buckets out of the platform fee row so they show as their
      // own bookkeeping line (matches eBay's "Ad Fee General" presentation and
      // makes them easy to categorize as advertising for taxes).
      const rawBreakdown = (sale.feeBreakdown && typeof sale.feeBreakdown === 'object')
        ? sale.feeBreakdown : {};
      const isAdFeeKey = (k) => /^(ad[_ ]?fee|promot|promoted)/i.test(k);
      const adFeeBreakdown = {};
      const platformFeeBreakdown = {};
      for (const [k, v] of Object.entries(rawBreakdown)) {
        const amt = Number(v) || 0;
        if (amt <= 0) continue;
        if (isAdFeeKey(k)) adFeeBreakdown[k] = amt;
        else               platformFeeBreakdown[k] = amt;
      }
      const adFeeAmount    = Math.round(Object.values(adFeeBreakdown).reduce((s, v) => s + v, 0) * 100) / 100;
      const platformFeesNet = Math.max(0, Math.round((fees - adFeeAmount) * 100) / 100);
      const netEarnings = Math.round((gross - fees - labelCost) * 100) / 100;
      const orderTotal = parseFloat(sale.orderTotal) || 0;
      const salesTax   = parseFloat(sale.salesTax)   || 0;
      const subtotal   = parseFloat(sale.subtotal)   || 0;
      const vatAmount  = parseFloat(sale.vatAmount)  || 0;
      const gstAmount  = parseFloat(sale.gstAmount)  || 0;
      const taxBreakdown = (sale.taxBreakdown && typeof sale.taxBreakdown === 'object') ? sale.taxBreakdown : {};
      // Build a tax descriptor for the income-row note. Default reads "tax
      // $48.00 eBay-remitted". When VAT/GST is present, surface it
      // explicitly so international orders are obvious at a glance.
      const taxBreakdownEntries = Object.entries(taxBreakdown).filter(([, v]) => Number(v) > 0);
      const taxLabel = taxBreakdownEntries.length > 1
        ? taxBreakdownEntries.map(([k, v]) => `${k} $${Number(v).toFixed(2)}`).join(' + ')
        : (vatAmount > 0
            ? `VAT $${vatAmount.toFixed(2)}`
            : gstAmount > 0
              ? `GST $${gstAmount.toFixed(2)}`
              : `tax $${salesTax.toFixed(2)}`);

      const incomeCategory =
        platform === 'ebay'    ? 'eBay Sales' :
        platform === 'mercari' ? 'Mercari Sales' :
        platform === 'facebook'? 'Facebook Marketplace' :
                                 'Other Income';
      const feeCategory =
        platform === 'ebay'    ? 'eBay Fees' :
        platform === 'mercari' ? 'Mercari Fees' :
                                 'Platform Fees';
      const adFeeCategory =
        platform === 'ebay'    ? 'eBay Ad Fees' :
                                 'Advertising';

      // Dedup key: ORDER-FIRST, not item-first.
      //
      // History: keys used to include `itemId` so that "two items, one order"
      // (multi-line orders) could coexist. The downside — proven in the
      // wild — is that the SAME order dispatched against TWO DIFFERENT
      // itemIds (across sync runs / cleanup-stubs / auto-stub fallbacks)
      // produces two rows because the importIds differ. That happens any
      // time the matcher resolves to item A on one run and stub B on the
      // next; net effect: doubled income, doubled fees in bookkeeping.
      //
      // New scheme: anchor on (orderId [+ transactionId]) — the natural
      // key from eBay's side. Each line item of a multi-line order is
      // distinguished by `sale.transactionId` when the scraper provides
      // it. Without a transactionId we treat the order as single-line
      // (which is the common case) and dedup by orderId alone.
      const orderKey       = String(sale.id || sale.orderId || '');
      const transactionKey = sale.transactionId ? `:${sale.transactionId}` : '';
      // Fallback for legacy sales with no orderId at all — fall back to the
      // old (itemId + soldAt) compound key so we don't lose those rows.
      const legacyAnchor   = `${itemId}:${sale.soldAt || ''}`;
      const dedupAnchor    = orderKey ? `${orderKey}${transactionKey}` : legacyAnchor;
      const importIds = {
        income:   `auto:${dedupAnchor}`,
        fees:     `auto_fees:${dedupAnchor}`,
        adfee:    `auto_adfee:${dedupAnchor}`,
        shipping: `auto_ship:${dedupAnchor}`,
      };

      const shipNote = buyerShipping > 0
        ? `includes $${buyerShipping.toFixed(2)} buyer-paid shipping`
        : 'no buyer-paid shipping';
      const labelNote = labelCostKnown
        ? `label $${labelCost.toFixed(2)}`
        : 'label cost TBD (enter from Shipping Queue)';
      const orderTotalNote = orderTotal > 0
        ? `Order total $${orderTotal.toFixed(2)} (subtotal $${subtotal.toFixed(2)} + ship $${buyerShipping.toFixed(2)} + ${taxLabel} eBay-remitted). `
        : '';

      const rows = [{
        id: idFor(importIds.income),
        source: 'auto_sale',
        importId: importIds.income,
        date: txDate,
        type: 'income',
        category: incomeCategory,
        description: itemName,
        sku: skuVal,
        // Capture the eBay order ID directly on the row so the user can
        // search bookkeeping for it (importId is keyed by itemId+soldAt
        // and doesn't expose the order number). Critical for multi-quantity
        // listings where multiple orders share an inventory item.
        orderId: sale.id || null,
        amount: gross,
        notes: `Auto-recorded.${sale.id ? ` Order ${sale.id}.` : ''} ${orderTotalNote}Seller revenue $${gross.toFixed(2)} (${shipNote}) · fees $${fees.toFixed(2)} · ${labelNote} · net earnings $${netEarnings.toFixed(2)}.`,
      }];

      // Platform-fee row (everything EXCEPT ad fees). Always emit when there
      // were ANY platform fees, even when feeBreakdown is empty (legacy data).
      const platformFeeAmountForRow = Object.keys(platformFeeBreakdown).length
        ? platformFeesNet
        : Math.max(0, Math.round((fees - adFeeAmount) * 100) / 100);
      if (platformFeeAmountForRow > 0) {
        const fmtBreakdown = (obj) => Object.entries(obj)
          .filter(([, v]) => Number(v) > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} $${Number(v).toFixed(2)}`)
          .join(' · ');
        const breakdown = fmtBreakdown(platformFeeBreakdown);
        rows.push({
          id: idFor(importIds.fees),
          source: 'auto_fees',
          importId: importIds.fees,
          date: txDate,
          type: 'expense',
          category: feeCategory,
          description: `${platform === 'ebay' ? 'eBay' : platform} fees — ${itemName}`,
          sku: skuVal,
          orderId: sale.id || null,
          amount: platformFeeAmountForRow,
          notes: (sale.id ? `Order ${sale.id}. ` : '') + (breakdown
            ? `Breakdown: ${breakdown}.${adFeeAmount > 0 ? ` Ad fees ($${adFeeAmount.toFixed(2)}) recorded separately.` : ''}`
            : (adFeeAmount > 0
                ? `Auto-recorded platform fee. Ad fees ($${adFeeAmount.toFixed(2)}) recorded separately.`
                : 'Auto-recorded platform fee for order.')),
        });
      }

      // Ad-fee row — separate so it's visible as advertising expense (and
      // categorizable for taxes). Only emitted when Finances API returned
      // ad-fee data; otherwise this row simply doesn't appear yet.
      if (adFeeAmount > 0) {
        const fmtAd = Object.entries(adFeeBreakdown)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} $${Number(v).toFixed(2)}`)
          .join(' · ');
        rows.push({
          id: idFor(importIds.adfee),
          source: 'auto_adfee',
          importId: importIds.adfee,
          date: txDate,
          type: 'expense',
          category: adFeeCategory,
          description: `${platform === 'ebay' ? 'eBay' : platform} ad fee — ${itemName}`,
          sku: skuVal,
          orderId: sale.id || null,
          amount: adFeeAmount,
          notes: (sale.id ? `Order ${sale.id}. ` : '') + (fmtAd
            ? `Promoted Listings / Ad Fee breakdown: ${fmtAd}.`
            : 'Auto-recorded eBay advertising fee from Finances API.'),
        });
      }

      if (labelCostKnown && labelCost > 0) {
        const labelNote = labelLooksEstimated
          ? `⚠ Estimated label cost — matches buyer-paid shipping ($${buyerShipping.toFixed(2)}). Real seller cost arrives via the Finances API on next sync. Verify in Shipping Queue if it doesn't update.`
          : labelCostFromFinances
            ? `Seller label cost (from eBay Finances API).${buyerShipping > 0 ? ` Buyer paid $${buyerShipping.toFixed(2)} for shipping.` : ''}`
            : (buyerShipping > 0
                ? `Seller label cost. Buyer paid $${buyerShipping.toFixed(2)} for shipping.`
                : 'Auto-recorded shipping label expense.');
        rows.push({
          id: idFor(importIds.shipping),
          source: 'auto_shipping',
          importId: importIds.shipping,
          date: txDate,
          type: 'expense',
          category: 'Shipping',
          description: `Shipping label — ${itemName}`,
          sku: skuVal,
          orderId: sale.id || null,
          amount: labelCost,
          notes: (sale.id ? `Order ${sale.id}. ` : '') + labelNote,
        });
      }

      return { rows, importIds };
    };

    // ── sale:recorded → first-time auto rows (skip if anchor exists) ──
    // Records GROSS revenue as income + separate expense lines for platform
    // fees and shipping-label cost. Matches the "Order earnings" figure
    // eBay shows the seller and 1099-K gross receipts.
    //
    // Skips entirely if the sale's date falls in a locked month (user has
    // imported a manual monthly summary from eBay's official statement and
    // doesn't want auto rows competing with their manual numbers).
    unsubs.push(eventBus.on('sale:recorded', async (payload) => {
      if (!payload?.sale) return;
      try {
        const txDate = localDateStr(payload.sale.soldAt) || localDateStr(new Date());
        if (isMonthLocked(txDate)) {
          console.log(`[EventBridge] Skipping auto-rows for ${txDate} — month is locked`);
          return;
        }
        const KEY = 'noltech:books:transactions';
        const { rows, importIds } = buildAutoRowsForSale(payload);
        let added = false;
        await serialWrite(KEY, (existing) => {
          const list = existing || [];
          if (list.some(t => t.importId === importIds.income)) return undefined; // already recorded
          added = true;
          return [...rows, ...list];
        });
        if (added) eventBus.emit('books:transactions-changed', { reason: 'sale:recorded' });
      } catch (e) { console.error('[EventBridge] sale:recorded bookkeeping error:', e); }
    }));

    // ── sale:updated → reconcile auto rows against latest sale data ────────
    // Fired when an already-sold item's sale data changes (label cost back-
    // filled from Shipping Queue, ad fees pulled from Finances API on a
    // re-sync, manual edit, etc.). Removes the existing auto_sale / auto_fees
    // / auto_shipping rows for this sale and reinserts fresh ones derived
    // from the current sale state. Manual / non-auto rows are preserved.
    unsubs.push(eventBus.on('sale:updated', async (payload) => {
      if (!payload?.sale) return;
      try {
        const txDate = localDateStr(payload.sale.soldAt) || localDateStr(new Date());
        if (isMonthLocked(txDate)) {
          console.log(`[EventBridge] Skipping auto-row reconcile for ${txDate} — month is locked`);
          return;
        }
        const KEY = 'noltech:books:transactions';
        await serialWrite(KEY, (existing) => {
          const list = existing || [];
          // Capture existing row ids for this sale's importIds so the rebuilt
          // rows REUSE those ids — otherwise the cloud sync queue races
          // (delete-old, insert-new) and trips the unique constraint on
          // import_id when the upsert runs before the delete clears.
          const existingIdByImportId = {};
          for (const t of list) {
            if (t?.importId && t?.id) existingIdByImportId[t.importId] = t.id;
          }
          const { rows, importIds } = buildAutoRowsForSale(payload, existingIdByImportId);
          const idsToReplace = new Set(Object.values(importIds));
          // Strip ALL auto rows for this sale (even ones we won't re-add,
          // e.g., shipping if labelCost just dropped to 0). Manual rows
          // and other sales' auto rows pass through untouched.
          const filtered = list.filter(t => !idsToReplace.has(t.importId));
          return [...rows, ...filtered];
        });
        eventBus.emit('books:transactions-changed', { reason: 'sale:updated' });
      } catch (e) { console.error('[EventBridge] sale:updated bookkeeping error:', e); }
    }));

    // ── sale:recorded → persist to immutable sales history ──
    unsubs.push(eventBus.on('sale:recorded', async (payload) => {
      try {
        const KEY = 'noltech:sales:history';
        await serialWrite(KEY, (existing) => {
          const history = existing || [];
          history.push({ ...payload, recordedAt: new Date().toISOString() });
          return history;
        });
      } catch (e) { console.error('[EventBridge] sales history error:', e); }
    }));

    // ── bid:status-changed → save manifest data permanently for won bids ──
    unsubs.push(eventBus.on('bid:status-changed', async ({ bid, newStatus }) => {
      if (newStatus !== 'won' || !bid?.lotId) return;
      try {
        const KEY = 'noltech:arbitrage:won-manifests';
        const saved = await window.storage.get(KEY) || {};
        if (saved[bid.lotId]) return; // already saved

        // Grab the enrichment from browse-lots before it disappears
        const browseData = await window.storage.get('noltech:arbitrage:browse-lots');
        const enrichments = browseData?.enrichments || {};
        const lot = (browseData?.lots || []).find(l => l.id === bid.lotId);
        const enrichment = enrichments[bid.lotId];

        if (enrichment?.manifestItems?.length || lot) {
          saved[bid.lotId] = {
            lot: lot ? { id: lot.id, title: lot.title, source: lot.source, price: lot.price, quantity: lot.quantity, url: lot.url } : null,
            enrichment: enrichment || null,
            savedAt: new Date().toISOString(),
          };
          await window.storage.set(KEY, saved);
          // Manifest saved for won bid
        }
      } catch (e) { console.error('[EventBridge] save won manifest error:', e); }
    }));

    // ── bid:status-changed → auto-create inventory lot from won bid ──
    // The ADD_LOT dispatch fires lot:added (see AppContext), which the
    // handler below mirrors to a Cost of Goods (Lots) bookkeeping row.
    // This is the lot-expense path the old code missed entirely: winning
    // a bid would create the inventory lot but never record the COGS,
    // so the year's expenses under-reported by the entire lot cost.
    unsubs.push(eventBus.on('bid:status-changed', async ({ bid, newStatus }) => {
      if (newStatus !== 'won' || !bid) return;
      try {
        // Check if already imported
        const bids = await window.storage.get('noltech:arbitrage:bids') || [];
        const thisBid = bids.find(b => b.id === bid.id);
        if (thisBid?.inventoryLotId) return; // already imported

        // Get manifest data if available
        const wonManifests = await window.storage.get('noltech:arbitrage:won-manifests') || {};
        const browseData = await window.storage.get('noltech:arbitrage:browse-lots');
        const enrichments = browseData?.enrichments || {};
        const manifestData = wonManifests[bid.lotId] || {};
        const enrichment = manifestData.enrichment || enrichments[bid.lotId];

        // Create the lot
        const lotId = crypto.randomUUID();
        const lot = {
          id: lotId,
          source: bid.source?.includes('techliq') ? 'techliquidators' : bid.source?.includes('liquidation') ? 'liquidation.com' : 'other',
          sourceName: bid.lotTitle || 'Won Lot',
          purchaseDate: new Date().toISOString().slice(0, 10),
          cost: bid.wonPrice || bid.bidAmount || 0,
          itemCount: enrichment?.manifestItems?.length || bid.quantity || 0,
          status: 'received',
          notes: `Auto-imported from won bid. Source: ${bid.source || 'unknown'}`,
          // Carry the bid metadata so the lot:added handler can write a
          // richer bookkeeping note ("Won bid #...", "Final price $...").
          bidId: bid.id || null,
          bidSource: bid.source || null,
          items: [],
        };

        // Auto-create items from manifest if available
        if (enrichment?.manifestItems?.length) {
          lot.items = enrichment.manifestItems.map(mi => ({
            id: crypto.randomUUID(),
            lotId,
            brand: mi.brand || '',
            model: mi.title || mi.ebayTitle || '',
            category: 'other',
            serialNumber: mi.upc || '',
            conditionOnArrival: 'unknown',
            status: 'received',
            notes: mi.avgPrice ? `eBay est: $${mi.avgPrice.toFixed(2)}` : '',
          }));
          lot.itemCount = lot.items.length;
        }

        dispatch({ type: 'ADD_LOT', lot, _origin: 'won_bid' });

        // Mark bid as imported
        const updatedBids = bids.map(b =>
          b.id === bid.id ? { ...b, inventoryLotId: lotId, importedAt: new Date().toISOString() } : b
        );
        await window.storage.set('noltech:arbitrage:bids', updatedBids);

        eventBus.emit('notification:push', {
          type: 'success',
          title: 'Lot Auto-Imported',
          message: `${bid.lotTitle?.slice(0, 40) || 'Won lot'} added to inventory${lot.items.length > 0 ? ` with ${lot.items.length} items` : ''}`,
        });
      } catch (e) { console.error('[EventBridge] auto-import won bid error:', e); }
    }));

    // ── lot:added → mirror as Cost of Goods (Lots) expense in bookkeeping ──
    // Fires for ANY new lot — won bids, manual LotManager creation, WonLot-
    // Importer, the new Bookkeeping "Add Lot Purchase" quick-add. Senders
    // that already recorded the bookkeeping row themselves pass
    // bookkeepingRecorded=true on the event payload; this skips them.
    //
    // Dedup key: `auto_lot:<lotId>`. This survives lot updates (cost edit,
    // rename) — the lot:updated handler reuses the same id so the row
    // tracks the lot's current cost instead of leaving stale duplicates.
    unsubs.push(eventBus.on('lot:added', async ({ lot, bookkeepingRecorded, fromSync, origin }) => {
      if (!lot || !lot.id) return;
      if (bookkeepingRecorded) return;
      // Sync-replayed lot: the bookkeeping row syncs independently via the
      // transactions storage key, so writing here would create a duplicate
      // that then races back through sync.
      if (fromSync) return;
      try {
        const cost = Number(lot.cost) || 0;
        if (cost <= 0) {
          // No cost on the lot — nothing to record. Common for brokered
          // inventory ($0 in to the user) and Won bids where wonPrice
          // hasn't been populated yet. The lot:updated handler will
          // back-fill when the cost lands.
          return;
        }
        const date = (lot.purchaseDate && /^\d{4}-\d{2}-\d{2}/.test(lot.purchaseDate))
          ? lot.purchaseDate.slice(0, 10)
          : (localDateStr(new Date()) || new Date().toISOString().slice(0, 10));
        const importId = `auto_lot:${lot.id}`;
        const supplier = lot.source === 'liquidation.com' ? 'Liquidation.com'
                       : lot.source === 'techliquidators' ? 'TechLiquidators'
                       : lot.sourceName || 'Other';
        const description = lot.sourceName ? `Lot — ${lot.sourceName}` : 'Lot Purchase';
        const noteParts = [];
        if (origin === 'won_bid')          noteParts.push('Auto-recorded from won bid.');
        else if (origin === 'won_importer') noteParts.push('Auto-recorded from Won Lot Importer.');
        else                                noteParts.push('Auto-recorded from inventory.');
        if (lot.bidId) noteParts.push(`Bid ${lot.bidId}.`);
        if (lot.itemCount > 0) noteParts.push(`${lot.itemCount} item${lot.itemCount !== 1 ? 's' : ''}.`);
        if (lot.notes) noteParts.push(lot.notes);

        const KEY = 'noltech:books:transactions';
        await serialWrite(KEY, (existing) => {
          const list = existing || [];
          // Skip if any row with the same importId already exists (handles
          // the Bookkeeping quick-add path where the row was written before
          // dispatch reached us, and the bookkeepingRecorded flag is the
          // primary guard).
          if (list.some(t => t.importId === importId)) return undefined;
          return [{
            id: crypto.randomUUID(),
            source: 'auto_lot_purchase',
            importId,
            lotId: lot.id,
            date,
            type: 'expense',
            category: 'Cost of Goods (Lots)',
            supplier,
            description,
            amount: cost,
            paymentMethod: '',
            notes: noteParts.join(' '),
          }, ...list];
        });
        eventBus.emit('books:transactions-changed', { reason: 'lot:added', lotId: lot.id });
      } catch (e) { console.error('[EventBridge] lot:added bookkeeping error:', e); }
    }));

    // ── lot:updated → reconcile the Cost of Goods row when cost / date / name change ──
    // Without this, editing a lot's cost in LotManager would leave the
    // bookkeeping row stuck on the original value. The handler updates
    // the existing row in place if it exists; otherwise it inserts one
    // (covers lots created before this bridge shipped). Skips updates
    // that don't touch any bookkeeping-relevant field.
    unsubs.push(eventBus.on('lot:updated', async ({ lotId, updates, bookkeepingRecorded, fromSync }) => {
      if (!lotId || !updates) return;
      if (bookkeepingRecorded) return;
      if (fromSync) return;
      const touchesBookkeeping = ['cost', 'purchaseDate', 'sourceName', 'source', 'notes', 'itemCount']
        .some(k => Object.prototype.hasOwnProperty.call(updates, k));
      if (!touchesBookkeeping) return;
      try {
        const importId = `auto_lot:${lotId}`;
        const KEY = 'noltech:books:transactions';
        await serialWrite(KEY, (existing) => {
          const list = existing || [];
          const idx = list.findIndex(t => t.importId === importId);
          if (idx === -1) return undefined; // no existing row → leave it; lot:added would have handled creation
          const old = list[idx];
          const nextCost = updates.cost !== undefined ? Number(updates.cost) || 0 : old.amount;
          if (nextCost <= 0) {
            // Cost dropped to 0 — drop the row.
            return list.filter((_, i) => i !== idx);
          }
          const nextDate = updates.purchaseDate && /^\d{4}-\d{2}-\d{2}/.test(updates.purchaseDate)
            ? updates.purchaseDate.slice(0, 10)
            : old.date;
          const nextSourceName = updates.sourceName !== undefined ? updates.sourceName : null;
          const nextSupplier = updates.source === 'liquidation.com' ? 'Liquidation.com'
                            : updates.source === 'techliquidators' ? 'TechLiquidators'
                            : (nextSourceName || old.supplier);
          const nextDescription = nextSourceName ? `Lot — ${nextSourceName}` : old.description;
          const updated = { ...old, amount: nextCost, date: nextDate, supplier: nextSupplier, description: nextDescription };
          return list.map((t, i) => i === idx ? updated : t);
        });
        eventBus.emit('books:transactions-changed', { reason: 'lot:updated', lotId });
      } catch (e) { console.error('[EventBridge] lot:updated bookkeeping error:', e); }
    }));

    // ── lot:deleted → remove the matching Cost of Goods row ──
    // Without this, deleting a lot leaves a phantom expense in the books
    // forever. Manual rows (no importId) are never touched.
    unsubs.push(eventBus.on('lot:deleted', async ({ lotId, fromSync }) => {
      if (!lotId) return;
      if (fromSync) return;
      try {
        const importId = `auto_lot:${lotId}`;
        const KEY = 'noltech:books:transactions';
        await serialWrite(KEY, (existing) => {
          const list = existing || [];
          if (!list.some(t => t.importId === importId)) return undefined;
          return list.filter(t => t.importId !== importId);
        });
        eventBus.emit('books:transactions-changed', { reason: 'lot:deleted', lotId });
      } catch (e) { console.error('[EventBridge] lot:deleted bookkeeping error:', e); }
    }));

    // ── sale:refunded → record refund as offsetting bookkeeping row ──
    // Fires from Returns / Refunds workflow OR a Finances API REFUND row
    // (handled in scraper). Adds a Returns & Refunds expense row that
    // mirrors the original sale's gross amount, keyed to the original
    // order so it's findable. Does NOT touch the original auto_sale row
    // (that's the gross-receipts number that flows to the 1099-K).
    unsubs.push(eventBus.on('sale:refunded', async ({ orderId, itemId, amount, soldAt, refundedAt, reason, platform }) => {
      if (!orderId && !itemId) return;
      const refundAmount = Number(amount) || 0;
      if (refundAmount <= 0) return;
      try {
        const anchor = orderId || `${itemId}:${soldAt || ''}`;
        const importId = `auto_refund:${anchor}`;
        const txDate = localDateStr(refundedAt) || localDateStr(new Date());
        const KEY = 'noltech:books:transactions';
        await serialWrite(KEY, (existing) => {
          const list = existing || [];
          if (list.some(t => t.importId === importId)) return undefined; // already recorded
          return [{
            id: crypto.randomUUID(),
            source: 'auto_refund',
            importId,
            orderId: orderId || null,
            date: txDate,
            type: 'expense',
            category: 'Returns & Refunds',
            supplier: platform === 'mercari' ? 'Mercari' : 'eBay',
            description: `Refund — ${orderId ? `order ${orderId}` : 'sale'}`,
            amount: refundAmount,
            paymentMethod: '',
            notes: (reason ? `Reason: ${reason}. ` : '') + 'Auto-recorded buyer refund. Gross sale row left intact for 1099-K reconciliation.',
          }, ...list];
        });
        eventBus.emit('books:transactions-changed', { reason: 'sale:refunded', orderId });
      } catch (e) { console.error('[EventBridge] sale:refunded bookkeeping error:', e); }
    }));

    // ── lot:imported → mark bid as fulfilled in BidTracker ──
    unsubs.push(eventBus.on('lot:imported', async ({ bidId, lotId }) => {
      if (!bidId) return;
      try {
        const KEY = 'noltech:arbitrage:bids';
        const bids = await window.storage.get(KEY) || [];
        const updated = bids.map(b =>
          b.id === bidId ? { ...b, inventoryLotId: lotId, importedAt: new Date().toISOString() } : b
        );
        await window.storage.set(KEY, updated);
      } catch (e) { console.error('[EventBridge] bid fulfillment error:', e); }
    }));

    // ── price:changed → auto-add to price history ──
    // Reason is normalized through the priceHistoryReasons taxonomy so any
    // legacy emitter (or one that supplies an unrecognized string) still
    // produces a canonical row. When the emitter supplies oldPrice+newPrice
    // but no reason, normalize() promotes 'manual' to MARKDOWN/MARKUP/BATCH
    // by direction. serialWrite serializes against concurrent writes from
    // other handlers and from BatchUpdater's direct write path.
    unsubs.push(eventBus.on('price:changed', async ({ itemId, oldPrice, newPrice, reason }) => {
      if (!itemId) return;
      try {
        const KEY = 'noltech:price-history';
        const canonicalReason = normalizePriceReason(reason, { oldPrice, newPrice });
        await serialWrite(KEY, (data) => {
          const all = data || {};
          all[itemId] = appendHistoryRow(all[itemId], { price: newPrice, reason: canonicalReason, oldPrice });
          return all;
        });
      } catch (e) { console.error('[EventBridge] price history error:', e); }
    }));

    return () => unsubs.forEach(fn => fn());
  }, [dispatch]);
}

import { useState, useCallback, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { useSkuOverlay } from './useSkuOverlay';
import { EBAY_TOKEN_KEY, EBAY_SYNC_LOT_ID, PIPELINE_BASE } from '../utils/constants';
import { decryptObject } from '../services/crypto';
import eventBus from '../services/eventBus';
import { getEbayAccessToken, invalidateEbayAccessToken } from '../services/ebayAuth';
import { parseBrand, mapCategory, mapCondition } from '../utils/itemMapping';
import { supabase, isCloudEnabled, getActiveWorkspace } from '../services/supabase';

const KEY_LAST_SYNC = 'noltech:sync:lastSyncedAt';

const PIPELINE = PIPELINE_BASE;
const KEY_SALES = 'noltech:lotprofit:sales';

// ─── Local helpers ────────────────────────────────────────────────────────────
// parseBrand / mapCategory / mapCondition are now imported from
// utils/itemMapping (shared with ItemManager). The two below stay here
// because they depend on overlay state and live near the sync flow.

function findLotBySku(sku, lots, overlay) {
  if (!sku) return null;
  const u = sku.toUpperCase();
  return lots.find((l) => {
    const pre = overlay[l.id]?.skuPrefix?.trim().toUpperCase();
    const suf = overlay[l.id]?.skuSuffix?.trim().toUpperCase();
    if (pre && suf) return u.startsWith(pre) && u.endsWith(suf);
    if (pre)        return u.startsWith(pre);
    if (suf)        return u.endsWith(suf);
    return false;
  }) || null;
}

function matchSalesToLots(sales, lots, overlay) {
  return sales.map((sale) => {
    if (!sale.sku) return sale;
    const u = sale.sku.toUpperCase();
    const match = lots.find((l) => {
      const pre = overlay[l.id]?.skuPrefix?.trim().toUpperCase();
      const suf = overlay[l.id]?.skuSuffix?.trim().toUpperCase();
      if (pre && suf) return u.startsWith(pre) && u.endsWith(suf);
      if (pre)        return u.startsWith(pre);
      if (suf)        return u.endsWith(suf);
      return false;
    });
    return match ? { ...sale, lotId: match.id } : sale;
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSyncAll() {
  const { state, dispatch } = useApp();
  const { overlay } = useSkuOverlay();
  const [syncing,      setSyncing]       = useState(false);
  const [status,       setStatus]        = useState('');
  const [localLastAt,  setLocalLastAt]   = useState(null);
  const [autoLastAt,   setAutoLastAt]    = useState(null);

  // Pick the most recent of: local Sync All click vs AWS sync-agent's
  // last_run_at heartbeat. This makes "Last synced" honest about background
  // syncs (every 15 min on EC2) instead of only counting manual button clicks.
  const localMs = localLastAt ? new Date(localLastAt).getTime() : 0;
  const autoMs  = autoLastAt  ? new Date(autoLastAt).getTime()  : 0;
  const lastSyncedAt   = autoMs > localMs ? autoLastAt : localLastAt;
  const lastSyncSource = autoMs > localMs ? 'auto'     : (localLastAt ? 'manual' : null);

  useEffect(() => {
    window.storage.get(KEY_LAST_SYNC).then((v) => { if (v) setLocalLastAt(v); }).catch(e => console.error('[useSyncAll] last sync load failed:', e));
  }, []);

  // Poll the AWS sync-agent's heartbeat row every 30s so the "Last synced"
  // label reflects unattended runs even when the Hub never clicked Sync All.
  useEffect(() => {
    if (!isCloudEnabled || !supabase) return;
    let alive = true;
    const fetchAuto = async () => {
      try {
        const ws = await getActiveWorkspace();
        if (!ws) return;
        const { data } = await supabase
          .from('agent_heartbeats')
          .select('last_run_at, updated_at')
          .eq('workspace_id', ws)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (alive && data?.last_run_at) setAutoLastAt(data.last_run_at);
      } catch (e) { /* best-effort, never block UI */ }
    };
    fetchAuto();
    const id = setInterval(fetchAuto, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Backwards-compat shim — anything that was setting `lastSyncedAt` directly
  // now writes to localLastAt. (The actual writes happen in syncAll below.)
  const setLastSyncedAt = setLocalLastAt;

  const syncAll = useCallback(async () => {
    setSyncing(true);
    setStatus('Loading credentials…');
    try {
      const rawCreds = await window.storage.get(EBAY_TOKEN_KEY).catch(() => null);
      const creds = await decryptObject(rawCreds || {});
      if (!creds?.token) {
        setStatus('No eBay token. Add it in Settings → eBay Credentials.');
        return;
      }

      // ── Step 1: Active listings ──────────────────────────────────────────────
      setStatus('Syncing active listings…');
      const params = new URLSearchParams({ userToken: creds.token });
      if (creds.appId)  params.set('appId',  creds.appId);
      if (creds.devId)  params.set('devId',  creds.devId);
      if (creds.certId) params.set('certId', creds.certId);

      const listRes  = await fetch(`${PIPELINE}/api/ebay/listings?${params}`, {
        signal: AbortSignal.timeout(45000),
      });
      const listData = await listRes.json();
      if (!listData.success) throw new Error(listData.error || 'Listings fetch failed');

      const skuOverlay = overlay;
      const lots       = state.lots;

      const existingMap = new Map(
        lots.flatMap((l) => (l.items || [])
          .filter((i) => i.ebayItemId)
          .map((i) => [i.ebayItemId, i.id])
        )
      );

      if (!lots.some((l) => l.id === EBAY_SYNC_LOT_ID)) {
        dispatch({
          type: 'ADD_LOT',
          lot: {
            id: EBAY_SYNC_LOT_ID, source: 'other', sourceName: 'eBay Active Listings',
            purchaseDate: new Date().toISOString().slice(0, 10),
            cost: 0, itemCount: 0, status: 'listed',
            notes: 'Auto-synced from eBay. Do not delete.', items: [],
          },
        });
      }

      let added = 0, updated = 0;
      // Per-category change lists for the post-sync summary notification.
      // Declared up here because the listings loop below pushes to
      // newListings / updatedListings, and the orders loop further down
      // pushes to the rest. JS hoisting wouldn't save us — `const`
      // declarations have a temporal dead zone.
      const summaryLists = {
        newListings:      [], // {itemId, title, sku, price}
        updatedListings:  [], // {itemId, title, sku, price}
        newSales:         [], // {orderId, title, sku, gross}
        refreshedSales:   [], // {orderId, title, fields}
        autoCreated:      [], // {orderId, title, sku, gross}
      };
      for (const listing of listData.listings) {
        const notes = [
          listing.conditionName || '',
          listing.watchCount  > 0 ? `${listing.watchCount} watching` : '',
          listing.hitCount    > 0 ? `${listing.hitCount} views`       : '',
          listing.quantitySold > 0 ? `${listing.quantitySold} sold`  : '',
        ].filter(Boolean).join(' · ');

        const category  = listing.categoryInternal || mapCategory(listing.categoryName);
        const condition = listing.conditionId ? mapCondition(listing.conditionId) : '';

        const listingQuantity = Math.max(1, parseInt(listing.quantity) || 1);

        if (existingMap.has(listing.itemId)) {
          const existingId = existingMap.get(listing.itemId);
          const matchedLot = findLotBySku(listing.sku, lots, skuOverlay);
          dispatch({
            type: 'UPDATE_ITEM',
            id:   existingId,
            updates: {
              conditionOnArrival: condition,
              ebayConditionName:  listing.conditionName || '',
              category, listingPrice: listing.currentPrice, notes,
              listingQuantity,
              ...(matchedLot ? { lotId: matchedLot.id } : {}),
            },
          });
          updated++;
          summaryLists.updatedListings.push({
            itemId: existingId,
            title: listing.title || '',
            sku:   listing.sku || '',
            price: Number(listing.currentPrice) || 0,
          });
        } else {
          const newId = crypto.randomUUID();
          const matchedLot = findLotBySku(listing.sku, lots, skuOverlay);
          dispatch({
            type: 'ADD_ITEM',
            item: {
              id:                newId,
              lotId:             matchedLot ? matchedLot.id : EBAY_SYNC_LOT_ID,
              ebayItemId:        listing.itemId,
              dateAdded:         listing.startTime?.slice(0, 10) || new Date().toISOString().slice(0, 10),
              brand:             parseBrand(listing.title),
              model:             listing.title,
              category,
              serialNumber:      listing.sku || '',
              conditionOnArrival: condition,
              ebayConditionName:  listing.conditionName || '',
              conditionGrade:    '',
              status:            'listed',
              notes,
              listingPrice:      listing.currentPrice,
              listingQuantity,
              listingUrl:        `https://www.ebay.com/itm/${listing.itemId}`,
              sale:              null,
            },
          });
          added++;
          summaryLists.newListings.push({
            itemId: newId,
            title: listing.title || '',
            sku:   listing.sku || '',
            price: Number(listing.currentPrice) || 0,
          });
        }
      }

      // Cache the authoritative eBay active-listings snapshot so the Hub
      // dashboard can display the same count, units, and value that eBay
      // reports — even when our inventory items are out of sync (e.g.,
      // multi-quantity listings where a unit sold and the inventory item
      // flipped to "sold" but the eBay listing still has remaining stock).
      try {
        const listings = (listData.listings || []).map((l) => {
          // ebayListings.js returns:
          //   quantity     = total listed quantity (original count)
          //   quantitySold = how many have sold so far
          // Current available = total − sold. Clamp to 0; sub-1 listings
          // shouldn't appear in active listings anyway (eBay auto-ends them).
          const totalQty = parseInt(l.quantity)     || 0;
          const sold     = parseInt(l.quantitySold) || 0;
          const remaining = Math.max(0, totalQty - sold);
          const price = parseFloat(l.currentPrice) || parseFloat(l.price) || 0;
          return {
            itemId:       l.itemId,
            sku:          l.sku || null,
            quantity:     totalQty,
            quantitySold: sold,
            remaining,
            currentPrice: price,
          };
        }).filter((l) => l.itemId);

        const totalUnits = listings.reduce((s, l) => s + l.remaining, 0);
        const totalValue = listings.reduce((s, l) => s + l.remaining * l.currentPrice, 0);

        const snapshot = {
          count:    listings.length,
          itemIds:  listings.map((l) => l.itemId),
          listings,
          totalUnits,
          totalValue: Math.round(totalValue * 100) / 100,
          syncedAt: new Date().toISOString(),
        };
        await window.storage.set('noltech:ebay:active-listings-snapshot', snapshot);
      } catch (e) { console.error('[useSyncAll] active-listings snapshot save failed:', e); }

      // ── Step 2: Mark sold items ──────────────────────────────────────────────
      setStatus('Syncing sold orders…');

      // Match eBay's order.sku against BOTH `serialNumber` AND `sku` fields
      // on the inventory item. Items created via Active Listings Sync get
      // their SKU written into `serialNumber`; items created manually or via
      // lot manifest may only have `sku` populated. Without checking both,
      // the latter group's orders silently get skipped.
      // `serialNumber` wins on collisions to preserve the original semantics.
      const skuMap = new Map();
      for (const l of lots) {
        for (const i of (l.items || [])) {
          if (i.serialNumber) skuMap.set(i.serialNumber, i.id);
        }
      }
      for (const l of lots) {
        for (const i of (l.items || [])) {
          if (i.sku && !skuMap.has(i.sku)) skuMap.set(i.sku, i.id);
        }
      }
      const itemById = new Map(lots.flatMap((l) => (l.items || []).map((i) => [i.id, i])));

      // Most reliable match: an inventory item that already has this sale
      // recorded (sale.id === order.orderId). This catches items whose
      // SKU/serialNumber/ebayItemId fields got cleared but still have the
      // original sale attached — the sync would otherwise skip them as
      // "no inventory match" even though they obviously belong to that order.
      const orderIdMap = new Map();
      for (const l of lots) {
        for (const i of (l.items || [])) {
          if (i.sale?.id) orderIdMap.set(String(i.sale.id), i.id);
        }
      }

      const ordersRes  = await fetch(`${PIPELINE}/api/ebay/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken: creds.token, appId: creds.appId || '', devId: creds.devId || '', certId: creds.certId || '' }),
        signal: AbortSignal.timeout(60000),
      });
      const ordersData = await ordersRes.json();
      let soldCount = 0;
      // Track sales that ACTUALLY had their ad-fee breakdown / label cost
      // changed by this sync (vs. just being seen in the Finances API).
      // This lets the status message report a delta — "refreshed 3 ad fees"
      // — instead of the same "ad fees on 68" every sync that triggered it.
      let financesAdFeeUpdates = 0;
      let financesLabelUpdates = 0;
      // Track every order the sync couldn't link to an inventory item. These
      // orders silently dropped before this hook started logging them — now
      // they get persisted to noltech:sync:skipped-orders and surfaced in
      // eBay Match so the user can see exactly what's missing and why.
      const skippedOrders = [];
      // Auto-create stub inventory items for orders that can't otherwise be
      // matched. Common case: multi-quantity listings where the inventory
      // item gets removed (manual delete, dedupe, listing-end). Without the
      // stub, every subsequent buyer's order silently gets skipped and the
      // books drift from eBay's records.
      let autoCreatedCount = 0;
      // IDs of items auto-created in THIS sync run. Their pre-update state
      // isn't visible in AppContext's prevState snapshot (captured at
      // dispatch time, before React re-renders), so the built-in
      // sale:recorded emission silently misses. We emit it ourselves below.
      const autoCreatedIds = new Set();

      // ── Step 2a: Pull Ad Fees + REAL Shipping Label costs from Finances API ─
      // GetOrders returns ESTIMATED labelCost (from ActualShippingCost), but
      // the real amount eBay billed for the label lives in a separate
      // SHIPPING_LABEL transaction. Same story for Ad Fee General (NON_SALE_CHARGE).
      // Keying by orderId so we can merge both into each sale.
      // No-op if user hasn't supplied an OAuth2 user token yet.
      let adFeesByOrderId = {};
      let labelCostByOrderId = {};
      let adFeeStats = { orders: 0, total: 0 };
      let labelStats = { orders: 0, total: 0 };
      // Resolve an OAuth2 access token: prefers the auto-refresh flow
      // (refreshToken + appId + certId), falls back to a manually pasted
      // static token. Returns null when neither is configured.
      let oauthAccessToken = null;
      try {
        oauthAccessToken = await getEbayAccessToken(creds);
      } catch (e) {
        console.error('[useSyncAll] OAuth refresh failed:', e.message);
        eventBus.emit('notification:push', {
          id: `oauth-refresh-${Date.now()}`,
          type: 'error',
          title: 'eBay OAuth refresh failed',
          message: `${e.message}. Check the Refresh Token + App ID/Cert ID in Settings → eBay Credentials.`,
          ts: new Date().toISOString(),
        });
      }
      if (oauthAccessToken) {
        setStatus('Syncing ad fees + label costs…');
        try {
          const fromDate = new Date(Date.now() - 95 * 86400000).toISOString();
          const toDate   = new Date().toISOString();
          const finRes = await fetch(`${PIPELINE}/api/ebay/finances/transactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              oauthUserToken: oauthAccessToken,
              from: fromDate,
              to: toDate,
              // Ask for fee charges, label charges, AND refund/credit/dispute
              // flows. The refund types feed sale:refunded events that the
              // event bridge writes into Returns & Refunds bookkeeping rows.
              types: ['NON_SALE_CHARGE', 'SHIPPING_LABEL', 'REFUND', 'CREDIT', 'DISPUTE'],
            }),
            signal: AbortSignal.timeout(45000),
          });
          const finData = await finRes.json();
          // Detect auth-style failures so they don't fail silently. The
          // scraper returns a friendly error string for 401/403; surface it
          // as a visible toast and a console error so the user knows their
          // OAuth User Token expired and needs re-issuing in Settings →
          // eBay Credentials.
          if (!finData.success) {
            const msg = finData.error || 'Finances API call failed';
            const looksLikeAuth = /auth|oauth|401|403|token|scope|expired|unauthorized/i.test(msg);
            console.error('[useSyncAll] finances fetch error:', msg);
            // Auth errors usually mean the cached access token went stale
            // mid-flight (rare but possible) — drop it so the next sync
            // forces a fresh mint via the refresh token.
            if (looksLikeAuth) {
              invalidateEbayAccessToken().catch(() => {});
            }
            eventBus.emit('notification:push', {
              id: `finances-err-${Date.now()}`,
              type: 'error',
              title: looksLikeAuth ? 'eBay Finances OAuth expired' : 'eBay Finances sync failed',
              message: looksLikeAuth
                ? 'Ad fees and real shipping-label costs can\'t be pulled. Re-issue your OAuth2 User Token in Settings → eBay Credentials (sell.finances scope).'
                : `${msg}. Bookkeeping rows will fall back to GetOrders estimates until this is fixed.`,
              ts: new Date().toISOString(),
            });
          }
          if (finData.success) {
            // Persist every raw Finances event to a separate key so the
            // Per-Event Ledger tab can show each transaction as its own
            // row (the aggregation below COLLAPSES per-event detail —
            // multiple ad-fee buckets and multiple shipping labels per
            // order get summed and lose their individual tx ids). This
            // is purely additive — the aggregation that follows is
            // unchanged. Rolling 10k cap keeps IndexedDB sane.
            const EVENTS_KEY = 'noltech:ebay:finances-events';
            try {
              const prior = await window.storage.get(EVENTS_KEY).catch(() => []) || [];
              const seenIds = new Set(prior.map(e => e?.id).filter(Boolean));
              const fresh = (finData.transactions || []).filter(t => t?.id && !seenIds.has(t.id));
              if (fresh.length) {
                const merged = [...prior, ...fresh];
                // Roll the window — keep the most recent 10k by date so
                // the array doesn't grow unbounded over years of syncs.
                merged.sort((a, b) => (b?.date || '').localeCompare(a?.date || ''));
                const trimmed = merged.slice(0, 10000);
                await window.storage.set(EVENTS_KEY, trimmed);
              }
            } catch (e) {
              console.error('[useSyncAll] finances-events persist failed:', e);
              // Surface the failure so the user knows the Per-Event Ledger
              // is silently stale. Without this, sync reports success while
              // the new tab is empty for no visible reason.
              eventBus.emit('notification:push', {
                id: `finances-events-${Date.now()}`,
                type: 'error',
                title: 'Finance events not saved',
                message: 'Storage write failed; the Per-Event Ledger may be stale. Free space and re-sync.',
                ts: new Date().toISOString(),
              });
            }

            // Track which refund tx ids we've already emitted for, so a
            // user re-running sync doesn't double-write Returns & Refunds
            // rows. Persisted to storage so this survives reloads.
            //
            // Multi-device note: this set is DEVICE-LOCAL by design — eBay
            // tx ids are globally unique, so a missed local-dedup hit on
            // device B doesn't matter as long as the downstream guard
            // holds. That guard lives in useEventBridge.sale:refunded,
            // which checks for an existing importId in the synced
            // transactions array before writing. So even if device B emits
            // a duplicate event because its refundsSeen set is empty, the
            // bookkeeping row only lands once. The set here is a perf
            // optimization, not a correctness boundary.
            const REFUND_SEEN_KEY = 'noltech:ebay:refunds-emitted';
            const refundsSeen = new Set(await window.storage.get(REFUND_SEEN_KEY).catch(() => []) || []);
            const refundsToMark = [];

            // Belt-and-suspenders: pre-load existing refund importIds from
            // the synced transactions so we skip emission even when the
            // device-local refundsSeen set is empty (cleared cache, fresh
            // device, etc.). useEventBridge would dedup anyway, but
            // skipping here avoids a wasted serialWrite + event roundtrip.
            const existingTxs = await window.storage.get('noltech:books:transactions').catch(() => []) || [];
            const existingRefundOrderIds = new Set();
            for (const t of existingTxs) {
              if (t?.importId?.startsWith('auto_refund:') && t?.orderId) {
                existingRefundOrderIds.add(String(t.orderId));
              }
            }

            for (const tx of finData.transactions || []) {
              if (!tx.orderId) continue;
              const amt = Math.abs(parseFloat(tx.amount) || 0);
              if (amt <= 0) continue;

              if (tx.type === 'SHIPPING_LABEL') {
                // eBay can issue multiple labels per order (returns, splits).
                // Sum them — that's the total label cost the seller paid.
                labelCostByOrderId[tx.orderId] = Math.round(
                  ((labelCostByOrderId[tx.orderId] || 0) + amt) * 100,
                ) / 100;
                labelStats.total += amt;
              } else if (tx.type === 'REFUND' || tx.type === 'CREDIT' || tx.type === 'DISPUTE') {
                // Buyer refund / seller credit / dispute resolution. The
                // event bridge's sale:refunded handler writes the offsetting
                // Returns & Refunds expense row keyed to the original order.
                // Three-layer dedup:
                //   1. refundsSeen (device-local tx id set) — fast path
                //   2. existingRefundOrderIds (synced bookkeeping) — works
                //      cross-device because the bookkeeping txns sync
                //   3. useEventBridge importId check — final write guard
                if (tx.id && refundsSeen.has(tx.id)) continue;
                if (existingRefundOrderIds.has(String(tx.orderId))) {
                  // Already booked on this or another device. Mark seen so
                  // subsequent syncs don't re-check storage.
                  if (tx.id) refundsToMark.push(tx.id);
                  continue;
                }
                eventBus.emit('sale:refunded', {
                  orderId:    tx.orderId,
                  amount:     amt,
                  refundedAt: tx.date,
                  reason:     tx.memo || tx.feeType || tx.type,
                  platform:   'ebay',
                });
                if (tx.id) refundsToMark.push(tx.id);
              } else {
                // Default: ad fees / promoted listings / regulatory
                const bucket = adFeesByOrderId[tx.orderId] ||= {};
                const raw = (tx.feeType || tx.type || 'AdFeeGeneral').toString();
                const key = raw === 'AD_FEE'
                  ? 'AdFeeGeneral'
                  : raw.split(/[_\s]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
                bucket[key] = Math.round(((bucket[key] || 0) + amt) * 100) / 100;
                adFeeStats.total += amt;
              }
            }
            adFeeStats.orders = Object.keys(adFeesByOrderId).length;
            labelStats.orders = Object.keys(labelCostByOrderId).length;

            // Persist the refund-seen set if anything new emitted.
            if (refundsToMark.length) {
              for (const id of refundsToMark) refundsSeen.add(id);
              await window.storage.set(REFUND_SEEN_KEY, [...refundsSeen]).catch(() => {});
            }
          }
        } catch (e) {
          console.error('[useSyncAll] finances fetch failed:', e.message);
          eventBus.emit('notification:push', {
            id: `finances-net-${Date.now()}`,
            type: 'error',
            title: 'eBay Finances sync failed',
            message: `Network error: ${e.message}. Bookkeeping rows will fall back to GetOrders estimates.`,
            ts: new Date().toISOString(),
          });
        }
      }

      // Helper: merge Finances-API ad-fee buckets into an existing fee
      // breakdown. Finances values are AUTHORITATIVE for the buckets they
      // cover — REPLACE existing values, don't add. (Adding caused triple-
      // counting when GetOrders already had AdFeeGeneral inline AND the
      // Finances API also returned it.)
      const applyAdFees = (baseFees, baseBreakdown, bucket) => {
        if (!bucket) return { totalFees: baseFees, breakdown: baseBreakdown };
        const breakdown = { ...(baseBreakdown || {}) };
        let netDelta = 0; // signed: positive if Finances values exceed existing, negative otherwise
        for (const [k, v] of Object.entries(bucket)) {
          const previous = Number(breakdown[k]) || 0;
          const next = Math.round(v * 100) / 100;
          breakdown[k] = next;
          netDelta += (next - previous);
        }
        return {
          totalFees: Math.round(((baseFees || 0) + netDelta) * 100) / 100,
          breakdown,
        };
      };

      if (ordersData.success) {
        for (const order of ordersData.orders) {
          // Prefer SKU/serial match over eBay item ID match. Multi-quantity
          // listings (e.g., 21 Apple Pencils on a single eBay listing) all
          // share the same ebayItemId, so the existingMap lookup would
          // collapse them to one arbitrary inventory item — every order for
          // that listing would overwrite the same record. The SKU is per-
          // unit and uniquely identifies which physical item sold.
          // Match priority: SKU/serial → eBay item ID → existing sale.id.
          // The orderId fallback catches items whose SKU/serialNumber/itemId
          // fields got cleared but still have the sale already attached.
          let itemId = skuMap.get(order.sku)
            || existingMap.get(order.ebayItemId)
            || orderIdMap.get(String(order.orderId));
          if (!itemId) {
            // Auto-create a stub inventory item. Common case: multi-quantity
            // listing that sold out and was removed from inventory. Stub
            // gets a real identity (sku/ebayItemId) so future syncs match.
            // Without sku AND ebayItemId we can't reliably re-find the item
            // for inventory purposes, but the user has stated that every
            // sale on their eBay account is business income — so we STILL
            // create the bookkeeping rows. The order just doesn't get an
            // inventory item linked. We also keep a record in the skipped
            // log for manual review (e.g., to attach a cost basis later).
            if (!order.sku && !order.ebayItemId) {
              const orderGross = Number(order.totalRevenue) || Number(order.orderTotal) || Number(order.salePrice) || 0;
              skippedOrders.push({
                orderId:    order.orderId,
                date:       order.date || '',
                title:      order.title || '',
                sku:        '',
                ebayItemId: '',
                buyer:      order.buyer || '',
                gross:      orderGross,
                subtotal:   Number(order.subtotal) || 0,
                shipping:   Number(order.buyerShipping) || 0,
                fees:       Number(order.ebayFees) || 0,
                reason:     'No SKU or eBay item ID — bookkeeping row created without inventory link',
              });

              // Synthetic itemId derived from the orderId so importIds in
              // the event bridge stay stable across re-syncs. The "ext:"
              // prefix marks this as an external (non-inventory) sale.
              const syntheticItemId = `ext:${order.orderId}`;
              const fauxBucket = adFeesByOrderId[order.orderId];
              const labelCost = parseFloat(order.labelCost) || 0;
              const orderBuyerShipping = Number(order.buyerShipping) || 0;
              const orderTotalRevenue = Number(order.totalRevenue) || orderGross;
              const orderOrderTotal = Number(order.orderTotal) || (orderTotalRevenue + orderBuyerShipping);
              const { totalFees, breakdown } = applyAdFees(
                Number(order.ebayFees) || 0,
                order.feeBreakdown,
                fauxBucket,
              );

              eventBus.emit('sale:recorded', {
                itemId: syntheticItemId,
                lotId: EBAY_SYNC_LOT_ID,
                brand: '',
                model: (order.title || '').trim(),
                sku: '',
                sale: {
                  id:           order.orderId,
                  platform:     'ebay',
                  itemName:     (order.title || '').trim() || null,
                  salePrice:    orderTotalRevenue,
                  subtotal:     Number(order.subtotal) || 0,
                  buyerShipping: orderBuyerShipping,
                  salesTax:     Number(order.salesTax) || 0,
                  taxBreakdown: order.taxBreakdown || {},
                  vatAmount:    Number(order.vatAmount) || 0,
                  gstAmount:    Number(order.gstAmount) || 0,
                  orderTotal:   orderOrderTotal,
                  labelCost,
                  labelCostKnown: !!order.labelCostKnown,
                  labelCostSource: 'estimate',
                  shippingCost: labelCost,
                  platformFees: totalFees,
                  feeBreakdown: breakdown,
                  netRevenue:   orderTotalRevenue - labelCost - totalFees,
                  profit:       0,                  // no cost basis available
                  soldAt:       order.date,
                  buyerName:    order.buyer || '',
                },
              });
              continue;
            }
            const newId = crypto.randomUUID();
            const orderDateOnly = (order.date || new Date().toISOString()).slice(0, 10);
            const titleTrimmed = (order.title || '').trim();
            const stubItem = {
              id:                newId,
              lotId:             EBAY_SYNC_LOT_ID,
              ebayItemId:        order.ebayItemId || '',
              dateAdded:         orderDateOnly,
              brand:             parseBrand(titleTrimmed),
              model:             titleTrimmed || `Order ${order.orderId}`,
              category:          'other',
              serialNumber:      order.sku || '',
              sku:               order.sku || '',
              conditionOnArrival:'',
              conditionGrade:    '',
              status:            'received', // flipped to 'sold' below
              notes:             'Auto-created from eBay order during Sync All. Cost basis defaults to $0; edit if known.',
              costBasis:         0,
              listingPrice:      Number(order.salePrice) || 0,
              sale:              null,
              autoCreatedFromOrder: true,
            };
            dispatch({ type: 'ADD_ITEM', item: stubItem });
            // Update local maps so the rest of the loop and subsequent
            // iterations find this stub instead of recreating it.
            if (order.sku)        skuMap.set(order.sku, newId);
            if (order.ebayItemId) existingMap.set(order.ebayItemId, newId);
            if (order.orderId)    orderIdMap.set(String(order.orderId), newId);
            itemById.set(newId, stubItem);
            itemId = newId;
            autoCreatedCount++;
            autoCreatedIds.add(newId);
          }
          const existing = itemById.get(itemId);
          const bucket = adFeesByOrderId[order.orderId];
          const realLabel = labelCostByOrderId[order.orderId];

          // ── eBay International Shipping (eIS) reconciliation ──────────────
          // For eIS orders, Trading API returns the FULL international shipping
          // fee as `buyerShipping` and `labelCost` (typically equal, both
          // inflated). The seller is actually only reimbursed the domestic-leg
          // amount, which equals the Finances API SHIPPING_LABEL transaction.
          // Override so the seller's bookkeeping reflects what they actually
          // earned: revenue = items + (real shipping reimbursement = realLabel).
          let orderBuyerShipping = parseFloat(order.buyerShipping) || 0;
          let orderTotalRevenue  = parseFloat(order.totalRevenue)  || 0;
          let orderOrderTotal    = parseFloat(order.orderTotal)    || 0;
          if (order.isInternationalForwarding && realLabel != null && realLabel > 0) {
            const subt = parseFloat(order.subtotal) || 0;
            const tax  = parseFloat(order.salesTax) || 0;
            orderBuyerShipping = realLabel;
            orderTotalRevenue  = Math.round((subt + realLabel) * 100) / 100;
            // Best-effort orderTotal: if Trading API gave us a tax value, use
            // it; otherwise leave orderTotal as-is (it'll match buyer's view
            // approximately, and the bookkeeping note clearly labels it).
            orderOrderTotal    = Math.round((subt + realLabel + tax) * 100) / 100;
          }

          // Backfill brand/model on the matched inventory item if they're
          // missing. This happens when items were created as bulk SKU entries
          // (e.g., Lot002 - #005) without product-level info, and now an order
          // arrives with the actual eBay listing title. Bookkeeping rows
          // would otherwise show "Item Sale" instead of the real product name.
          let backfilledBrand;
          let backfilledModel;
          const orderTitle = (order.title || '').trim();
          if (orderTitle) {
            if (!existing?.brand) backfilledBrand = parseBrand(orderTitle);
            if (!existing?.model) backfilledModel = orderTitle;
          }
          const itemFieldUpdates = {};
          if (backfilledBrand) itemFieldUpdates.brand = backfilledBrand;
          if (backfilledModel) itemFieldUpdates.model = backfilledModel;
          // Backfill `serialNumber` from the order's SKU when the inventory
          // item only has it in the `sku` field. Keeps the two SKU-like
          // fields aligned so future syncs (and any code reading
          // `serialNumber` directly) match correctly without re-relying on
          // the dual-field lookup. Skip if the item already has a serial
          // — don't overwrite a hand-set value.
          if (order.sku && !existing?.serialNumber) {
            itemFieldUpdates.serialNumber = order.sku;
          }

          // Already-sold items: refresh the sale with the latest GetOrders +
          // Finances API data. Previously we only updated when Finances data
          // arrived, but that left stale GetOrders fields (salePrice,
          // buyerShipping, salesTax, etc.) frozen at first-sync values — so
          // any subsequent scraper improvements (better tax/shipping math)
          // never propagated to existing sold items. We always recompute now
          // and only push if anything actually changed.
          if (existing?.status === 'sold') {
            const s = existing.sale || {};
            const { totalFees, breakdown } = applyAdFees(
              parseFloat(order.ebayFees) || parseFloat(s.platformFees) || 0,
              order.feeBreakdown || s.feeBreakdown,
              bucket,
            );
            const labelCost = realLabel != null
              ? realLabel
              : (parseFloat(s.labelCost) || parseFloat(order.labelCost) || parseFloat(s.shippingCost) || 0);
            const labelCostSource = realLabel != null
              ? 'finances'
              : (s.labelCostSource || 'estimate');
            // Refresh GetOrders-side fields from the latest scrape. These
            // come from eBay, not user input, so it's safe to overwrite.
            // For eIS orders, salePrice/buyerShipping/orderTotal use the
            // reconciled values computed above (real label cost from
            // Finances API), not the inflated Trading API values.
            const salePrice     = orderTotalRevenue || parseFloat(s.salePrice) || 0;
            const subtotal      = parseFloat(order.subtotal)     || parseFloat(s.subtotal)  || 0;
            const buyerShipping = orderBuyerShipping || parseFloat(s.buyerShipping) || 0;
            const salesTax      = parseFloat(order.salesTax)     || parseFloat(s.salesTax)  || 0;
            const orderTotal    = orderOrderTotal   || parseFloat(s.orderTotal) || 0;
            const taxBreakdown  = order.taxBreakdown && Object.keys(order.taxBreakdown).length
              ? order.taxBreakdown
              : (s.taxBreakdown || {});
            const vatAmount     = parseFloat(order.vatAmount) || parseFloat(s.vatAmount) || 0;
            const gstAmount     = parseFloat(order.gstAmount) || parseFloat(s.gstAmount) || 0;
            const costBasis = existing.costBasis || 0;
            const netRevenue = salePrice - labelCost - totalFees;

            // Skip the dispatch when nothing actually changed — avoids
            // emitting noisy sale:updated events on every routine sync.
            // Compare orderId + soldAt + buyerName too, since a new sale of
            // the SAME listing at the same price (multi-quantity case) would
            // have identical financials but a different orderId/buyer/date.
            const changed =
                 salePrice     !== (parseFloat(s.salePrice)     || 0)
              || subtotal      !== (parseFloat(s.subtotal)      || 0)
              || buyerShipping !== (parseFloat(s.buyerShipping) || 0)
              || salesTax      !== (parseFloat(s.salesTax)      || 0)
              || orderTotal    !== (parseFloat(s.orderTotal)    || 0)
              || labelCost     !== (parseFloat(s.labelCost)     || 0)
              || totalFees     !== (parseFloat(s.platformFees)  || 0)
              || vatAmount     !== (parseFloat(s.vatAmount)     || 0)
              || gstAmount     !== (parseFloat(s.gstAmount)     || 0)
              || (order.orderId || '') !== (s.id || '')
              || (order.date || '')    !== (s.soldAt || '')
              || (order.buyer || '')   !== (s.buyerName || '')
              // Force dispatch when sale.itemName is missing but the order
              // has a title — backfills the new field on legacy sale records
              // so Rebuild has a fallback when brand/model are empty.
              || (!s.itemName && (order.title || '').trim().length > 0)
              || Object.keys(itemFieldUpdates).length > 0;
            if (!changed) continue;

            // Track Finances-driven deltas specifically so the status
            // message reports what actually changed, not the total Finances
            // API row count (which is stable across syncs).
            if (bucket && totalFees !== (parseFloat(s.platformFees) || 0)) financesAdFeeUpdates++;
            if (realLabel != null && labelCost !== (parseFloat(s.labelCost) || 0)) financesLabelUpdates++;

            // Capture WHAT changed for the summary notification.
            const refreshedFields = [];
            if (totalFees     !== (parseFloat(s.platformFees)  || 0)) refreshedFields.push('fees');
            if (labelCost     !== (parseFloat(s.labelCost)     || 0)) refreshedFields.push('label');
            if (salePrice     !== (parseFloat(s.salePrice)     || 0)) refreshedFields.push('sale price');
            if ((order.orderId || '') !== (s.id || ''))               refreshedFields.push('order id');
            if (refreshedFields.length || Object.keys(itemFieldUpdates).length) {
              summaryLists.refreshedSales.push({
                orderId: order.orderId || s.id,
                title:   order.title || existing.model || '',
                fields:  refreshedFields,
              });
            }

            dispatch({
              type: 'UPDATE_ITEM', id: itemId,
              updates: {
                ...itemFieldUpdates,
                sale: {
                  ...s,
                  id: order.orderId || s.id,
                  itemName: (order.title || '').trim() || s.itemName || null,
                  soldAt: order.date || s.soldAt,
                  buyerName: order.buyer || s.buyerName || '',
                  salePrice,
                  subtotal,
                  buyerShipping,
                  salesTax,
                  taxBreakdown,
                  vatAmount,
                  gstAmount,
                  orderTotal,
                  labelCost,
                  shippingCost: labelCost,
                  labelCostKnown: realLabel != null ? true : !!s.labelCostKnown,
                  labelCostSource,
                  platformFees: totalFees,
                  feeBreakdown: breakdown,
                  netRevenue,
                  profit: Math.round((netRevenue - costBasis) * 100) / 100,
                },
              },
            });
            continue;
          }

          const costBasis = existing?.costBasis || 0;
          // Prefer the real label cost from Finances API; fall back to the
          // ActualShippingCost estimate from GetOrders if Finances didn't have it.
          const labelCost = realLabel != null
            ? realLabel
            : (parseFloat(order.labelCost) || 0);
          const labelCostKnown = realLabel != null || !!order.labelCostKnown;
          const labelCostSource = realLabel != null ? 'finances' : 'estimate';
          const buyerShipping = orderBuyerShipping;
          const { totalFees, breakdown } = applyAdFees(
            order.ebayFees,
            order.feeBreakdown,
            bucket,
          );
          const netRevenue = orderTotalRevenue - labelCost - totalFees;
          // Newly-marked-sold items count as Finances updates if Finances
          // data was applied at all (since this is the first time we're
          // recording any of it for this sale).
          if (bucket)            financesAdFeeUpdates++;
          if (realLabel != null) financesLabelUpdates++;
          const newSaleObj = {
            id: order.orderId, platform: 'ebay',
            // Capture the eBay listing title on the sale record itself.
            // Survives even if the user later edits the inventory item's
            // brand/model fields, and gives Rebuild a stable fallback
            // when those fields are empty.
            itemName: (order.title || '').trim() || null,
            salePrice: orderTotalRevenue,             // seller revenue (excl. tax) — reconciled for eIS
            subtotal: order.subtotal || 0,            // items only
            buyerShipping,
            salesTax: parseFloat(order.salesTax) || 0,// eBay-remitted, not seller's
            taxBreakdown: order.taxBreakdown || {},
            vatAmount: parseFloat(order.vatAmount) || 0,
            gstAmount: parseFloat(order.gstAmount) || 0,
            orderTotal: orderOrderTotal,
            labelCost,
            labelCostKnown,
            labelCostSource,
            shippingCost: labelCost,
            platformFees: totalFees,
            feeBreakdown: breakdown,
            netRevenue,
            profit: Math.round((netRevenue - costBasis) * 100) / 100,
            soldAt: order.date, buyerName: order.buyer || '',
          };
          dispatch({
            type: 'UPDATE_ITEM', id: itemId,
            updates: {
              status: 'sold',
              ...itemFieldUpdates,
              sale: newSaleObj,
            },
          });
          // Auto-created stubs were just added in this same render cycle;
          // AppContext's prevState snapshot doesn't include them, so its
          // sale:recorded emission misses. Re-fire here so bookkeeping
          // creates auto rows. The handler dedupes via importId — a
          // duplicate emission for non-auto items is a safe no-op.
          if (autoCreatedIds.has(itemId)) {
            const stubBrand = itemFieldUpdates.brand || (existing && existing.brand) || '';
            const stubModel = itemFieldUpdates.model || (existing && existing.model) || '';
            const stubSku   = itemFieldUpdates.serialNumber
                            || (existing && (existing.sku || existing.serialNumber))
                            || order.sku || '';
            eventBus.emit('sale:recorded', {
              itemId,
              lotId: EBAY_SYNC_LOT_ID,
              sale: newSaleObj,
              brand: stubBrand,
              model: stubModel,
              sku: stubSku,
            });
            summaryLists.autoCreated.push({
              orderId: order.orderId,
              title:   order.title || '',
              sku:     order.sku || '',
              gross:   Number(order.totalRevenue) || Number(order.orderTotal) || 0,
            });
          } else {
            summaryLists.newSales.push({
              orderId: order.orderId,
              title:   order.title || (existing?.model || ''),
              sku:     order.sku || existing?.serialNumber || '',
              gross:   Number(order.totalRevenue) || Number(order.orderTotal) || 0,
            });
          }
          soldCount++;
        }
      }


      // ── Step 3: P&L sales sync ───────────────────────────────────────────────
      setStatus('Syncing P&L sales…');
      const existingSales = await window.storage.get(KEY_SALES).catch(() => []) || [];
      const existingKeys  = new Set(existingSales.map((s) => `${s.orderId}|${s.sku}`));
      const pnlLots       = lots.map((l) => ({ ...l, skuPrefix: overlay[l.id]?.skuPrefix || '', skuSuffix: overlay[l.id]?.skuSuffix || '' }));

      if (ordersData.success) {
        const newRows = (ordersData.orders || [])
          .filter((o) => !existingKeys.has(`${o.orderId}|${o.sku}`))
          .map((o) => ({ ...o, id: crypto.randomUUID(), source: 'api', lotId: null }));
        const matched = matchSalesToLots(newRows, pnlLots, overlay);
        const merged  = [...existingSales, ...matched];
        await window.storage.set(KEY_SALES, merged);
      }

      const now = new Date().toISOString();
      setLastSyncedAt(now);
      await window.storage.set(KEY_LAST_SYNC, now).catch(e => console.error('[useSyncAll] last sync save failed:', e));

      // Persist the skipped-orders log. Replaced (not appended) each sync
      // so it always reflects the current sync's view — the same orders
      // are replayed every sync until they get matched. eBay Match reads
      // this log to surface the gap.
      await window.storage.set('noltech:sync:skipped-orders', {
        syncedAt: now,
        orders: skippedOrders,
      }).catch(e => console.error('[useSyncAll] skipped-orders save failed:', e));

      // Persist the full sync summary (one source of truth for the toast,
      // a future "last sync details" panel, and any audit needs).
      const fullSummary = {
        syncedAt: now,
        counts: {
          newListings:     summaryLists.newListings.length,
          updatedListings: summaryLists.updatedListings.length,
          newSales:        summaryLists.newSales.length,
          refreshedSales:  summaryLists.refreshedSales.length,
          autoCreated:     summaryLists.autoCreated.length,
          skipped:         skippedOrders.length,
          adFeeUpdates:    financesAdFeeUpdates,
          labelUpdates:    financesLabelUpdates,
        },
        ...summaryLists,
        skipped: skippedOrders,
      };
      await window.storage.set('noltech:sync:last-summary', fullSummary)
        .catch(e => console.error('[useSyncAll] last-summary save failed:', e));

      // Build the message line — a punchy one-liner of what changed. Skip
      // empty buckets so the toast doesn't read like "0 added · 0 updated".
      const messageParts = [];
      if (fullSummary.counts.newListings)     messageParts.push(`${fullSummary.counts.newListings} new listing${fullSummary.counts.newListings !== 1 ? 's' : ''}`);
      if (fullSummary.counts.updatedListings) messageParts.push(`${fullSummary.counts.updatedListings} updated`);
      if (fullSummary.counts.newSales)        messageParts.push(`${fullSummary.counts.newSales} new sale${fullSummary.counts.newSales !== 1 ? 's' : ''}`);
      if (fullSummary.counts.refreshedSales)  messageParts.push(`${fullSummary.counts.refreshedSales} sale${fullSummary.counts.refreshedSales !== 1 ? 's' : ''} refreshed`);
      if (fullSummary.counts.autoCreated)     messageParts.push(`${fullSummary.counts.autoCreated} auto-created`);
      if (fullSummary.counts.skipped)         messageParts.push(`${fullSummary.counts.skipped} skipped`);
      const totalChanges = Object.values(fullSummary.counts).reduce((s, n) => s + n, 0)
                         - fullSummary.counts.adFeeUpdates // these are aggregate counts, not per-row
                         - fullSummary.counts.labelUpdates;

      // ONE notification per sync — clickable to open the detail modal.
      // Type bumps to warning when something was skipped (user action
      // needed) but stays "success" when everything matched cleanly.
      eventBus.emit('notification:push', {
        id: `sync-summary-${Date.now()}`,
        type: fullSummary.counts.skipped > 0 ? 'warning' : 'success',
        title: 'Sync All complete',
        message: messageParts.length
          ? messageParts.join(' · ') + ' — click for details'
          : 'No changes since last sync',
        details: { kind: 'sync-summary', summary: fullSummary },
        duration: 8000,
        ts: now,
      });
      // Status tail reflects what THIS SYNC actually changed, not the total
      // Finances API row count. The API returns the same ~95 days of data
      // every sync; reporting that count made every sync look like fresh
      // updates were happening even when nothing moved.
      let finTail = '';
      if (!creds.oauthUserToken) {
        finTail = ' · no OAuth token — ad fees + real label costs skipped';
      } else if (financesAdFeeUpdates > 0 || financesLabelUpdates > 0) {
        finTail = ' · ' + [
          financesAdFeeUpdates > 0 ? `refreshed ad fees on ${financesAdFeeUpdates}` : null,
          financesLabelUpdates > 0 ? `refreshed label costs on ${financesLabelUpdates}` : null,
        ].filter(Boolean).join(' · ');
      } else if (adFeeStats.orders === 0 && labelStats.orders === 0) {
        finTail = ' · no ad fees or label charges in last 95 days';
      } else {
        // Finances data exists but nothing new to apply — already up to date
        finTail = ' · ad fees + label costs already in sync';
      }
      const autoTail = autoCreatedCount > 0
        ? ` · ${autoCreatedCount} auto-created from old orders`
        : '';
      const skippedTail = skippedOrders.length > 0
        ? ` · ${skippedOrders.length} skipped (no SKU or item ID)`
        : '';
      setStatus(`Done — ${added} new listings, ${updated} updated, ${soldCount} marked sold${autoTail}${skippedTail}${finTail}.`);
      // Let cash-flow / payouts UI know fresh eBay data is available so it
      // can re-pull payouts + funds summary instead of serving the 30-min
      // cached snapshot.
      eventBus.emit('sync:all-complete', { at: now });
      setTimeout(() => setStatus(''), 12000);
    } catch (err) {
      setStatus(`Sync failed: ${err.message}`);
      setTimeout(() => setStatus(''), 12000);
    } finally {
      setSyncing(false);
    }
  }, [state.lots, overlay, dispatch]);

  return { syncAll, syncing, status, lastSyncedAt, lastSyncSource };
}

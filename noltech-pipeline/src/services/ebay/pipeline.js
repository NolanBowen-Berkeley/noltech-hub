// ─── Pipeline — orchestrates one full sync tick ──────────────────────────────
// Top-level call from src/index.js. Returns a structured summary that gets
// persisted to sync_state.last_summary AND returned to the HTTP /run caller.

import { getEbayAccessToken } from './ebayAuth.js';
import { fetchActiveListings, fetchOrders } from './ebayTrading.js';
import { fetchFinancesTransactions } from './ebayFinances.js';
import { aggregateFinances, applyAdFees } from './financesAggregate.js';
import { buildMatchMaps, matchOrder, buildStubItem, EBAY_SYNC_LOT_ID } from './matching.js';
import {
  ensureEbaySyncLot, upsertItems, insertFinancesEvents,
  insertRefundTransactions, upsertSyncState, upsertAgentHeartbeat,
} from './persist.js';

// Round-to-cents helper used in every sale calc.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Detect whether a Trading API order is eIS (eBay International Shipping).
// useSyncAll uses these signals — mirror them so the Worker overrides
// labelCost / buyerShipping with Finances values for these orders.
function isEIS(order) { return !!order.isInternationalForwarding; }

// Build the canonical sale jsonb from a (matched item OR stub) + order +
// finances enrichments. Mirrors useSyncAll.js:734-839 logic.
function buildSaleObject({ order, labelOverride, feeBreakdown, feeTotal }) {
  const labelCost = labelOverride != null ? labelOverride
                  : (order.labelCost || 0);
  const labelCostKnown = labelOverride != null ? true : !!order.labelCostKnown;
  const buyerShipping = isEIS(order) && labelOverride != null
    ? labelOverride
    : (order.buyerShipping || 0);
  const orderTotal = order.orderTotal || 0;
  const grossSale = (order.price || 0) * (order.qty || 1);
  const totalRevenue = grossSale + buyerShipping;
  const netRevenue = r2(totalRevenue - (feeTotal || 0) - labelCost);
  return {
    id:               order.orderId,
    transactionId:    order.transactionId || null,
    salePrice:        r2(grossSale),
    qty:              order.qty || 1,
    buyerShipping:    r2(buyerShipping),
    labelCost:        r2(labelCost),
    labelCostKnown,
    labelCostSource:  labelOverride != null ? 'finances' : (labelCostKnown ? 'trading-api' : 'estimate'),
    salesTax:         r2(order.salesTax || 0),
    subtotal:         r2(order.subtotal || 0),
    orderTotal:       r2(orderTotal),
    platformFees:     r2(feeTotal || 0),
    feeBreakdown:     feeBreakdown || {},
    netRevenue,
    profit:           null, // unset — Hub computes with cost basis
    soldAt:           order.date,
    buyerName:        order.buyer || '',
    platform:         'ebay',
    itemName:         order.title || '',
    sku:              order.sku || null,
  };
}

export async function runSync({ env, supabase }) {
  const workspaceId = env.WORKSPACE_ID;
  const startTs = Date.now();
  const summary = {
    started_at: new Date(startTs).toISOString(),
    listings_synced: 0,
    orders_processed: 0,
    sale_updates: 0,
    new_sales: 0,
    stubs_created: 0,
    finances_events_recorded: 0,
    refund_rows_written: 0,
    skipped_orders: [],
    phase_errors: {},
    api_calls: { listings: 0, orders: 0, finances: 0, oauth: 0 },
    duration_ms: 0,
  };

  if (!workspaceId) {
    return { ok: false, error: 'WORKSPACE_ID missing', summary };
  }

  // Advisory concurrent-run guard — skip if another tick started within the
  // last RUN_LOCK_TIMEOUT_SEC and hasn't completed.
  //
  // CAVEAT: this is NOT atomic. Two Worker instances (or a Worker + a
  // simultaneous Hub Sync All if the Hub ever starts writing sync_state.
  // run_started_at) could both pass the check, both write run_started_at,
  // and both proceed. The downstream writes are idempotent (UPSERTs keyed
  // on id / unique constraints), so the worst case is wasted eBay quota
  // plus a race on the final sync_state row write — last writer wins.
  // For atomic locking, wrap this in a pg_try_advisory_lock RPC; deferred
  // because no Hub-side path currently writes run_started_at.
  try {
    const lockTimeout = Number(env.RUN_LOCK_TIMEOUT_SEC || 300);
    const { data: state } = await supabase
      .from('sync_state').select('run_started_at, last_run_at')
      .eq('workspace_id', workspaceId).maybeSingle();
    if (state?.run_started_at) {
      const startedAt = new Date(state.run_started_at).getTime();
      const lastRunAt = state.last_run_at ? new Date(state.last_run_at).getTime() : 0;
      const stillRunning = startedAt > lastRunAt
        && (Date.now() - startedAt) < lockTimeout * 1000;
      if (stillRunning) {
        console.log('[ebay-sync] skipping tick — previous run started', Math.round((Date.now() - startedAt)/1000), 's ago');
        return { ok: true, status: 'skipped_concurrent_run', summary };
      }
    }
  } catch (e) { console.error('[ebay-sync] run-lock check skipped:', e.message); }

  // Mark run started + emit heartbeat so the Hub sees activity.
  await upsertSyncState({ supabase, workspaceId, patch: { run_started_at: new Date().toISOString(), last_run_status: 'running' } });
  await upsertAgentHeartbeat({ supabase, workspaceId, status: 'running', summary: { started_at: summary.started_at } });

  // Ensure the catch-all stub lot exists before any item upserts can need it.
  await ensureEbaySyncLot({ supabase, workspaceId, lotId: EBAY_SYNC_LOT_ID });

  // ── Phase 1: OAuth token ──
  let accessToken = null;
  try {
    const t = await getEbayAccessToken({ env, supabase, workspaceId });
    accessToken = t.accessToken;
    if (t.source === 'fresh') summary.api_calls.oauth = 1;
  } catch (e) {
    console.error('[ebay-sync] phase=oauth error:', e.message);
    summary.phase_errors.oauth = String(e.message).slice(0, 1000);
    // Continue — listings + orders use Trading API user token, not OAuth.
  }

  // ── Phase 2: Active listings ──
  // Pass OAuth token so GetMyeBaySelling authenticates via X-EBAY-API-IAF-TOKEN
  // (auto-refreshing) instead of the legacy EBAY_USER_TOKEN (~18-month rotation).
  let listings = [];
  try {
    const r = await fetchActiveListings(env, { accessToken });
    listings = r.listings;
    summary.api_calls.listings = r.calls;
    summary.listings_synced = listings.length;
  } catch (e) {
    console.error('[ebay-sync] phase=listings error:', e.message);
    summary.phase_errors.listings = String(e.message).slice(0, 1000);
  }

  // Items currently in Supabase keyed by ebay_item_id, so we can detect
  // new-vs-existing listings and upsert with the right fields.
  let existingListingsByItemId = new Map();
  if (listings.length) {
    try {
      const itemIds = listings.map((l) => l.itemId).filter(Boolean);
      if (itemIds.length) {
        const { data } = await supabase
          .from('items').select('id, ebay_item_id, lot_id, brand, model, status')
          .eq('workspace_id', workspaceId).in('ebay_item_id', itemIds);
        for (const it of (data || [])) existingListingsByItemId.set(String(it.ebay_item_id), it);
      }
    } catch (e) { console.error('[ebay-sync] existing-listings lookup failed:', e.message); }
  }

  const listingItemsToUpsert = [];
  for (const l of listings) {
    const existing = existingListingsByItemId.get(String(l.itemId));
    if (existing) {
      // The items table has NO `title` column (Hub stores eBay titles in
      // `model`) and NO `watch_count` column (the Hub tracks it in
      // IndexedDB-only, not synced to cloud). Drop both. Only backfill
      // `model` when brand+model are both empty so the Worker doesn't
      // clobber user-customized names.
      listingItemsToUpsert.push({
        id: existing.id,
        workspace_id: workspaceId,
        listing_price: l.currentPrice,
        ebay_item_id: l.itemId,
        sku: l.sku || null,
        updated_at: new Date().toISOString(),
        ...((!existing.brand && !existing.model && l.title) ? { model: l.title, brand: '' } : {}),
      });
    } else {
      // New listing → fresh stub item parked in the EBAY_SYNC_LOT for visibility.
      // No watch_count column — see comment above.
      listingItemsToUpsert.push({
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        lot_id: EBAY_SYNC_LOT_ID,
        serial_number: l.sku || null,
        sku: l.sku || null,
        ebay_item_id: l.itemId,
        brand: '',
        model: l.title || '',
        category: 'other',
        status: 'listed',
        condition_on_arrival: 'unknown',
        cost_basis: 0,
        listing_price: l.currentPrice,
        date_added: l.startTime || new Date().toISOString(),
        notes: `origin=ebay-listing-stub auto_created_at=${new Date().toISOString()}`,
        updated_at: new Date().toISOString(),
      });
    }
  }

  // ── Phase 3: Orders ──
  // OAuth IAF Bearer auth — same rationale as listings.
  let orders = [];
  try {
    const r = await fetchOrders(env, {
      accessToken,
      lookbackDays: Number(env.ORDERS_LOOKBACK_DAYS || 89),
      maxPages:     Number(env.MAX_ORDER_PAGES || 10),
    });
    orders = r.orders;
    summary.api_calls.orders = r.calls;
    summary.orders_processed = orders.length;
  } catch (e) {
    console.error('[ebay-sync] phase=orders error:', e.message);
    summary.phase_errors.orders = String(e.message).slice(0, 1000);
  }

  // ── Phase 4: Finances API (best-effort — partial sync continues without it) ──
  let financesTxs = [];
  let labelCostByOrderId = {}, adFeesByOrderId = {}, refundEvents = [];
  if (accessToken) {
    try {
      const r = await fetchFinancesTransactions({
        accessToken,
        lookbackDays: Number(env.FINANCES_LOOKBACK_DAYS || 95),
        maxPages:     Number(env.MAX_FINANCES_PAGES || 10),
      });
      financesTxs = r.transactions;
      summary.api_calls.finances = r.calls;
    } catch (e) {
      console.error('[ebay-sync] phase=finances error:', e.message);
      summary.phase_errors.finances = String(e.message).slice(0, 1000);
    }
    const agg = aggregateFinances(financesTxs);
    labelCostByOrderId = agg.labelCostByOrderId;
    adFeesByOrderId    = agg.adFeesByOrderId;
    refundEvents       = agg.refundEvents;
  } else {
    summary.phase_errors.oauth = summary.phase_errors.oauth || 'no access token — Finances phase skipped';
  }

  // Persist raw Finances events — unique constraint handles dedup.
  if (financesTxs.length) {
    try {
      const r = await insertFinancesEvents({ supabase, workspaceId, events: financesTxs });
      summary.finances_events_recorded = r.inserted;
      if (r.errors?.length) summary.phase_errors.finances_persist = r.errors.join('; ').slice(0, 1000);
    } catch (e) {
      console.error('[ebay-sync] finances persist error:', e.message);
      summary.phase_errors.finances_persist = String(e.message).slice(0, 1000);
    }
  }

  // ── Phase 5: Match + build item upserts for orders ──
  const orderItemsToUpsert = [];
  let stubs = 0, saleUpdates = 0, newSales = 0;
  if (orders.length) {
    let maps;
    try {
      maps = await buildMatchMaps({ supabase, workspaceId, orders });
    } catch (e) {
      console.error('[ebay-sync] match-map build error:', e.message);
      summary.phase_errors.matching = String(e.message).slice(0, 1000);
      maps = { bySerial: new Map(), bySku: new Map(), byEiid: new Map(), byOrderId: new Map() };
    }

    for (const order of orders) {
      try {
        // Apply finances enrichments first so the sale row carries authoritative
        // label cost + ad-fee breakdown.
        const labelOverride = (order.orderId in labelCostByOrderId)
          ? labelCostByOrderId[order.orderId] : null;
        const bucket = adFeesByOrderId[order.orderId];
        const { totalFees, breakdown } = applyAdFees(order.ebayFees || 0, order.feeBreakdown || {}, bucket);

        const sale = buildSaleObject({
          order,
          labelOverride,
          feeBreakdown: breakdown,
          feeTotal: totalFees,
        });

        const match = matchOrder(order, maps);
        if (match) {
          orderItemsToUpsert.push({
            id: match.item.id,
            workspace_id: workspaceId,
            // Preserve lot_id by referring to the existing row — upsert with
            // partial fields keeps the rest as-is.
            status: 'sold',
            sale,
            ebay_item_id: order.ebayItemId || match.item.ebay_item_id || null,
            sku: order.sku || match.item.sku || null,
            updated_at: new Date().toISOString(),
            // Backfill brand/model from order title when missing.
            ...((!match.item.brand && !match.item.model && order.title) ? { model: order.title, brand: '' } : {}),
          });
          if (match.item.status === 'sold' && match.item.sale?.id === order.orderId) {
            saleUpdates++;
          } else {
            newSales++;
          }
        } else if (order.sku || order.ebayItemId) {
          // Either sku OR ebayItemId is sufficient to stub — matches
          // Hub useSyncAll.js:644-665. Skipping was already correct when
          // BOTH are missing (no way to re-find the stub on future syncs);
          // this comment exists so a future reader doesn't "fix" it to
          // require both.
          orderItemsToUpsert.push(buildStubItem({ workspaceId, order, saleObject: sale }));
          stubs++;
          newSales++;
        } else {
          summary.skipped_orders.push({
            orderId: order.orderId,
            date: order.date,
            title: order.title,
            gross: r2((order.price || 0) * (order.qty || 1)),
            reason: 'no SKU and no ebayItemId — cannot match or stub',
          });
        }
      } catch (e) {
        console.error(`[ebay-sync] order ${order.orderId} match error:`, e.message);
        summary.phase_errors.matching = (summary.phase_errors.matching || '') + ` ${order.orderId}:${e.message};`;
      }
    }
  }
  summary.sale_updates = saleUpdates;
  summary.new_sales = newSales;
  summary.stubs_created = stubs;

  // ── Phase 6: Item upserts (listings + orders) ──
  const allUpserts = [...listingItemsToUpsert, ...orderItemsToUpsert];
  if (allUpserts.length) {
    try {
      const r = await upsertItems({ supabase, items: allUpserts });
      if (r.errors?.length) summary.phase_errors.items_persist = r.errors.map((e) => `${e.id}:${e.error}`).join('; ').slice(0, 1000);
    } catch (e) {
      console.error('[ebay-sync] items persist error:', e.message);
      summary.phase_errors.items_persist = String(e.message).slice(0, 1000);
    }
  }

  // ── Phase 7: Refund rows ──
  if (refundEvents.length) {
    try {
      const r = await insertRefundTransactions({ supabase, workspaceId, refundEvents });
      summary.refund_rows_written = r.inserted;
      if (r.errors?.length) summary.phase_errors.refund_persist = r.errors.join('; ').slice(0, 1000);
    } catch (e) {
      console.error('[ebay-sync] refund persist error:', e.message);
      summary.phase_errors.refund_persist = String(e.message).slice(0, 1000);
    }
  }

  // ── Wrap up ──
  summary.duration_ms = Date.now() - startTs;
  const completedAt = new Date().toISOString();
  const errorCount = Object.keys(summary.phase_errors).length;
  const status = errorCount === 0 ? 'completed'
              : !accessToken ? 'partial_no_oauth'
              : 'partial_phase_failure';

  await upsertSyncState({
    supabase, workspaceId,
    patch: {
      last_run_at: completedAt,
      last_run_status: status,
      last_summary: summary,
      skipped_orders: summary.skipped_orders,
      run_started_at: null,
    },
  });
  await upsertAgentHeartbeat({ supabase, workspaceId, status, summary });

  console.log(
    `[ebay-sync] tick complete listings=${summary.listings_synced}`
    + ` orders=${summary.orders_processed}`
    + ` finances=${summary.finances_events_recorded}`
    + ` stubs=${summary.stubs_created}`
    + ` refunds=${summary.refund_rows_written}`
    + ` skipped=${summary.skipped_orders.length}`
    + ` errors=${errorCount}`
    + ` ms=${summary.duration_ms}`,
  );

  return { ok: true, status, summary };
}

// ─── Active-listings sync (Pi → Supabase) ────────────────────────────────────
// Mirrors useSyncAll's "Step 1" but writes directly to Supabase. For each
// active eBay listing:
//   • If an item with that ebay_item_id already exists in this workspace,
//     update its condition / price / notes / quantity / category.
//   • Otherwise insert a new item under the EBAY_SYNC_LOT bucket. We don't
//     try to match by SKU prefix/suffix here because that overlay is local
//     to each user's machine — the desktop app re-runs that match locally.
//
// All Supabase writes go through `upsert` with onConflict on the primary key
// (`id`). The schema's items.id is a text PK — we generate UUIDs the same
// way the desktop does (crypto.randomUUID()).
//
// Returns `{ added, updated, snapshot }` for the caller's logging /
// heartbeat. The snapshot mirrors `noltech:ebay:active-listings-snapshot`
// from the desktop in case the Pi later gets a place to persist it.

import { randomUUID } from 'node:crypto';
import { parseBrand, mapCategory, mapCondition } from '../lib/itemMapping.js';

// Stable PK for the bucket lot that auto-synced eBay items live under.
// Matches noltech-hub/src/utils/constants.js EBAY_SYNC_LOT_ID exactly.
export const EBAY_SYNC_LOT_ID = 'noltech-ebay-sync-lot';

const LISTINGS_TIMEOUT_MS = 45000;

export async function syncListings({ supabase, workspaceId, pipelineUrl, ebayCreds, logger }) {
  const params = new URLSearchParams({ userToken: ebayCreds.userToken || ebayCreds.token });
  if (ebayCreds.appId)  params.set('appId',  ebayCreds.appId);
  if (ebayCreds.devId)  params.set('devId',  ebayCreds.devId);
  if (ebayCreds.certId) params.set('certId', ebayCreds.certId);

  const listRes  = await fetch(`${pipelineUrl}/api/ebay/listings?${params}`, {
    signal: AbortSignal.timeout(LISTINGS_TIMEOUT_MS),
  });
  const listData = await listRes.json();
  if (!listData.success) {
    throw new Error(listData.error || 'Listings fetch failed');
  }

  // Pull every existing item for this workspace that has an ebay_item_id.
  // We need brand/model/etc. so we don't blow over fields the desktop has
  // populated from ItemManager.
  const { data: existingRows, error: selErr } = await supabase
    .from('items')
    .select('id, ebay_item_id, lot_id, brand, model, sku, serial_number, status, sale')
    .eq('workspace_id', workspaceId)
    .not('ebay_item_id', 'is', null);

  if (selErr) {
    throw new Error(`Supabase items SELECT failed: ${selErr.message}`);
  }

  const existingByEbayId = new Map();
  for (const row of existingRows || []) {
    existingByEbayId.set(row.ebay_item_id, row);
  }

  let added = 0;
  let updated = 0;
  const upsertBatch = [];

  for (const listing of listData.listings || []) {
    if (!listing.itemId) continue;

    const notesParts = [
      listing.conditionName || '',
      listing.watchCount   > 0 ? `${listing.watchCount} watching` : '',
      listing.hitCount     > 0 ? `${listing.hitCount} views`       : '',
      listing.quantitySold > 0 ? `${listing.quantitySold} sold`    : '',
    ].filter(Boolean);
    const notes = notesParts.join(' · ');

    const category  = listing.categoryInternal || mapCategory(listing.categoryName);
    const condition = listing.conditionId ? mapCondition(listing.conditionId, listing.conditionName) : '';
    const listingQuantity = Math.max(1, parseInt(listing.quantity) || 1);
    const listingPrice = listing.currentPrice != null ? parseFloat(listing.currentPrice) : null;

    const existing = existingByEbayId.get(listing.itemId);

    if (existing) {
      // Update path — keep the existing PK, lot_id, brand, model. Only
      // refresh the eBay-derived fields. (listingQuantity has no column in
      // the items table per migration 001 — the desktop pushes it through
      // app-state only. We omit it here and accept that until a migration
      // adds it.)
      upsertBatch.push({
        id: existing.id,
        workspace_id: workspaceId,
        lot_id: existing.lot_id || EBAY_SYNC_LOT_ID,
        brand: existing.brand,
        model: existing.model,
        category,
        serial_number: existing.serial_number,
        sku: existing.sku,
        status: existing.status || 'listed',
        condition_on_arrival: condition,
        ebay_item_id: listing.itemId,
        listing_price: listingPrice,
        notes,
        // Preserve sale on already-sold items — listings sync only touches
        // active listings, but a multi-quantity listing may overlap with a
        // sold inventory record sharing the same ebay_item_id.
        sale: existing.sale,
        updated_at: new Date().toISOString(),
      });
      updated++;
    } else {
      const newId = randomUUID();
      const dateAdded = listing.startTime?.slice(0, 10) || new Date().toISOString().slice(0, 10);
      upsertBatch.push({
        id: newId,
        workspace_id: workspaceId,
        lot_id: EBAY_SYNC_LOT_ID,
        brand: parseBrand(listing.title),
        model: listing.title || '',
        category,
        serial_number: listing.sku || '',
        sku: listing.sku || null,
        status: 'listed',
        condition_on_arrival: condition,
        ebay_item_id: listing.itemId,
        listing_price: listingPrice,
        date_added: dateAdded,
        notes,
        sale: null,
        updated_at: new Date().toISOString(),
      });
      added++;
    }
  }

  if (upsertBatch.length) {
    // Supabase has a default 1000-row limit per upsert call; chunk to be safe.
    const CHUNK = 500;
    for (let i = 0; i < upsertBatch.length; i += CHUNK) {
      const chunk = upsertBatch.slice(i, i + CHUNK);
      const { error: upErr } = await supabase
        .from('items')
        .upsert(chunk, { onConflict: 'id' });
      if (upErr) {
        throw new Error(`Supabase items UPSERT failed: ${upErr.message}`);
      }
    }
  }

  // Build the same authoritative snapshot the desktop persists, in case the
  // caller wants to push it to a workspace_settings column later.
  const listings = (listData.listings || []).map((l) => {
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

  logger?.info({ added, updated, totalListings: listings.length, totalUnits, totalValue: snapshot.totalValue }, '[listings] sync complete');

  return { added, updated, snapshot };
}

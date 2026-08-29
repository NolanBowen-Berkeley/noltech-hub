// ─── Sold-comps cloud pull ────────────────────────────────────────────────
// Reads UPC-tagged sold_comps rows from Supabase and merges them into the
// Hub's local IndexedDB UPC cache. Closes the gap where AWS-side scrapes
// (manifest-pricer cron + sold-comps Lambda) populate the cloud cache but
// the Hub's UPC panel never sees those rows because the local scraper
// hasn't independently looked them up.
//
// Without this, users have to click "Reprice" / "Re-run pricing" to get
// fresh prices into local view — even when the Lambda already has them.
//
// Schema reference: see supabase/migrations/015_sold_comps_upc.sql for the
// `upc` column. Rows whose `upc` is null are skipped (those came from
// brand+model queries the warmer fires; not addressable by UPC).

import { supabase, isCloudEnabled, getActiveWorkspace } from './supabase';
import { mergeUpcCache } from '../utils/upcCacheMerge';

const UPC_CACHE_KEY = 'noltech:arbitrage:upc-cache';

// How far back to look — we don't want to pull the entire history every
// time, just what's been added since the last successful pull. Stored
// in IndexedDB so it survives reloads.
const LAST_PULL_KEY = 'noltech:soldcomps:last-pull-at';

// Page size for Supabase queries — keep small enough to not stress the
// browser. The query is server-side filtered (workspace + upc IS NOT NULL
// + scraped_at > X) so the actual data transferred is small.
const PAGE_SIZE = 500;

/**
 * Pull UPC-tagged sold_comps from Supabase that are newer than our last
 * pull, transform to UPC-cache shape, merge into local cache.
 *
 * @param {{ force?: boolean }} [opts] — force=true ignores last-pull cursor
 * @returns {Promise<{ pulled: number, merged: number, skipped: number, error?: string }>}
 */
export async function pullSoldCompsByUpc({ force = false } = {}) {
  if (!isCloudEnabled) {
    return { pulled: 0, merged: 0, skipped: 0, error: 'cloud-disabled' };
  }

  try {
    // getActiveWorkspace returns the workspace ID as a STRING (not an
    // object). Older versions stored it as an object; tolerate both.
    const raw = await getActiveWorkspace();
    const workspaceId = typeof raw === 'string' ? raw : raw?.workspace_id;
    if (!workspaceId) {
      return { pulled: 0, merged: 0, skipped: 0, error: 'no-workspace' };
    }

    // Determine where to start scanning from. On first run, pull
    // everything ever scraped (the user wants the full backfill). After
    // that, only newer rows.
    let sinceIso = null;
    if (!force) {
      try {
        sinceIso = (await window.storage.get(LAST_PULL_KEY)) || null;
      } catch {}
    }

    // Page through results. Supabase's default response limit is 1000;
    // we use 500 per page to be safe.
    let pageOffset = 0;
    let totalPulled = 0;
    const cloudCache = {};   // upc → cache entry, accumulated across pages
    let latestScrapedAt = sinceIso;

    for (;;) {
      let query = supabase
        .from('sold_comps')
        .select('upc, query, count, median_price, low_price, high_price, scraped_at')
        .eq('workspace_id', workspaceId)
        .not('upc', 'is', null)
        .order('scraped_at', { ascending: false })
        .range(pageOffset, pageOffset + PAGE_SIZE - 1);
      if (sinceIso) query = query.gt('scraped_at', sinceIso);

      const { data, error } = await query;
      if (error) {
        return { pulled: totalPulled, merged: 0, skipped: 0, error: error.message };
      }
      if (!data || data.length === 0) break;

      for (const row of data) {
        if (!row.upc || !/^\d{12,13}$/.test(row.upc)) continue;
        // Convert sold_comps row → UPC cache entry. Use median_price as
        // avgPrice (the local cache field) since that's what the rest of
        // the Hub displays and it's more robust than a true mean.
        const existing = cloudCache[row.upc];
        const isNewer = !existing || new Date(row.scraped_at) > new Date(existing.cachedAt || 0);
        if (isNewer) {
          cloudCache[row.upc] = {
            title: row.query || '',
            avgPrice: row.median_price ?? null,
            lowPrice: row.low_price ?? null,
            highPrice: row.high_price ?? null,
            numSales: row.count || 0,
            priceSource: 'sold-comps-cloud',
            cachedAt: row.scraped_at,
          };
        }
        if (!latestScrapedAt || row.scraped_at > latestScrapedAt) {
          latestScrapedAt = row.scraped_at;
        }
        totalPulled++;
      }

      if (data.length < PAGE_SIZE) break;
      pageOffset += PAGE_SIZE;
      // Safety cap so a runaway query can't infinite-page.
      if (pageOffset > 50_000) break;
    }

    // Nothing new
    if (totalPulled === 0) {
      return { pulled: 0, merged: 0, skipped: 0 };
    }

    // Merge into local IndexedDB cache, preserving local fields where
    // they should win (cleanTitle, manual category overrides, etc.).
    const local = (await window.storage.get(UPC_CACHE_KEY)) || {};
    const sizeBefore = Object.keys(local).length;
    const merged = mergeUpcCache(local, cloudCache);
    const sizeAfter = Object.keys(merged).length;
    await window.storage.set(UPC_CACHE_KEY, merged);

    // Advance cursor so next pull starts from the freshest row we saw.
    if (latestScrapedAt) {
      try {
        await window.storage.set(LAST_PULL_KEY, latestScrapedAt);
      } catch {}
    }

    return {
      pulled: totalPulled,
      merged: sizeAfter - sizeBefore,
      skipped: totalPulled - (sizeAfter - sizeBefore),
      latestScrapedAt,
    };
  } catch (e) {
    return { pulled: 0, merged: 0, skipped: 0, error: e?.message || String(e) };
  }
}

/**
 * Reset the pull cursor so the next pull does a full scan from time zero.
 * Used when the user clicks "Force full sync" or after restoring from a
 * snapshot when we want to repopulate from scratch.
 */
export async function resetSoldCompsPullCursor() {
  try {
    await window.storage.delete?.(LAST_PULL_KEY);
  } catch {
    try { await window.storage.set(LAST_PULL_KEY, null); } catch {}
  }
}

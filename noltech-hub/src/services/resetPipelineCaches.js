// ─── Reset scraper caches ────────────────────────────────────────────────────
// Orchestrator for the "nuke all scraper state" button in Settings → Data
// Backup. Wipes three tiers:
//
//   1. Local IndexedDB    — browse-lots, upc-cache, lot-history, etc.
//   2. Pipeline disk cache — search results, manifests, upc pricing, images.
//                            Skipped if the pipeline isn't running.
//   3. Supabase sold_comps — cache rows per active workspace.
//
// User-created data (watchlist, notes, saved searches, components) is NEVER
// touched. See LOCAL_CACHE_KEYS / LOCAL_USER_KEYS_KEEP below.

import { pipelineFetch } from './pipelineFetch';
import { supabase, isCloudEnabled as isSupabaseEnabled, getActiveWorkspace } from './supabase';

// Scraper-derived caches — safe to wipe. If you add a new scraper-owned key,
// list it here so this reset actually clears it.
export const LOCAL_CACHE_KEYS = [
  'noltech:arbitrage:browse-lots',
  'noltech:arbitrage:upc-cache',
  'noltech:arbitrage:upc-cache-pruned-at',
  'noltech:arbitrage:lot-history',
  'noltech:arbitrage:liq-close-ratios',
  'noltech:arbitrage:ai-summaries',
  'noltech:arbitrage:imported-lots',
  'noltech:arbitrage:browse-view-mode',
];

// User-created data that MUST NOT be wiped. Listed here for grep-ability so a
// future contributor can't accidentally pull one in.
export const LOCAL_USER_KEYS_KEEP = [
  'noltech:arbitrage:watchlist',
  'noltech:arbitrage:lot-notes',
  'noltech:arbitrage:bids',
  'noltech:arbitrage:components',
  'noltech:arbitrage:won-manifests',
  'noltech:arbitrage:saved-searches',
];

async function clearLocalCaches() {
  let cleared = 0;
  let failed = 0;
  const errors = [];
  for (const key of LOCAL_CACHE_KEYS) {
    try {
      // window.storage.delete removes the row; if not present it's a no-op.
      const existed = (await window.storage.get(key)) != null;
      await window.storage.delete(key);
      if (existed) cleared++;
    } catch (e) {
      failed++;
      errors.push(`${key}: ${e?.message || 'delete failed'}`);
    }
  }
  return { cleared, failed, errors };
}

// Clears the pipeline's on-disk caches (the local replacements for the old
// Cloudflare KV namespace and R2 bucket). The scope names are unchanged —
// routes/admin.js still keys on them.
async function flushWorkerCaches() {
  try {
    const res = await pipelineFetch('/admin/flush-caches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['kv-search', 'kv-manifest', 'kv-upc', 'r2-images'] }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `Pipeline returned ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    return { deleted: data?.deleted || {}, total: data?.total || 0 };
  } catch (e) {
    // Most likely the pipeline isn't running. That's a skip, not a failure —
    // there are no caches to clear if the service is down.
    return { skipped: true, reason: `Pipeline unreachable (${e?.message || 'no response'})` };
  }
}

// Every Supabase table that holds scraper- or analyzer-derived data. Wiping
// any one alone leaves stale data hydrating in through another path — e.g.
// clearing `sold_comps` still lets `lot_analyses` populate priced items on
// Fetch via analysisEnrichmentLoader.js, and clearing `lot_analyses` still
// lets `browse_lots` rehydrate the Hub via its every-2-minute cloud poll.
const SUPABASE_CACHE_TABLES = [
  'sold_comps',              // per-query sold-comps cache
  'lot_analyses',            // cron's per-lot analysis with item_results
  'liquidation_manifests',   // cached manifest items
  'liquidation_lots_newegg', // cron-discovered lots (feeds analysis queue)
  'lot_analysis_queue',      // pending items for auto-analyze cron
  'browse_lots',             // cloud-synced lot list Hub polls every 2 min
  'partout_cache',           // desktop decomposition cache (may not exist)
  'analysis_costs',          // per-day cost log
];

async function flushSupabaseCaches() {
  if (!isSupabaseEnabled || !supabase) {
    return { skipped: true, reason: 'Cloud sync not configured' };
  }
  try {
    const wsId = await getActiveWorkspace();
    if (!wsId) return { skipped: true, reason: 'No active workspace' };

    const perTable = {};
    let total = 0;
    const errors = [];
    for (const table of SUPABASE_CACHE_TABLES) {
      try {
        const { data, error, count } = await supabase
          .from(table)
          .delete({ count: 'exact' })
          .eq('workspace_id', wsId)
          .select('workspace_id');
        if (error) {
          // Table might not exist in this workspace's schema; log but continue.
          errors.push(`${table}: ${error.message}`);
          perTable[table] = 0;
        } else {
          const n = count ?? data?.length ?? 0;
          perTable[table] = n;
          total += n;
        }
      } catch (e) {
        errors.push(`${table}: ${e?.message || 'delete failed'}`);
        perTable[table] = 0;
      }
    }
    return { deleted: total, perTable, errors: errors.length ? errors : undefined };
  } catch (e) {
    return { error: e?.message || 'Supabase delete failed' };
  }
}

/**
 * Run the full reset. Best-effort: partial success is reported.
 *
 * @returns {Promise<{local, worker, supabase}>}
 */
export async function resetAllScraperCaches() {
  const [local, worker, supabaseResult] = await Promise.all([
    clearLocalCaches(),
    flushWorkerCaches(),
    flushSupabaseCaches(),
  ]);
  return { local, worker, supabase: supabaseResult };
}

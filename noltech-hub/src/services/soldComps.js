// ─── Sold Comps Service ───────────────────────────────────────────────────────
// Looks up recent eBay sold-listing data for arbitrary product queries.
//
// Pipeline:
//   1. Read-through cache lives in Supabase table `sold_comps`
//      (workspace_id + cache_key → aggregate stats + sample listings).
//      No TTL — any cached row is returned as-is. Callers that want a fresh
//      scrape pass { forceRefresh: true }. The Lambda still rewrites the row
//      on every refresh, so manual refreshes always replace old data.
//   2. On cache miss, POST the query to an AWS Lambda Function URL.
//      The Lambda scrapes via Bright Data, writes the row, and returns it.
//   3. The Hub gets the result; realtime subscribers also see the row update
//      via Supabase Realtime so any other tab/device picks it up automatically.
//
// Settings the user must configure (Settings → Sold-Comps Service):
//   - noltech:soldcomps:lambda-url      Function URL of the deployed Lambda
//   - noltech:soldcomps:auth-secret     Shared bearer token (encrypted)
//   - noltech:soldcomps:last-success    ISO timestamp of last successful call
//
// If those keys are missing, the service still works in read-only mode against
// the existing Supabase cache (any teammate or scheduled job that DID configure
// the Lambda has already populated rows). Without Supabase configured at all,
// the panel falls back to an empty state explaining cloud sync is required.

import { supabase, isCloudEnabled, getActiveWorkspace } from './supabase';
import { decrypt } from './crypto';

// ─── Storage keys ─────────────────────────────────────────────────────────────

export const KEY_LAMBDA_URL    = 'noltech:soldcomps:lambda-url';
export const KEY_AUTH_SECRET   = 'noltech:soldcomps:auth-secret';
export const KEY_LAST_SUCCESS  = 'noltech:soldcomps:last-success';

// Lambda cold-starts can be slow; give Bright Data some headroom too.
const LAMBDA_TIMEOUT_MS = 45 * 1000;

// ─── Query normalization ──────────────────────────────────────────────────────
// Must match scrape-sold-comps/src/queryNormalize.js exactly. Both ends produce
// the same cache_key for the same human-typed input.

export function normalizeQuery(query) {
  if (typeof query !== 'string') return '';
  const stripped = query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.split(' ').sort().join(' ');
}

// Tier 39 — parser version + condition/category bake into the key so different
// parameter combinations don't collide on the same cached row. Keep in sync
// with PARSER_VERSION in scrape-sold-comps/src/handler.js.
const PARSER_VERSION = 'v3-2026-05';

export function buildCacheKey(query, soldDays = 90, condition = 'working', category = 'other') {
  const days = Number.isFinite(soldDays) && soldDays > 0 ? Math.floor(soldDays) : 90;
  const cond = condition || 'working';
  const cat = category || 'other';
  return `${normalizeQuery(query)}:${days}|${cond}|${cat}|${PARSER_VERSION}`;
}

// ─── Cache read ───────────────────────────────────────────────────────────────

/**
 * Read the cached row for a query, if any. Returns null on miss or if cloud
 * isn't configured / no active workspace. Never throws — calling code can fall
 * straight into the Lambda path when this returns null.
 */
export async function getCachedSoldComps(query, soldDays = 90, condition = 'working', category = 'other') {
  if (!isCloudEnabled || !supabase) return null;
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) return null;
  const cacheKey = buildCacheKey(query, soldDays, condition, category);
  if (!cacheKey || cacheKey.startsWith(':')) return null;

  try {
    const { data, error } = await supabase
      .from('sold_comps')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('cache_key', cacheKey)
      .maybeSingle();
    if (error) {
      console.warn('[soldComps] cache read failed:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.warn('[soldComps] cache read exception:', e?.message || e);
    return null;
  }
}

// ─── Lambda settings ──────────────────────────────────────────────────────────

async function readLambdaSettings() {
  try {
    const url    = (await window.storage.get(KEY_LAMBDA_URL))    || '';
    const secEnc = (await window.storage.get(KEY_AUTH_SECRET))   || '';
    const secret = secEnc ? await decrypt(secEnc) : '';
    return { url: String(url || '').trim(), secret: String(secret || '').trim() };
  } catch (e) {
    console.warn('[soldComps] settings read failed:', e?.message || e);
    return { url: '', secret: '' };
  }
}

export async function isLambdaConfigured() {
  const { url, secret } = await readLambdaSettings();
  return !!(url && secret);
}

// ─── Lambda call ──────────────────────────────────────────────────────────────

async function callLambda({ workspaceId, query, soldDays, condition, category, upc }) {
  const { url, secret } = await readLambdaSettings();
  if (!url || !secret) {
    const e = new Error('Lambda URL or auth secret not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }

  const ctl = AbortSignal.timeout(LAMBDA_TIMEOUT_MS);
  const payload = { workspaceId, query, soldDays };
  if (condition) payload.condition = condition;
  if (category) payload.category = category;
  if (upc) payload.upc = upc;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
    signal: ctl,
  });

  let body = null;
  try { body = await r.json(); } catch { /* non-JSON */ }

  if (!r.ok) {
    const msg = body?.error || `Lambda returned ${r.status}`;
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }

  // Bookkeep last-success so the Settings UI can display it.
  try { await window.storage.set(KEY_LAST_SUCCESS, new Date().toISOString()); } catch {}

  return body;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Shape returned to UI:
 *   {
 *     fromCache, stale, scrapedAt, count, medianPrice, lowPrice, highPrice,
 *     avgPrice, samples, query, soldDays, staleNote?
 *   }
 *
 * On Lambda failure with a stale cache available, returns the stale row plus
 * `staleNote` describing what went wrong. With no cache and no Lambda, throws.
 */
export async function fetchSoldComps(query, options = {}) {
  const {
    soldDays = 90,
    forceRefresh = false,
    // Tier 39 — when caller knows the category/condition, pass it so the
    // Lambda can route to the right eBay LH_ItemCondition filter and apply
    // category-gated noise filters (GPU no-core).
    condition = 'working',
    category = 'other',
    upc = null,
  } = options;
  const trimmed = (query || '').trim();
  if (!trimmed) {
    const e = new Error('Query is empty');
    e.code = 'EMPTY_QUERY';
    throw e;
  }
  if (!isCloudEnabled || !supabase) {
    const e = new Error('Cloud sync not configured');
    e.code = 'NO_CLOUD';
    throw e;
  }
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) {
    const e = new Error('No active workspace selected');
    e.code = 'NO_WORKSPACE';
    throw e;
  }

  // 1. Try cache first (unless forceRefresh). Any cached row hits — no TTL.
  let cached = null;
  if (!forceRefresh) {
    cached = await getCachedSoldComps(trimmed, soldDays, condition, category);
    if (cached) return shapeRow(cached, { fromCache: true, stale: false });
  } else {
    cached = await getCachedSoldComps(trimmed, soldDays, condition, category);
  }

  // 2. Cache miss (or forceRefresh) — call the Lambda.
  try {
    const lambda = await callLambda({ workspaceId, query: trimmed, soldDays, condition, category, upc });
    // Lambda either returns the row directly or { ...row }. Be liberal.
    const row = lambda?.row || lambda?.data || lambda;
    if (row && (row.cache_key || row.samples)) {
      return shapeRow(row, { fromCache: false, stale: false });
    }
    // Some Lambda implementations write to Supabase and return only a status —
    // re-read the row so the UI gets data.
    const fresh = await getCachedSoldComps(trimmed, soldDays, condition, category);
    if (fresh) return shapeRow(fresh, { fromCache: false, stale: false });
    // No row at all. Treat as empty result.
    return shapeRow(
      {
        cache_key: buildCacheKey(trimmed, soldDays, condition, category),
        query: trimmed,
        sold_days: soldDays,
        count: 0,
        samples: [],
        scraped_at: new Date().toISOString(),
      },
      { fromCache: false, stale: false },
    );
  } catch (lambdaErr) {
    // 3. Degraded path — surface whatever we have.
    if (cached) {
      return shapeRow(cached, {
        fromCache: true,
        stale: true,
        staleNote: lambdaErr.message || 'Refresh failed',
      });
    }
    // No cache, Lambda dead, nothing to show. Bubble up.
    throw lambdaErr;
  }
}

/**
 * Normalize a Supabase row OR a Lambda response into the camelCase shape the
 * UI expects. Either snake_case or camelCase keys are accepted.
 */
function shapeRow(row, { fromCache, stale, staleNote }) {
  const samples = Array.isArray(row.samples)
    ? row.samples
    : (Array.isArray(row.Samples) ? row.Samples : []);
  return {
    fromCache: !!fromCache,
    stale: !!stale,
    staleNote: staleNote || null,
    cacheKey:    row.cache_key    ?? row.cacheKey ?? null,
    query:       row.query        ?? row.Query    ?? '',
    soldDays:    row.sold_days    ?? row.soldDays ?? 90,
    count:       Number(row.count ?? samples.length ?? 0),
    medianPrice: row.median_price ?? row.medianPrice ?? null,
    lowPrice:    row.low_price    ?? row.lowPrice    ?? null,
    highPrice:   row.high_price   ?? row.highPrice   ?? null,
    avgPrice:    row.avg_price    ?? row.avgPrice    ?? null,
    samples,
    scrapedAt:   row.scraped_at   ?? row.scrapedAt   ?? null,
    scrapedBy:   row.scraped_by   ?? row.scrapedBy   ?? null,
    source:      row.source       ?? 'brightdata',
    // Tier 39 additions
    condition:   row.condition    ?? 'working',
    category:    row.category     ?? 'other',
    rawCount:    Number(row.raw_count ?? row.rawCount ?? row.count ?? samples.length ?? 0),
    rawAvgPrice: row.raw_avg_price ?? row.rawAvgPrice ?? row.avg_price ?? null,
    droppedTitle:   row.dropped_title   ?? row.droppedTitle   ?? 0,
    droppedOutlier: row.dropped_outlier ?? row.droppedOutlier ?? 0,
    parserVersion:  row.parser_version  ?? row.parserVersion  ?? null,
  };
}

// ─── Test helper for the Settings panel ───────────────────────────────────────

/**
 * Calls the Lambda with a known dummy query. Used by the "Test connection"
 * button. Returns { ok, message }.
 */
export async function testLambdaConnection() {
  if (!isCloudEnabled || !supabase) {
    return { ok: false, message: 'Cloud sync not configured (Supabase URL/key missing).' };
  }
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) {
    return { ok: false, message: 'No active workspace selected.' };
  }
  try {
    await callLambda({ workspaceId, query: 'noltech connectivity test', soldDays: 90 });
    return { ok: true, message: 'Connected. Lambda responded successfully.' };
  } catch (e) {
    return { ok: false, message: e?.message || 'Unknown error' };
  }
}

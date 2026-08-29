// ─── POST /comps/lookup ─────────────────────────────────────────────────────
// Sold-comps lookup. Replaces the standalone AWS Lambda
// (scrape-sold-comps/src/handler.js). Same request/response shape so the
// Hub's existing soldComps client works against this route with only a URL
// swap.
//
// Pipeline:
//   1. Auth + body validation
//   2. Cache lookup in sold_comps (with short TTL for count=0)
//   3. On miss: ask the configured comps provider → filter → aggregate
//      → upsert cache row
//   4. Return canonical response shape
//
// Where the comparables actually come from is the provider's business — see
// src/providers/. The default sample provider generates them; the eBay Browse
// provider queries eBay's official API. Nothing in this file scrapes.

import { ok, errors } from '../lib/response.js';
import { newTraceId } from '../lib/logger.js';
import { SupabaseError } from '../lib/errors.js';
import { getSupabase, mustOk } from '../services/supabase.js';
import { getCompsProvider, callProvider } from '../providers/index.js';
import { normalizeQuery, buildCacheKey } from '../shared/buildQuery.js';
import { filterSamplesByTitle, filterPriceOutliers, computeAggregates } from '../shared/outlierFilter.js';

// Bumped whenever the shape of a cached row changes, which invalidates every
// existing cache key rather than serving rows the current code misreads.
const PARSER_VERSION = 'v5-provider';
const TABLE = 'sold_comps';
const VALID_CONDITIONS = new Set(['working', 'for_parts', 'any']);
const VALID_CATEGORIES = new Set([
  'gpu', 'cpu', 'ram', 'storage', 'motherboard', 'psu', 'monitor',
  'laptop', 'desktop', 'keyboard', 'mouse', 'phone', 'tablet',
  'networking', 'audio', 'accessories', 'other',
]);

export async function compsLookup(request, env, ctx, log) {
  const traceId = log?.baseFields?.traceId || newTraceId();

  let body;
  try { body = await request.json(); }
  catch { return errors.badRequest(traceId, 'invalid JSON body'); }

  // Validate
  const { workspaceId, query } = body;
  if (!workspaceId || typeof workspaceId !== 'string') {
    return errors.badRequest(traceId, 'workspaceId is required');
  }
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return errors.badRequest(traceId, 'query is required');
  }

  const soldDays  = Number.isFinite(body.soldDays) && body.soldDays > 0
    ? Math.floor(body.soldDays)
    : Number(env.SOLD_COMPS_DAYS) || 90;
  const condition = VALID_CONDITIONS.has(body.condition) ? body.condition : 'any';
  const category  = VALID_CATEGORIES.has(body.category)  ? body.category  : 'other';
  const requestedBy = typeof body.requestedBy === 'string' ? body.requestedBy : 'pipeline';

  const normalized = normalizeQuery(query);
  if (!normalized) return errors.badRequest(traceId, 'query normalized to empty string');

  const cacheKey = buildCacheKey(query, { soldDays, condition, category, parserVersion: PARSER_VERSION });
  const forceRefresh = body.forceRefresh === true;

  log = log.child({ route: 'comps.lookup', cacheKey, query: query.slice(0, 60) });
  log.info('start', { condition, category, soldDays, requestedBy, forceRefresh });

  const supabase = getSupabase(env);

  // 1. Cache check — skipped when caller asks for fresh data.
  if (!forceRefresh) {
    const cached = await readCache(supabase, env, workspaceId, cacheKey);
    if (cached) {
      log.info('cache_hit', { count: cached.count });
      return ok(shapeRow(cached, { fromCache: true }), traceId);
    }
    log.info('cache_miss');
  } else {
    log.info('cache_bypassed');
  }

  // 2. Ask the configured comps provider.
  const maxResults = Number(env.SOLD_COMPS_MAX_RESULTS) || 60;
  let provider;
  try {
    provider = await getCompsProvider(env);
  } catch (e) {
    log.error('provider_unavailable', { message: e?.message });
    return errors.upstream(traceId, e?.message || 'comps provider unavailable');
  }

  const lookup = await callProvider(provider, 'lookup', env, {
    query, condition, category, soldDays, maxResults, log,
  });
  if (lookup?.supported === false) {
    log.warn('provider_unsupported', { provider: provider.id });
    return errors.upstream(traceId, lookup.error || 'comps provider cannot look up prices');
  }
  if (!lookup?.ok) {
    log.warn('provider_failed', { provider: provider.id, error: lookup?.error });
    return errors.upstream(traceId, lookup?.error || 'comps lookup failed');
  }
  const rawItems = Array.isArray(lookup.items) ? lookup.items.slice(0, maxResults) : [];
  log.info('provider_done', { provider: provider.id, rawCount: rawItems.length });

  // 3. Filter
  const titleFilter   = filterSamplesByTitle(rawItems, category);
  const outlierFilter = filterPriceOutliers(titleFilter.kept);
  const samples       = outlierFilter.kept;

  const rawAgg      = computeAggregates(rawItems);
  const filteredAgg = computeAggregates(samples);

  log.info('filter_done', {
    raw:           rawItems.length,
    droppedTitle:  titleFilter.dropped.length,
    droppedLow:    outlierFilter.droppedLow.length,
    droppedHigh:   outlierFilter.droppedHigh.length,
    final:         samples.length,
  });

  // 5. Upsert cache row
  const row = {
    workspace_id:     workspaceId,
    cache_key:        cacheKey,
    query:            query.trim(),
    sold_days:        soldDays,
    count:            filteredAgg.count,
    median_price:     filteredAgg.medianPrice,
    low_price:        filteredAgg.lowPrice,
    high_price:       filteredAgg.highPrice,
    avg_price:        filteredAgg.avgPrice,
    samples,
    scraped_at:       new Date().toISOString(),
    scraped_by:       requestedBy,
    source:           provider.sourceLabel || provider.id,
    raw_html_size:    null,
    parser_version:   PARSER_VERSION,
    condition,
    category,
    raw_count:        rawAgg.count,
    raw_avg_price:    rawAgg.avgPrice,
    dropped_title:    titleFilter.dropped.length,
    dropped_outlier:  outlierFilter.droppedLow.length + outlierFilter.droppedHigh.length,
  };

  try {
    await mustOk('sold_comps upsert', supabase
      .from(TABLE)
      .upsert(row, { onConflict: 'workspace_id,cache_key' }));
  } catch (e) {
    log.error('cache_write_failed', { message: e.message });
    if (e instanceof SupabaseError) {
      return errors.upstream(traceId, `cache write failed: ${e.message}`);
    }
    throw e;
  }

  log.info('write_done', { count: filteredAgg.count });
  return ok(shapeRow(row, { fromCache: false }), traceId);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function readCache(supabase, env, workspaceId, cacheKey) {
  const fullTtlDays = Number(env.SOLD_COMPS_FULL_TTL_DAYS) || 14;
  const emptyTtlHrs = Number(env.SOLD_COMPS_EMPTY_TTL_HRS) || 6;
  const cutoff = new Date(Date.now() - fullTtlDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('cache_key', cacheKey)
    .gte('scraped_at', cutoff)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  // Short TTL for count=0 entries.
  if ((data.count || 0) === 0) {
    const emptyCutoffMs = Date.now() - emptyTtlHrs * 60 * 60 * 1000;
    const rowMs = Date.parse(data.scraped_at || 0);
    if (Number.isFinite(rowMs) && rowMs < emptyCutoffMs) return null;
  }
  return data;
}

function shapeRow(row, { fromCache }) {
  return {
    fromCache,
    cacheKey:       row.cache_key,
    query:          row.query,
    soldDays:       row.sold_days,
    scrapedAt:      row.scraped_at,
    count:          row.count,
    medianPrice:    row.median_price,
    lowPrice:       row.low_price,
    highPrice:      row.high_price,
    avgPrice:       row.avg_price,
    samples:        row.samples || [],
    condition:      row.condition || 'any',
    category:       row.category || 'other',
    rawCount:       row.raw_count ?? row.count,
    rawAvgPrice:    row.raw_avg_price ?? row.avg_price,
    droppedTitle:   row.dropped_title ?? 0,
    droppedOutlier: row.dropped_outlier ?? 0,
    parserVersion:  row.parser_version,
  };
}

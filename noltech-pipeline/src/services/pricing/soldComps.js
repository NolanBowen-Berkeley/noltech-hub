// ─── Sold-comps Lambda client ────────────────────────────────────────────────
// Port of priceItemViaSoldComps() in scraper/server.js. Talks to the user's
// AWS scrape-sold-comps Lambda via the Hub-provided URL + bearer.
//
// Differences from the Express version:
//   - No file-backed UPC cache — uses KV via upcCache.js
//   - No cross-request semaphore — per-request concurrency is enforced by
//     mapWithConcurrency(BATCH). The Hub serializes /enrich calls per-lot
//     (one tick at a time) so the per-isolate cap is functionally global.
//   - No Browse-API UPC→title resolution (skipped for v1). The Lambda is
//     happy with `query = brand + title`; UPC is passed in the body so it
//     can use that hint server-side.

import { getUpcCacheEntry, putUpcCacheEntry, isEntryFresh } from './upcCache.js';
import { classifyCategory, mapConditionForLambda, simpleHash, stripSellerJunk } from './textUtils.js';
import { compsLookup } from '../../routes/comps.js';

const FRESH_RETRY_MAX = 2;

function buildCacheKey(upc, brand, title) {
  const cleanUpc = String(upc || '').replace(/\D/g, '');
  if (/^\d{12,13}$/.test(cleanUpc)) return cleanUpc;
  return 'kw:' + simpleHash(`${brand || ''}|${title || ''}`);
}

function buildQuery(item) {
  const t = stripSellerJunk(item.title || '');
  const b = (item.brand || '').trim();
  return b ? `${b} ${t}`.slice(0, 100) : t.slice(0, 100);
}

// Shorter query used as a fallback when the full query returns 0 sold comps.
// Drops trailing marketing/spec cruft and caps to the first ~5 meaningful
// tokens — usually brand + chipset/model + series. Examples:
//   "GIGABYTE Z890 AORUS MASTER AI TOP 1.0 LGA 1851 DDR5 ATX Motherboard with Wi-Fi 7"
//     → "GIGABYTE Z890 AORUS MASTER AI"
//   "ASRock Z790 TAICHI CARRARA LGA1700 (90-MXBL10-A0UAYZ) ATX"
//     → "ASRock Z790 TAICHI CARRARA LGA1700"
//   "MSI MPG A1000GS PCIE5, Fully Modular ATX Gaming PSU"
//     → "MSI MPG A1000GS PCIE5"
const SHORT_QUERY_STOP_RE = /\s*[,()\[\]]|\s+(?:with|for|featuring|including)\s+/i;
function buildShortQuery(item) {
  const t = stripSellerJunk(item.title || '');
  const b = (item.brand || '').trim();
  // Strip after the first comma/paren/bracket or "with"/"for" connector.
  const trimmed = t.split(SHORT_QUERY_STOP_RE)[0] || t;
  const tokens = trimmed.split(/\s+/).filter(Boolean).slice(0, 5);
  const tail = tokens.join(' ');
  // Avoid double-prefixing the brand when the title already starts with it
  // ("GIGABYTE Z890 …" + brand "GIGABYTE" → just use the title slice).
  if (!b) return tail;
  if (tail.toLowerCase().startsWith(b.toLowerCase())) return tail;
  return `${b} ${tail}`.trim();
}

// One pricing call. Hits the KV cache first; on stale/miss invokes the
// in-Worker compsLookup() route directly (NOT via fetch — Cloudflare
// blocks worker-to-self HTTP fetches with error code 1042 as a recursion
// guard, which is why this used to fail with sold_comps_http_404 even
// though the URL was correct).
//
// Returns the normalized item-pricing shape the Hub expects.
export async function priceItemViaSoldComps(item, opts, env, ctx, log) {
  // lambdaUrl + lambdaAuth from opts are now IGNORED — we always call
  // the internal /comps/lookup route. The fields are kept in the destructure
  // for signature back-compat in case any caller still passes them.
  const { workspaceId, soldDays, lotCondition, forceRefresh } = opts;
  const cacheKey = buildCacheKey(item.upc, item.brand, item.title);

  // Skip both cache layers when caller asks for fresh data — the UPC KV
  // entry AND the downstream sold_comps Supabase row.
  if (!forceRefresh) {
    const cached = await getUpcCacheEntry(env, cacheKey);
    if (cached && isEntryFresh(cached) && cached.priceSource === 'sold-comps') {
      return {
        ...cached,
        cacheKey,
        found: cached.numSales > 0 && Number.isFinite(cached.avgPrice),
        source: 'sold-comps-cache',
      };
    }
  }

  // Fresh fetch. Try the full query first; on zero comps, retry with a
  // shorter query (brand + first ~5 important tokens). Long marketing
  // titles ("GIGABYTE Z890 AORUS MASTER AI TOP 1.0 LGA 1851 DDR5 ATX
  // Motherboard with Wi-Fi 7") over-narrow eBay's search — shortened
  // variant ("GIGABYTE Z890 AORUS MASTER AI") usually finds comps.
  const fullQuery = buildQuery(item);
  if (!fullQuery || fullQuery.length < 3) {
    return { cacheKey, found: false, priceSource: 'sold-comps', avgPrice: null, lowPrice: null, highPrice: null, numSales: 0, title: null };
  }
  const shortQuery = buildShortQuery(item);

  async function attemptLookup(query, queryVariant) {
    const body = {
      workspaceId,
      query,
      upc: /^\d{12,13}$/.test(String(item.upc || '').replace(/\D/g, '')) ? String(item.upc).replace(/\D/g, '') : undefined,
      category: classifyCategory(item.title || query),
      condition: mapConditionForLambda(lotCondition),
      soldDays: Number(soldDays) || 90,
      forceRefresh: !!forceRefresh,
      requestedBy: 'noltech-scraper-worker',
    };
    let lastErr = null;
    for (let attempt = 0; attempt < FRESH_RETRY_MAX; attempt++) {
      try {
        const req = new Request('https://internal/comps/lookup', {
          method:  'POST',
          headers: {
            'content-type': 'application/json',
            authorization:  `Bearer ${env.SHARED_AUTH_SECRET || ''}`,
          },
          body: JSON.stringify(body),
        });
        const res = await compsLookup(req, env, ctx, log);
        const data = await res.json().catch(() => null);
        if (!data) { lastErr = new Error('sold_comps_invalid_response'); break; }
        if (!res.ok || !data.ok) {
          if (res.status >= 500 && attempt < FRESH_RETRY_MAX - 1) {
            await new Promise((rs) => setTimeout(rs, 1000 * (attempt + 1)));
            continue;
          }
          lastErr = new Error(`sold_comps_internal_${res.status}: ${(data.error || '').slice(0, 80)}`);
          break;
        }
        return {
          title: data.samples?.[0]?.title ? stripSellerJunk(data.samples[0].title) : null,
          avgPrice: Number.isFinite(data.medianPrice) ? Math.round(data.medianPrice * 100) / 100 : null,
          lowPrice: Number.isFinite(data.lowPrice) ? Math.round(data.lowPrice * 100) / 100 : null,
          highPrice: Number.isFinite(data.highPrice) ? Math.round(data.highPrice * 100) / 100 : null,
          numSales: Number(data.count) || 0,
          priceSource: 'sold-comps',
          upc: body.upc || null,
          cacheKey,
          found: (Number(data.count) || 0) > 0 && Number.isFinite(data.medianPrice),
          source: data.fromCache ? 'sold-comps-cache' : 'sold-comps-fresh',
          queryUsed: query,
          queryVariant,
          cachedAt: new Date().toISOString(),
        };
      } catch (err) {
        lastErr = err;
        if (attempt < FRESH_RETRY_MAX - 1) {
          await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
          continue;
        }
      }
    }
    return { error: lastErr?.message || 'sold_comps_failed' };
  }

  // 1. Full query.
  const full = await attemptLookup(fullQuery, 'full');
  if (full.found) {
    await putUpcCacheEntry(env, cacheKey, full);
    return full;
  }

  // 2. Fallback to short query if it's actually shorter than the full one.
  // ("ASUS" with no extra title yields fullQuery === shortQuery; no point
  // burning a second call.)
  if (shortQuery && shortQuery.length >= 3 && shortQuery !== fullQuery) {
    const short = await attemptLookup(shortQuery, 'short');
    if (short.found) {
      await putUpcCacheEntry(env, cacheKey, short);
      return short;
    }
    // Neither query found comps. Cache the short attempt's miss (or whichever
    // didn't error) so we don't keep retrying.
    const finalMiss = short.error && !full.error ? full : short;
    await putUpcCacheEntry(env, cacheKey, finalMiss);
    return finalMiss.error
      ? { cacheKey, found: false, priceSource: 'sold-comps-error', avgPrice: null, lowPrice: null, highPrice: null, numSales: 0, title: null, error: finalMiss.error }
      : finalMiss;
  }

  // Only the full query was tried (short ≡ full).
  if (full.error) {
    return { cacheKey, found: false, priceSource: 'sold-comps-error', avgPrice: null, lowPrice: null, highPrice: null, numSales: 0, title: null, error: full.error };
  }
  await putUpcCacheEntry(env, cacheKey, full);
  return full;
}

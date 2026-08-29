// ─── Lot manifest enrichment ─────────────────────────────────────────────────
// Fetch a lot's manifest through the configured lot provider, then price each
// line item through the comps provider. This is the expensive path — it fans
// out one pricing lookup per distinct item in the manifest — so it is heavily
// cached and concurrency-capped.
//
// Scope:
//   - Manifest via the lot provider (src/providers/)
//   - Pricing via the comps provider, with the eBay Browse API as an optional
//     second-chance pricer for items comps can't match
//   - KV-backed UPC cache (180d TTL; 60d freshness check via upcCache.js)
//   - Per-request concurrency via mapWithConcurrency
//
// Request body (POST /lots/enrich):
//   { lotUrl, lotId, lotCondition,
//     soldCompsUrl, soldCompsAuth, soldCompsWorkspaceId,
//     soldDays, batchSize, enableKeywordSearch, appId, certId }

import { getLotProvider, callProvider } from '../../providers/index.js';
import { priceItemViaSoldComps } from './soldComps.js';
import { priceItemViaBrowseApi } from './browseApi.js';
import { mapWithConcurrency } from './mapConcurrency.js';
import { cleanDisplay, simpleHash } from './textUtils.js';
// Reduced from 30 → 8 after the Browse-API-fallback disable surfaced
// Bright Data rate limits. Multiple lots enriching simultaneously from
// BrowseLotsView were firing 50-100+ concurrent Bright Data calls and
// blowing past the BD per-account concurrent-request cap. 8 keeps each lot
// well-behaved while still pricing a 40-item manifest in ~30s.
const DEFAULT_BATCH = 8;

function manifestRowsToItems(headers, rows) {
  // Mirror cloudRowsToItems from Hub's lotAnalysisQueue.js + the local
  // fetchLiqManifest output shape.
  const lc = headers.map((h) => String(h || '').toLowerCase());
  const findIdx = (...patterns) => {
    for (const p of patterns) {
      const idx = lc.findIndex((h) => p.test(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const idxDesc  = findIdx(/\bdescription\b/, /\bproduct\b/, /\bname\b/, /\btitle\b/, /\bitem\b/);
  const idxUpc   = findIdx(/\bupc\b/, /\bbarcode\b/, /\bean\b/, /\bgtin\b/);
  const idxQty   = findIdx(/\b(quantity|qty)\b/, /\bcount\b/, /\bunits?\b/);
  const idxMsrp  = findIdx(/\bmsrp\b/, /\bretail\b/, /\bunit\s+price\b/);
  const idxBrand = findIdx(/\bbrand\b/, /\bmanufacturer\b/, /\bmake\b/);
  const idxCond  = findIdx(/\b(condition|grade)\b/);
  const cellNum = (s) => {
    const m = String(s || '').match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return rows
    .map((row) => ({
      title:     idxDesc  !== -1 ? String(row[idxDesc] || '').trim() : '',
      brand:     idxBrand !== -1 ? String(row[idxBrand] || '').trim() || null : null,
      upc:       idxUpc   !== -1 ? String(row[idxUpc] || '').replace(/\D/g, '') || null : null,
      qty:       idxQty   !== -1 ? Math.max(1, Math.round(cellNum(row[idxQty]) || 1)) : 1,
      msrp:      idxMsrp  !== -1 ? cellNum(row[idxMsrp]) : null,
      condition: idxCond  !== -1 ? String(row[idxCond] || '').trim() || null : null,
    }))
    // Title must contain at least one letter — rejects rows where the
    // description column landed on a numeric price cell ("$579.99"), a bare
    // quantity ("1234"), or other numeric-only junk that would otherwise
    // get shipped to sold-comps as a garbage search query.
    .filter((it) => it.title && it.title.length > 1 && /[a-zA-Z]/.test(it.title));
}

export async function enrichLot(body, env, ctx, log) {
  const { lotUrl, lotCondition,
          soldCompsUrl, soldCompsAuth, soldCompsWorkspaceId,
          soldDays, batchSize, enableKeywordSearch,
          // When true, skip every cache layer: KV upc entries, Supabase
          // sold_comps rows, and any downstream compsLookup cache reads.
          forceRefresh,
          // Browse API fallback creds — when present, items that sold-comps
          // can't price get a second-chance lookup via eBay's Browse API.
          appId, certId } = body || {};

  if (!soldCompsUrl || !soldCompsAuth || !soldCompsWorkspaceId) {
    return { ok: false, error: 'soldCompsUrl, soldCompsAuth and soldCompsWorkspaceId are required' };
  }

  // ── Step 1: manifest, via the configured lot provider ────────────────────
  const lotId = body?.lotId
    || (lotUrl && (lotUrl.match(/[?&]id=(\w+)/) || lotUrl.match(/\/lots?\/(\w+)/))?.[1])
    || null;
  if (!lotId) {
    return { success: true, manifestItems: [], totals: { estResale: 0, numItems: 0, numPriced: 0, numUniqueUpcs: 0 }, note: 'No lotId supplied or derivable from lotUrl' };
  }

  let manifestItems = [];
  try {
    const provider = await getLotProvider(env);
    const m = await callProvider(provider, 'fetchManifest', env, { lotId, lotUrl, lotCondition, log });
    if (m?.supported === false) {
      return { ok: false, supported: false, error: m.error };
    }
    if (m?.ok && m.rows?.length) {
      manifestItems = manifestRowsToItems(m.headers || [], m.rows);
    }
  } catch (e) {
    return { success: true, manifestItems: [], totals: { estResale: 0, numItems: 0, numPriced: 0, numUniqueUpcs: 0 }, note: `Manifest fetch failed: ${e?.message || 'unknown'}` };
  }
  if (manifestItems.length === 0) {
    return { success: true, manifestItems: [], totals: { estResale: 0, numItems: 0, numPriced: 0 }, note: 'No UPCs found in manifest' };
  }

  // ── Step 2: dedup by UPC or title-hash ────────────────────────────────────
  const uniqueMap = new Map();
  for (const item of manifestItems) {
    const cleanUpc = String(item.upc || '').replace(/\D/g, '');
    const key = /^\d{12,13}$/.test(cleanUpc) ? cleanUpc : 'kw:' + simpleHash(`${item.brand || ''}|${item.title || ''}`);
    if (!uniqueMap.has(key)) uniqueMap.set(key, { ...item, _priceKey: key });
  }
  const uniqueItems = [...uniqueMap.values()];

  // ── Step 3: price ─────────────────────────────────────────────────────────
  // Only items with a UPC OR (UPC absent AND keyword search enabled).
  const withKw = enableKeywordSearch !== false;
  const priceable = uniqueItems.filter((it) => {
    const u = String(it.upc || '').replace(/\D/g, '');
    if (/^\d{12,13}$/.test(u)) return true;
    return withKw && it.title && it.title.length > 4;
  });

  // Cap dropped from 50 → 12. See DEFAULT_BATCH comment for rationale.
  const limit = Math.max(1, Math.min(12, Number(batchSize) || DEFAULT_BATCH));
  let rateLimited = false;

  const opts = {
    lambdaUrl: soldCompsUrl,
    lambdaAuth: soldCompsAuth,
    workspaceId: soldCompsWorkspaceId,
    soldDays: Number(soldDays) || 90,
    lotCondition,
    forceRefresh: !!forceRefresh,
  };

  // Per-item pricing — sold-comps ONLY. The Browse API fallback was
  // disabled because it returns ACTIVE asking prices (what sellers want),
  // not realized sold prices. Mixing asks into sold-comp results silently
  // inflates medians by 50-100% on niche / flagship SKUs:
  //   X870E GODLIKE actual sold median: ~$665
  //   X870E GODLIKE asking median:      ~$1,340
  // The Hub's bid math + ROI calculations assume realized sales, so the
  // Browse-API fallback was actively poisoning bid recommendations.
  //
  // To re-enable (NOT recommended), set the env flag explicitly:
  //   wrangler secret put ENABLE_BROWSE_API_FALLBACK
  //   value: "1"
  // and pass appId+certId from the Hub. Even then, the priceSource
  // field will surface 'browse-api' so the UI can distinguish.
  const browseFallback = env.ENABLE_BROWSE_API_FALLBACK === '1' && !!(appId && certId);
  const browseOpts = { appId, certId, enableKeywordSearch };

  const priceResults = await mapWithConcurrency(
    priceable,
    limit,
    async (item) => {
      const primary = await priceItemViaSoldComps(item, opts, env, ctx, log);
      if (primary?.found) return primary;
      if (!browseFallback) return primary;
      // Sold-comps came back empty or errored — try Browse API.
      try {
        const fb = await priceItemViaBrowseApi(item, browseOpts, env);
        if (fb?.found) return fb;
        return primary || fb;
      } catch (e) {
        if (e?.message === 'RATE_LIMITED') {
          rateLimited = true;
          console.warn('[enrich] Browse API rate-limited — halting fallback for remaining items');
        }
        return primary;
      }
    },
    { shouldStop: () => rateLimited },
  );

  const priceMap = new Map();
  for (let i = 0; i < priceResults.length; i++) {
    const r = priceResults[i];
    if (!r) continue;
    if (r.__error) continue;
    if (r.priceSource === 'sold-comps-error') {
      // Mark but don't block.
      priceMap.set(priceable[i]._priceKey, { ...r, found: false });
      continue;
    }
    priceMap.set(priceable[i]._priceKey, r);
  }

  // ── Step 4: merge into ALL manifest items ─────────────────────────────────
  const enriched = manifestItems.map((item) => {
    const cleanUpc = String(item.upc || '').replace(/\D/g, '');
    const key = /^\d{12,13}$/.test(cleanUpc) ? cleanUpc : 'kw:' + simpleHash(`${item.brand || ''}|${item.title || ''}`);
    const p = priceMap.get(key);
    return {
      ...item,
      title:        cleanDisplay(item.title),
      brand:        cleanDisplay(item.brand),
      ebayTitle:    p?.title ? cleanDisplay(p.title) : null,
      avgPrice:     p?.avgPrice ?? null,
      lowPrice:     p?.lowPrice ?? null,
      highPrice:    p?.highPrice ?? null,
      numSales:     p?.numSales || 0,
      priceSource:  p?.priceSource || 'unknown',
      cachedAt:     p?.cachedAt || null,
      found:        !!p?.found,
      // Surface the Lambda's actual error so callers can debug. Only present
      // when priceSource === 'sold-comps-error'.
      priceError:   p?.error || null,
    };
  });

  // ── Step 5: totals ────────────────────────────────────────────────────────
  let estResale = 0, numItems = 0, numPriced = 0;
  for (const it of enriched) {
    const qty = it.qty || 1;
    numItems += qty;
    if (it.found && Number.isFinite(it.avgPrice)) {
      numPriced += qty;
      estResale += it.avgPrice * qty;
    }
  }

  return {
    success: true,
    // noAppId intentionally NOT set. The Hub's LotCard treats noAppId=true
    // as "Browse API mode without credentials" (= broken state, hides the
    // pricing table + shows a warning). For sold-comps mode the flag is
    // irrelevant — the Hub should render the pricing table normally.
    manifestItems: enriched,
    totals: {
      estResale: Math.round(estResale * 100) / 100,
      numItems,
      numPriced,
      numUniqueUpcs: uniqueItems.length,
    },
  };
}

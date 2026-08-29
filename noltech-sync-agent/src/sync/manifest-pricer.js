// Periodically triggers the pipeline to refresh browse-lots and re-price
// each one's manifest via sold-comps. Keeps the Pi's lot data + pricing fresh
// without requiring the desktop Hub app to be open.
//
// Strategy:
//   1. Discover lots — call GET ${pipelineUrl}/api/lots/all to get the current
//      set of browse-lots (the pipeline's provider supplies them).
//   2. For each lot, POST ${pipelineUrl}/api/lots/enrich with the lot's
//      identifiers. The pipeline uses sold-comps internally and returns
//      enriched items + totals.
//   3. Throttle — 5 sec gap between calls (each enrich call may fan out 50+
//      sold-comps queries to the Lambda). Cap total lots per run.
//   4. Skip already-fresh — if the response indicates the prices came from
//      cache (numUniqueUpcs > 0 but no live priceSource), count as a skip.
//   5. Per-lot errors are caught and logged; never crash the whole run.

import { withPipelineAuth } from '../lib/pipelineAuth.js';

const PIPELINE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min — covers slow techliq xlsx + many cache misses
// Throttle between lots. 1.5s default — fast enough for big backlogs, conservative
// enough not to bother TechLiquidators. Override via env var if you see
// upstream rate limits in the logs.
const THROTTLE_MS        = parseInt(process.env.MANIFEST_PRICER_THROTTLE_MS, 10) || 1500;
const CACHE_FRESH_MS     = 6 * 3600 * 1000; // 6 hours — enriched within this window = skip

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pulls identifying fields out of a browse-lot record returned by /api/lots/all.
// Returns null if the lot is missing the keys needed to enrich it.
function extractLotIdentity(lot) {
  if (!lot || typeof lot !== 'object') return null;
  const source = lot.source || lot.marketplace || null;

  // Liquidation.com lots are addressed by lotUrl; everything else by palletId+manifestSlug.
  if (source === 'liquidation') {
    if (!lot.url && !lot.lotUrl) return null;
    return {
      source: 'liquidation',
      lotUrl: lot.lotUrl || lot.url,
      palletId: lot.palletId || lot.id || null,
      manifestSlug: lot.manifestSlug || null,
    };
  }

  if (!lot.palletId || !lot.manifestSlug) return null;
  return {
    source: source || 'techliquidators',
    palletId: lot.palletId,
    manifestSlug: lot.manifestSlug,
    lotUrl: lot.lotUrl || lot.url || null,
  };
}

// True if the enrich response came entirely from cached pricing fresh enough
// that we should treat this lot as a skip (no real Lambda calls were made).
function looksFreshFromCache(payload) {
  if (!payload || !payload.manifestItems || payload.manifestItems.length === 0) {
    return false;
  }
  const items = payload.manifestItems;
  const cachedCount = items.filter(
    (it) => it && (it.priceSource === 'cached' || (it.cachedAt && Date.now() - new Date(it.cachedAt).getTime() < CACHE_FRESH_MS)),
  ).length;
  // If every priced item came from cache, no Lambda load was incurred.
  const pricedCount = items.filter((it) => it && it.found && it.avgPrice != null).length;
  return pricedCount > 0 && cachedCount >= pricedCount;
}

async function fetchLotList(pipelineUrl, logger) {
  const url = `${pipelineUrl.replace(/\/$/, '')}/api/lots/all`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: withPipelineAuth(),
      signal: AbortSignal.timeout(PIPELINE_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err: err.message, url }, 'Manifest pricer: pipeline unreachable');
    return { ok: false, reason: 'pipeline-unreachable', lots: [] };
  }

  if (resp.status === 404) {
    logger.warn({ url }, 'Manifest pricer: /api/lots/all not found on the pipeline');
    return { ok: false, reason: 'no-list-endpoint', lots: [] };
  }

  if (!resp.ok) {
    logger.warn({ url, status: resp.status }, 'Manifest pricer: lot list fetch failed');
    return { ok: false, reason: `http-${resp.status}`, lots: [] };
  }

  let payload;
  try {
    payload = await resp.json();
  } catch (err) {
    logger.warn({ err: err.message, url }, 'Manifest pricer: lot list returned non-JSON');
    return { ok: false, reason: 'bad-json', lots: [] };
  }

  const lots = Array.isArray(payload?.lots) ? payload.lots : [];
  return { ok: true, lots };
}

async function enrichOneLot(pipelineUrl, identity, logger) {
  const url = `${pipelineUrl.replace(/\/$/, '')}/api/lots/enrich`;
  const body = {
    palletId: identity.palletId || '',
    manifestSlug: identity.manifestSlug || '',
    source: identity.source,
    lotUrl: identity.lotUrl || '',
    appId: '', // sold-comps path doesn't need eBay App ID
    enableKeywordSearch: true,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: withPipelineAuth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PIPELINE_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`enrich HTTP ${resp.status}`);
  }

  return resp.json();
}

export async function runManifestPricer({ pipelineUrl, logger, maxLotsPerRun }) {
  const startedAt = Date.now();
  if (!pipelineUrl) {
    logger.warn('Manifest pricer: no pipelineUrl configured — skipping');
    return { skipped: true, reason: 'no-pipeline-url' };
  }

  const cap = Number.isFinite(maxLotsPerRun) && maxLotsPerRun > 0 ? maxLotsPerRun : 20;

  const list = await fetchLotList(pipelineUrl, logger);
  if (!list.ok) {
    return {
      skipped: true,
      reason: list.reason,
      durationMs: Date.now() - startedAt,
    };
  }

  if (list.lots.length === 0) {
    logger.info('Manifest pricer: no lots returned by the pipeline');
    return {
      lots: { total: 0, priced: 0, skipped: 0, errored: 0 },
      durationMs: Date.now() - startedAt,
      errors: [],
    };
  }

  // Filter to lots we can actually enrich, then cap.
  const candidates = [];
  for (const raw of list.lots) {
    const identity = extractLotIdentity(raw);
    if (!identity) continue;
    candidates.push({ identity, lotId: raw.id || identity.palletId || identity.lotUrl });
    if (candidates.length >= cap) break;
  }

  if (candidates.length === 0) {
    logger.info(
      { totalReturned: list.lots.length },
      'Manifest pricer: no enrichable lots (missing palletId/manifestSlug/lotUrl)',
    );
    return {
      lots: { total: list.lots.length, priced: 0, skipped: 0, errored: 0 },
      durationMs: Date.now() - startedAt,
      errors: [],
    };
  }

  let priced = 0;
  let skipped = 0;
  let errored = 0;
  const errors = [];

  for (let i = 0; i < candidates.length; i++) {
    const { identity, lotId } = candidates[i];
    try {
      const result = await enrichOneLot(pipelineUrl, identity, logger);

      if (!result || result.success === false) {
        errored += 1;
        const errMsg = result?.error || 'unknown enrich failure';
        errors.push({ lotId, palletId: identity.palletId, error: errMsg });
        logger.error({ lotId, palletId: identity.palletId, err: errMsg }, 'Manifest pricer: enrich failed');
      } else if (looksFreshFromCache(result)) {
        skipped += 1;
        logger.warn(
          {
            lotId,
            palletId: identity.palletId,
            numItems: result?.totals?.numItems,
            estResale: result?.totals?.estResale,
          },
          'Manifest pricer: lot already fresh in cache — skipped',
        );
      } else {
        priced += 1;
        logger.info(
          {
            lotId,
            palletId: identity.palletId,
            source: identity.source,
            numItems: result?.totals?.numItems,
            numPriced: result?.totals?.numPriced,
            estResale: result?.totals?.estResale,
          },
          'priced lot',
        );
      }
    } catch (err) {
      errored += 1;
      errors.push({ lotId, palletId: identity.palletId, error: err.message });
      logger.error(
        { lotId, palletId: identity.palletId, err: err.message },
        'Manifest pricer: enrich threw',
      );
    }

    // Throttle between lots — last iteration doesn't need to wait.
    if (i < candidates.length - 1) {
      await sleep(THROTTLE_MS);
    }
  }

  const summary = {
    lots: {
      total: candidates.length,
      priced,
      skipped,
      errored,
    },
    durationMs: Date.now() - startedAt,
    errors,
  };
  logger.info(summary, 'Manifest pricer run complete');
  return summary;
}

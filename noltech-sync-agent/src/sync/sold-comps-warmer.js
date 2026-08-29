// Pre-warms the sold-comps cache for newly-synced inventory items so the
// data is ready by the time the user looks. No-op if SOLD_COMPS_LAMBDA_URL
// isn't configured.
//
// Strategy:
//   1. Read recently-modified items from the items table for the workspace
//      (created_at OR updated_at within the last hour).
//   2. For each item with a brand+model, build a query string.
//   3. Check sold_comps cache — skip if already fresh (<14 days).
//   4. Call the Lambda Function URL fire-and-forget (don't wait for response;
//      we just want it queued — the Lambda will write to sold_comps on its own).
//   5. Throttle: max prewarmLimit items per run, 1 sec delay between calls
//      so we don't burst the Lambda.
//   6. Return summary { attempted, skipped, errors } for the heartbeat.

const RECENT_WINDOW_MS = 60 * 60 * 1000;       // 1 hour
const CACHE_FRESH_MS   = 14 * 86400 * 1000;    // 14 days
const SOLD_DAYS        = 90;                   // cache key window
const THROTTLE_MS      = 1000;                 // 1 sec between Lambda calls
const LAMBDA_TIMEOUT_MS = 60000;

// Must match exactly what the Lambda + Hub use so cache keys line up.
function normalizeQuery(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .sort()
    .join(' ');
}

function buildQuery(item) {
  const brand = String(item.brand || '').trim();
  const model = String(item.model || '').trim();
  if (!brand || !model) return null;
  return `${brand} ${model}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function prewarmSoldComps({ supabase, workspaceId, soldComps, logger }) {
  if (!soldComps || !soldComps.enabled) {
    return { attempted: 0, skipped: 0, errors: 0, disabled: true };
  }

  const sinceIso = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();

  // Recently-modified items in this workspace. We OR on created_at + updated_at
  // so a freshly-inserted manifest item OR a freshly-updated one (e.g. a sale
  // just landed) both qualify.
  const { data: items, error: selErr } = await supabase
    .from('items')
    .select('id, brand, model, created_at, updated_at')
    .eq('workspace_id', workspaceId)
    .or(`created_at.gte.${sinceIso},updated_at.gte.${sinceIso}`)
    .limit(soldComps.prewarmLimit * 4); // grab extra; many will lack brand/model or be cached

  if (selErr) {
    logger.error({ err: selErr.message }, 'Sold-comps warmer: items SELECT failed');
    return { attempted: 0, skipped: 0, errors: 1 };
  }

  if (!items || items.length === 0) {
    logger.info('Sold-comps warmer: no recent items to consider');
    return { attempted: 0, skipped: 0, errors: 0 };
  }

  // De-dupe by normalized query so we don't hammer the Lambda for two
  // identical brand+model items in the same batch.
  const seen = new Set();
  const candidates = [];
  for (const item of items) {
    const query = buildQuery(item);
    if (!query) continue;
    const key = normalizeQuery(query);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ itemId: item.id, query, cacheKey: `${key}:${SOLD_DAYS}` });
    if (candidates.length >= soldComps.prewarmLimit) break;
  }

  if (candidates.length === 0) {
    logger.info('Sold-comps warmer: no items with brand+model in window');
    return { attempted: 0, skipped: 0, errors: 0 };
  }

  let attempted = 0;
  let skipped = 0;
  let errors = 0;

  for (const { itemId, query, cacheKey } of candidates) {
    try {
      // Cache freshness check — skip if a comp <14 days old already exists.
      const { data: cached, error: cacheErr } = await supabase
        .from('sold_comps')
        .select('scraped_at')
        .eq('workspace_id', workspaceId)
        .eq('cache_key', cacheKey)
        .maybeSingle();

      if (cacheErr) {
        logger.warn({ err: cacheErr.message, query }, 'Sold-comps cache lookup failed');
        errors += 1;
        continue;
      }

      if (cached && cached.scraped_at) {
        const ageMs = Date.now() - new Date(cached.scraped_at).getTime();
        if (ageMs < CACHE_FRESH_MS) {
          skipped += 1;
          continue;
        }
      }

      // Fire-and-forget Lambda call — don't await the response body, the
      // Lambda will write to sold_comps on its own. We attach a .catch so an
      // unhandled rejection can't take the process down.
      fetch(soldComps.lambdaUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${soldComps.authSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId,
          query,
          soldDays: SOLD_DAYS,
          requestedBy: 'pi',
        }),
        signal: AbortSignal.timeout(LAMBDA_TIMEOUT_MS),
      }).catch((err) =>
        logger.warn({ err: err.message, query }, 'Pre-warm Lambda call failed (non-fatal)'),
      );

      attempted += 1;
      logger.debug({ itemId, query }, 'Sold-comps pre-warm dispatched');

      // Throttle so we don't burst the Lambda — 1 sec between calls.
      if (attempted < candidates.length) {
        await sleep(THROTTLE_MS);
      }
    } catch (err) {
      errors += 1;
      logger.warn({ err: err.message, query }, 'Sold-comps warmer iteration failed');
    }
  }

  const summary = { attempted, skipped, errors };
  logger.info(summary, 'Sold-comps warmer run complete');
  return summary;
}

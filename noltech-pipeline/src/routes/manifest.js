// ─── GET /lots/:lotId/manifest ─────────────────────────────────────────────
// Fetches a lot's manifest through the configured lot provider and returns
// the enriched items plus a summary. Called by:
//   - the Hub (when the user clicks "View manifest" on a lot card)
//   - the discovery cron (when enqueueing a new lot for analysis)
//
// Query parameters (all optional, but the discovery path should pass them so
// manifest items inherit the right lot-context condition tag):
//   ?lotUrl=...
//   ?lotTitle=...
//   ?lotCondition=Customer+Returns
//
// Response (success):
//   { ok: true, lotId, manifestUrl, itemCount, items: [...], summary: {...}, traceId }
//
// Error codes:
//   - 400 'bad_request'  — lotId missing
//   - 501 'unsupported'  — the configured provider has no manifests
//   - 502 'upstream'     — fetch failed, or the table had no usable columns:
//                          'manifest_not_found' | 'no_rows' |
//                          'no_table_with_description_column' (the corrupt-
//                          manifest path, rejected rather than accepted)

import { matchPath } from '../lib/path.js';
import { ok, errors } from '../lib/response.js';
import { getLotProvider, callProvider } from '../providers/index.js';
import { buildManifestItems } from '../shared/manifestTable.js';

export async function fetchManifest(request, env, ctx, log) {
  const traceId = log?.baseFields?.traceId;
  const url = new URL(request.url);

  const lotIdMatch = matchPath(url, /^\/lots\/([^/]+)\/manifest$/);
  if (!lotIdMatch) return errors.badRequest(traceId, 'invalid path — expected /lots/:lotId/manifest');
  const lotId = lotIdMatch[1];

  const lotUrl       = url.searchParams.get('lotUrl')       || '';
  const lotTitle     = url.searchParams.get('lotTitle')     || '';
  const lotCondition = url.searchParams.get('lotCondition') || '';

  log = log.child({ route: 'manifest.fetch', lotId });
  log.info('start', { hasLotUrl: !!lotUrl, hasLotTitle: !!lotTitle, hasLotCondition: !!lotCondition });

  let provider;
  try {
    provider = await getLotProvider(env);
  } catch (e) {
    log.error('provider_unavailable', { message: e?.message });
    return errors.upstream(traceId, e?.message || 'lot provider unavailable');
  }

  const fetched = await callProvider(provider, 'fetchManifest', env, {
    lotId, lotUrl, lotTitle, lotCondition, log,
  });

  if (fetched?.supported === false) {
    log.warn('manifest_unsupported', { provider: provider.id });
    return errors.upstream(traceId, fetched.error || 'provider does not supply manifests');
  }
  if (!fetched?.ok) {
    log.warn('manifest_fetch_failed', { error: fetched?.error });
    return errors.upstream(traceId, fetched?.error || 'manifest fetch failed');
  }

  const built = buildManifestItems(fetched.headers, fetched.rows, {
    title: lotTitle, condition: lotCondition,
  });
  if (!built.ok) {
    log.warn('manifest_parse_failed', { error: built.error });
    return errors.upstream(traceId, built.error);
  }

  log.info('manifest_parsed', {
    provider:      provider.id,
    items:         built.items.length,
    totalMsrp:     built.summary?.totalMsrp,
    hasDesktops:   built.summary?.hasDesktops,
    hasGpus:       built.summary?.hasGpus,
    forPartsRatio: built.summary?.forPartsRatio,
  });

  return ok({
    lotId,
    manifestUrl: fetched.manifestUrl || null,
    itemCount:   built.items.length,
    items:       built.items,
    summary:     built.summary,
  }, traceId);
}

/**
 * Manifest fetch + parse as a plain function, for callers that already have a
 * lot object and don't want to go through HTTP (the discovery cron).
 *
 * @returns {{ok: true, items, summary, manifestUrl} | {ok: false, error, items: []}}
 */
export async function fetchAndParseManifest(lot, env, log) {
  const lotId = String(lot?.lotId || lot?.lot_id || '');
  if (!lotId) return { ok: false, error: 'no_lot_id', items: [] };

  let provider;
  try {
    provider = await getLotProvider(env);
  } catch (e) {
    return { ok: false, error: e?.message || 'provider_unavailable', items: [] };
  }

  const fetched = await callProvider(provider, 'fetchManifest', env, {
    lotId,
    lotUrl:       lot?.url,
    lotTitle:     lot?.title,
    lotCondition: lot?.condition,
    log,
  });
  if (fetched?.supported === false) return { ok: false, error: fetched.error, items: [] };
  if (!fetched?.ok)                 return { ok: false, error: fetched?.error || 'manifest_fetch_failed', items: [] };

  const built = buildManifestItems(fetched.headers, fetched.rows, {
    title: lot?.title, condition: lot?.condition,
  });
  if (!built.ok) return built;

  return { ok: true, items: built.items, summary: built.summary, manifestUrl: fetched.manifestUrl || null };
}

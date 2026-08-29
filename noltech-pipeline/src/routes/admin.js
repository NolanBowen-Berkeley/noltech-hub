// ─── Admin + diagnostics routes ──────────────────────────────────────────────
// /admin/* is bearer-gated by the main dispatch (checkAuth). /diag/providers
// is public alongside /health — it reports configuration shape only.

import { json } from '../lib/response.js';
import {
  getLotProvider, getCompsProvider, describeProvider,
  BUILTIN_LOT_PROVIDERS, BUILTIN_COMPS_PROVIDERS,
} from '../providers/index.js';

// GET /diag/providers — PUBLIC read-only. Reports which providers are
// configured and what each can do, so a misconfigured deployment can be
// diagnosed with one curl. Returns identity and capability names only —
// never credentials.
export async function diagProviders(_req, env, _ctx, _log) {
  const out = {
    at: new Date().toISOString(),
    builtins: { lot: BUILTIN_LOT_PROVIDERS, comps: BUILTIN_COMPS_PROVIDERS },
    configured: {
      LOT_PROVIDER:   env.LOT_PROVIDER   || 'sample (default)',
      COMPS_PROVIDER: env.COMPS_PROVIDER || 'sample (default)',
      LOT_SOURCES:    env.LOT_SOURCES    || 'sample (default)',
    },
  };

  try {
    out.lotProvider = describeProvider(await getLotProvider(env));
  } catch (e) {
    out.lotProvider = { error: e?.message || 'unavailable' };
  }
  try {
    out.compsProvider = describeProvider(await getCompsProvider(env));
  } catch (e) {
    out.compsProvider = { error: e?.message || 'unavailable' };
  }

  // A deployment still on the sample provider is producing made-up numbers.
  // Say so plainly here rather than letting it be inferred from the id.
  out.usingSampleData =
    out.lotProvider?.id === 'sample' || out.compsProvider?.id === 'sample';

  return json(out);
}

// Delete every KV entry under `prefix` by paging through kv.list().
async function deleteKvByPrefix(kv, prefix) {
  if (!kv) return 0;
  let cursor;
  let count = 0;
  do {
    const list = await kv.list({ prefix, cursor });
    // KV has no bulk delete; loop through and issue individual deletes.
    // Small batches so a huge cache doesn't blow the subrequest cap.
    await Promise.all(list.keys.map((k) => kv.delete(k.name)));
    count += list.keys.length;
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return count;
}

async function deleteR2ByPrefix(bucket, prefix) {
  if (!bucket) return 0;
  let cursor;
  let count = 0;
  do {
    const list = await bucket.list({ prefix, cursor });
    if (list.objects?.length) {
      // R2 supports batched delete via array of keys — cheaper than one-at-a-time.
      await bucket.delete(list.objects.map((o) => o.key));
      count += list.objects.length;
    }
    cursor = list.truncated ? list.cursor : null;
  } while (cursor);
  return count;
}

// POST /admin/flush-caches
//   body: { scopes?: string[] }   — defaults to all
//   scopes: 'kv-search' | 'kv-manifest' | 'kv-upc' | 'r2-images'
//
// Returns:
//   { ok, deleted: { kvSearch, kvManifest, kvUpc, r2Images }, errors: [] }
export async function flushCaches(req, env, ctx, log) {
  let body = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const requested = Array.isArray(body?.scopes) && body.scopes.length
    ? new Set(body.scopes)
    : new Set(['kv-search', 'kv-manifest', 'kv-upc', 'r2-images']);

  const deleted = {};
  const errors = [];

  const kv = env.PIPELINE_CACHE || env.SCRAPER_CACHE;

  try {
    if (requested.has('kv-search')) {
      // `lots:search:<source>:page=N` — written by routes/lots.js.
      deleted.kvSearch = await deleteKvByPrefix(kv, 'lots:search:');
    }
    if (requested.has('kv-manifest')) {
      // `lots:manifest:<lotId>` from the /lots/manifest cache path.
      deleted.kvManifest = await deleteKvByPrefix(kv, 'lots:manifest:');
    }
    if (requested.has('kv-upc')) {
      // `upc:<upc>` OR `upc:kw:<hash>` per upcCache.js.
      deleted.kvUpc = await deleteKvByPrefix(kv, 'upc:');
    }
    if (requested.has('r2-images')) {
      // lotImage() keys objects as `img:<url tail>` — see routes/lots.js.
      deleted.r2Images = await deleteR2ByPrefix(env.IMAGE_CACHE, 'img:');
    }
  } catch (e) {
    log?.error?.('flush_caches_failed', { message: e?.message, stack: e?.stack?.slice(0, 500) });
    errors.push({ message: e?.message || 'unknown' });
  }

  const total = Object.values(deleted).reduce((a, b) => a + (b || 0), 0);
  log?.info?.('flush_caches_done', { total, deleted, scopes: [...requested] });
  return json({ ok: errors.length === 0, deleted, total, errors });
}

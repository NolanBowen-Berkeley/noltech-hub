// ─── Lot routes ─────────────────────────────────────────────────────────────
// Lot search, manifests, images, and closing prices. Every one of these is a
// thin wrapper: parse the request, hit the cache, delegate to the configured
// lot provider (src/providers/), cache the result.
//
// Routes:
//   GET  /lots/all                    fan-out across the configured sources
//   GET  /lots/all/stream             same, as Server-Sent Events
//   GET  /lots/sample                 generated fixtures, ignores the provider
//   GET  /lots/manifest               a lot's manifest as headers + rows
//   GET  /lots/image                  image proxy with disk cache
//   POST /lots/closing-price          final-bid / auction-state lookup
//   POST /lots/enrich                 manifest fetch + per-item pricing
//
// The original private build reached auction sites directly from here. That
// code is gone; what remains is the request/cache/response plumbing, with the
// data itself coming from whichever provider you configure.

import { matchPath } from '../lib/path.js';
import { getLotProvider, callProvider } from '../providers/index.js';
import { sampleLots } from '../providers/fixtures.js';
import { cacheGetJson, cachePutJson, imageGet, imagePut } from '../services/pricing/cache.js';
import { enrichLot } from '../services/pricing/enrich.js';
import { CORS_HEADERS } from '../lib/cors.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// A provider that doesn't implement a method is a 501, not a 500 — the Hub
// shows "this source can't do that" rather than a generic failure.
function providerResult(r) {
  if (r?.supported === false) return json(r, 501);
  return json(r, r?.ok === false ? 502 : 200);
}

// ─── Sources ────────────────────────────────────────────────────────────────
// Which lot sources to fan out over. Configured, not hardcoded: a provider
// decides what a "source" means for it. Default is the single sample source.

function configuredSources(env) {
  const raw = String(env.LOT_SOURCES || 'sample').split(',');
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const s = r.trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : ['sample'];
}

function requestedSources(env, param) {
  const configured = configuredSources(env);
  if (!param) return { known: configured, unknown: [] };

  const known = [];
  const unknown = [];
  const seen = new Set();
  for (const r of String(param).split(',')) {
    const s = r.trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    if (configured.includes(s)) known.push(s);
    else unknown.push(s);
  }
  return { known, unknown };
}

// ─── Search ────────────────────────────────────────────────────────────────

async function searchOneSource(env, ctx, { provider, source, page, noCache, log }) {
  const key = `lots:search:${source}:page=${page}`;
  if (!noCache) {
    const cached = await cacheGetJson(env, key);
    if (cached) return { ...cached, cached: true };
  }
  const r = await callProvider(provider, 'searchLots', env, { source, page, log });
  if (r?.ok) ctx.waitUntil(cachePutJson(env, key, r, Number(env.CACHE_TTL_SEARCH) || 600));
  return { ...r, cached: false };
}

// Hard ceiling per source so one hung provider can't leave the Hub's progress
// strip stuck on "fetching…" forever.
const SOURCE_TIMEOUT_MS = 75_000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: `${label}_timeout_${ms}ms` }), ms)),
  ]);
}

async function runConcurrent(tasks, concurrency) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); }
      catch (e) { results[idx] = { ok: false, error: e?.message || 'threw' }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

export async function lotsAll(req, env, ctx, log) {
  const url = new URL(req.url);
  const noCache = url.searchParams.get('noCache') === '1';
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const concurrency = Math.max(1, Math.min(8, Number(env.FAN_OUT_CONCURRENCY) || 4));
  const { known, unknown } = requestedSources(env, url.searchParams.get('sources'));

  let provider;
  try { provider = await getLotProvider(env); }
  catch (e) { return json({ ok: false, error: e?.message || 'provider_unavailable', lots: [] }, 500); }

  const results = await runConcurrent(
    known.map((source) => () => searchOneSource(env, ctx, { provider, source, page, noCache, log })),
    concurrency,
  );

  const allLots = results.flatMap((r) => (r?.ok ? r.lots : []));
  log?.info?.('lots_all_result', {
    provider: provider.id,
    unknown,
    sources: results.map((r, i) => ({
      source: known[i], ok: !!r?.ok, count: r?.lots?.length || 0,
      cached: !!r?.cached, error: r?.ok ? null : r?.error,
    })),
    totalLots: allLots.length,
  });

  return json({
    ok: true,
    provider: provider.id,
    // Set when the data is generated rather than real. Consumers that persist
    // lots (the sync agent writes to Supabase) MUST check this — silently
    // upserting fixtures into a live workspace is worse than returning none.
    sample: results.some((r) => r?.sample) || provider.id === 'sample',
    sources: [
      ...results.map((r, i) => ({
        source: known[i],
        ok:     !!r?.ok,
        count:  r?.lots?.length || 0,
        error:  r?.ok ? null : r?.error,
      })),
      ...unknown.map((s) => ({ source: s, ok: false, count: 0, error: 'source_not_configured' })),
    ],
    lots: allLots,
    totalLots: allLots.length,
  });
}

export async function lotsAllStream(req, env, ctx, log) {
  const url = new URL(req.url);
  const noCache = url.searchParams.get('noCache') === '1';
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const { known, unknown } = requestedSources(env, url.searchParams.get('sources'));

  let provider;
  try { provider = await getLotProvider(env); }
  catch (e) { return json({ ok: false, error: e?.message || 'provider_unavailable' }, 500); }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event, data) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      send('start', {
        sources: [...known, ...unknown],
        provider: provider.id,
        sample: provider.id === 'sample',
        at: new Date().toISOString(),
      });

      let totalLots = 0;
      const summary = [];

      // Sources this deployment isn't configured for resolve immediately as
      // skipped rather than sitting in the UI as a red error.
      for (const src of unknown) {
        summary.push({ source: src, ok: true, count: 0, skipped: true, error: null });
        send('source_done', { source: src, ok: true, count: 0, skipped: true, error: null, lots: [] });
      }

      await Promise.all(known.map(async (source) => {
        send('source_start', { source });
        let r;
        try {
          r = await withTimeout(
            searchOneSource(env, ctx, { provider, source, page, noCache, log }),
            SOURCE_TIMEOUT_MS,
            source,
          );
        } catch (e) {
          r = { ok: false, error: e?.message || 'threw' };
        }
        const count = r?.ok ? r.lots.length : 0;
        totalLots += count;
        summary.push({ source, ok: !!r?.ok, count, error: r?.ok ? null : r?.error });
        send('source_done', { source, ok: !!r?.ok, count, error: r?.ok ? null : r?.error, lots: r?.ok ? r.lots : [] });
      }));

      log?.info?.('stream_complete', { totalLots, unknown });
      send('complete', { totalLots, sources: summary, at: new Date().toISOString() });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type':  'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection':    'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

// GET /lots/sample — generated fixtures regardless of the configured provider.
// Backs the Hub's "sample mode" toggle, and is the fastest way to confirm the
// service is wired up without depending on any provider being configured.
export async function sampleLotsRoute(req, _env, _ctx, log) {
  const url   = new URL(req.url);
  const count = Math.min(60, Math.max(1, parseInt(url.searchParams.get('count'), 10) || 24));
  const page  = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const seed  = parseInt(url.searchParams.get('seed'), 10) || 20260813;

  const lots = sampleLots({ count, page, seed });
  log?.info?.('sample_lots_route', { count: lots.length, page, seed });

  return json({
    ok: true,
    sample: true,
    source: 'sample',
    lots,
    sources: [{ source: 'sample', ok: true, count: lots.length, error: null }],
    totalLots: lots.length,
    cached: false,
  });
}

// ─── Manifest ──────────────────────────────────────────────────────────────

// Accepts ?lotId= (or ?id=) or ?lotUrl=. The Hub has callers of both shapes.
function lotIdFromUrl(lotUrl) {
  if (!lotUrl) return null;
  try {
    const id = new URL(lotUrl).searchParams.get('id');
    if (id) return id;
  } catch {
    // Not a parseable URL — fall through to the loose match below.
  }
  const m = String(lotUrl).match(/[?&]id=(\w+)/) || String(lotUrl).match(/\/lots?\/(\w+)/);
  return m ? m[1] : null;
}

export async function lotManifest(req, env, ctx, log) {
  const url = new URL(req.url);
  const lotId = url.searchParams.get('lotId')
    || url.searchParams.get('id')
    || lotIdFromUrl(url.searchParams.get('lotUrl'));
  if (!lotId) return json({ ok: false, error: 'lotId or lotUrl required' }, 400);

  const noCache = url.searchParams.get('noCache') === '1';
  const key = `lots:manifest:${lotId}`;
  if (!noCache) {
    const cached = await cacheGetJson(env, key);
    if (cached) return json({ ...cached, cached: true });
  }

  let provider;
  try { provider = await getLotProvider(env); }
  catch (e) { return json({ ok: false, error: e?.message || 'provider_unavailable' }, 500); }

  const r = await callProvider(provider, 'fetchManifest', env, {
    lotId,
    lotUrl: url.searchParams.get('lotUrl'),
    log,
  });
  if (r?.ok) ctx.waitUntil(cachePutJson(env, key, r, Number(env.CACHE_TTL_MANIFEST) || 86400));
  if (r?.supported === false) return json(r, 501);
  return json({ ...r, cached: false }, r?.ok === false ? 502 : 200);
}

// ─── Image proxy ───────────────────────────────────────────────────────────
// Public (see index.js) because browsers can't attach an Authorization header
// to an <img src>. Serves from the disk cache when warm.

export async function lotImage(req, env, ctx, _log) {
  const url = new URL(req.url);
  const target = url.searchParams.get('url');
  const lotId  = url.searchParams.get('lotId')
    || matchPath(url, /^\/lots\/([^/]+)\/image$/)?.[1]
    || null;
  if (!target && !lotId) return json({ ok: false, error: 'url or lotId required' }, 400);

  const key = `img:${(target || `lot:${lotId}`).slice(-180)}`;
  const cached = await imageGet(env, key);
  if (cached) {
    return new Response(cached.bytes, {
      status: 200,
      headers: {
        'content-type':  cached.contentType,
        'cache-control': 'public, max-age=86400',
        ...CORS_HEADERS,
      },
    });
  }

  let provider;
  try { provider = await getLotProvider(env); }
  catch (e) { return json({ ok: false, error: e?.message || 'provider_unavailable' }, 500); }

  const r = await callProvider(provider, 'fetchImage', env, { url: target, lotId });
  if (r?.supported === false) return json(r, 501);
  if (!r?.ok) return json({ ok: false, error: r?.error || 'image_fetch_failed' }, 502);

  ctx.waitUntil(imagePut(env, key, r.bytes, r.contentType, Number(env.CACHE_TTL_IMAGE) || 604800));
  return new Response(r.bytes, {
    status: 200,
    headers: {
      'content-type':  r.contentType,
      'cache-control': 'public, max-age=86400',
      ...CORS_HEADERS,
    },
  });
}

// ─── Closing price / lot state ─────────────────────────────────────────────

export async function lotClosingPrice(req, env, _ctx, log) {
  const body = await req.json().catch(() => ({}));
  const lotUrl = body?.lotUrl || null;
  const lotId  = body?.lotId  || lotIdFromUrl(lotUrl);
  if (!lotUrl && !lotId) return json({ success: false, error: 'lotId or lotUrl is required' }, 400);

  let provider;
  try { provider = await getLotProvider(env); }
  catch (e) { return json({ success: false, error: e?.message || 'provider_unavailable' }, 500); }

  const r = await callProvider(provider, 'fetchLotState', env, { lotId, lotUrl, log });
  if (r?.supported === false) return json({ success: false, ...r }, 501);
  if (r?.ok === false) return json({ success: false, ...r }, 502);
  return json({ success: true, ...r });
}

// ─── Manifest enrichment ───────────────────────────────────────────────────

export async function enrichLotRoute(req, env, ctx, log) {
  const body = await req.json().catch(() => ({}));
  const r = await enrichLot(body, env, ctx, log);
  if (r?.supported === false) return json(r, 501);
  if (r?.ok === false)        return json(r, 400);
  return json(r, 200);
}

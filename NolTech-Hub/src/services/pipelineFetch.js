// ─── Pipeline fetch helper ───────────────────────────────────────────────────
// Centralized routing + auth for every Hub → pipeline call.
//
// There is exactly ONE backend: the local noltech-pipeline Node service, which
// Electron starts on http://localhost:3001 (see electron/main.cjs). It serves
// the lot routes — search, manifests, image proxy, closing prices, sold-comps,
// enrichment — plus the discovery/analysis/refresh/alerts crons.
//
// Where the pipeline gets its data is configured there, not here: see
// noltech-pipeline/src/providers/ and docs/DATA-SOURCES.md.
//
// Auth: the local service runs without a bearer token when bound to loopback,
// which is the default desktop setup. A token is only needed when the service
// is bound to a LAN address (e.g. running on a Pi). Configure both under
// Settings → Local Pipeline.
//
// Path shape: callers pass local-style paths (/api/lots/all). The service
// accepts both that and the bare form (/lots/all), so no rewriting happens
// here anymore.

import { PIPELINE_BASE, PIPELINE_BASE_KEY, PIPELINE_TOKEN_KEY } from '../utils/constants.js';
import { decrypt } from './crypto.js';
import eventBus from './eventBus.js';

// Module-scope cache so we don't hit window.storage on every fetch. Refreshed
// when the user saves the Settings → Local Pipeline form (which emits
// 'settings:pipeline-updated').
let _base  = PIPELINE_BASE;
let _token = null;
let _initialized = false;
let _initPromise = null;

function normalizeBase(v) {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/\/+$/, '');
  return trimmed || null;
}

async function loadConfig() {
  try {
    const stored = normalizeBase(await window.storage.get(PIPELINE_BASE_KEY));
    _base = stored || PIPELINE_BASE;

    const tokRaw = await window.storage.get(PIPELINE_TOKEN_KEY);
    _token = null;
    if (tokRaw) {
      try { _token = await decrypt(tokRaw); }
      catch (e) { console.warn('[pipelineFetch] token decrypt failed:', e?.message); }
    }
  } catch (e) {
    console.warn('[pipelineFetch] config load failed:', e?.message);
    _base = PIPELINE_BASE;
    _token = null;
  }
  _initialized = true;
}

function ensureInit() {
  if (_initialized) return Promise.resolve();
  if (!_initPromise) _initPromise = loadConfig().finally(() => { _initPromise = null; });
  return _initPromise;
}

// Surfaced for Settings UI to invalidate the cache after a save.
eventBus.on('settings:pipeline-updated', () => {
  _initialized = false;
  loadConfig();
});

// ─── Public API ──────────────────────────────────────────────────────────────

// Resolved base URL for the pipeline. Exported for callers that need to build
// a URL rather than issue a fetch — e.g. <img src> for the image proxy, which
// can't carry an Authorization header (the proxy route is public for exactly
// that reason).
export async function getPipelineBase() {
  await ensureInit();
  return _base;
}

// Synchronous best-effort read for render paths that can't await. Returns the
// default until the first async load lands.
export function getPipelineBaseSync() {
  return _base;
}

export async function pipelineFetch(path, opts = {}) {
  await ensureInit();
  const headers = new Headers(opts.headers || {});
  if (_token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${_token}`);
  }
  return fetch(_base + path, { ...opts, headers });
}

// The pipeline is always "configured" — it has a working default. This reports
// whether it's actually reachable, which is what callers care about.
export async function isPipelineReachable(timeoutMs = 3000) {
  try {
    const r = await pipelineFetch('/api/health', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

// Health check against the pipeline. Returns the parsed /health body on
// success so callers can inspect which capabilities are configured.
export async function pipelineHealth(timeoutMs = 5000) {
  try {
    const r = await pipelineFetch('/api/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { backend: 'local', ok: false, error: `HTTP ${r.status}` };
    const data = await r.json().catch(() => null);
    return { backend: 'local', ok: true, data };
  } catch (e) {
    return { backend: 'local', ok: false, error: e?.message };
  }
}


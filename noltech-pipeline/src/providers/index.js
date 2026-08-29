// ─── Data providers ──────────────────────────────────────────────────────────
// Every piece of outside-world data the pipeline needs comes through one of
// two provider interfaces. Nothing else in the codebase talks to a network
// source of lot or pricing data directly.
//
// This seam exists because the auction-site scrapers the original private
// build used are NOT part of this repository. Scraping those sites breaks
// their terms of service, so the public build ships sample providers instead
// and gives you a documented place to plug in a source you are actually
// authorized to use — an official API, a partner feed, a CSV you export
// yourself. See docs/DATA-SOURCES.md.
//
// ─── Lot provider ────────────────────────────────────────────────────────────
//   id            string
//   label         string — shown in /health
//   searchLots(env, { source, page, log })
//        → { ok, source, lots: Lot[], page }
//   fetchManifest(env, { lotId, lotUrl, lotTitle, lotCondition, log })
//        → { ok, manifestUrl, headers: string[], rows: string[][] }
//   fetchLotState(env, { lotId, lotUrl, log })
//        → { ok, ended, status, currentPrice, finalBid, endsAt }
//        status ∈ 'still_active' | 'sold' | 'no_sale' | 'not_found' | 'unknown'
//   fetchImage(env, { url, lotId, log })
//        → { ok, bytes: Uint8Array, contentType }
//
// ─── Comps provider ──────────────────────────────────────────────────────────
//   id            string
//   label         string
//   sourceLabel   string — written to the sold_comps.source column
//   lookup(env, { query, condition, category, soldDays, maxResults, log })
//        → { ok, items: Sample[], total }
//
//   Sample: { itemId, title, conditionLabel, price, currency, shippingCost,
//             totalPrice, soldAt, imageUrl, itemUrl }
//
// Any method a provider omits is reported as unsupported (HTTP 501) rather
// than throwing, so a partial provider is a legitimate thing to ship.

import * as sampleProvider from './sample.js';
import * as ebayBrowseComps from './ebayBrowse.js';

// ─── Registry ────────────────────────────────────────────────────────────────

const LOT_PROVIDERS = {
  sample: sampleProvider.lotProvider,
};

const COMPS_PROVIDERS = {
  sample:      sampleProvider.compsProvider,
  'ebay-browse': ebayBrowseComps.compsProvider,
};

export const BUILTIN_LOT_PROVIDERS   = Object.keys(LOT_PROVIDERS);
export const BUILTIN_COMPS_PROVIDERS = Object.keys(COMPS_PROVIDERS);

// Custom providers are loaded once per process and memoized — a dynamic
// import on every request would be a needless hot-path cost.
const customCache = new Map();

async function loadCustom(specifier, kind) {
  if (customCache.has(specifier)) return customCache.get(specifier);
  let mod;
  try {
    mod = await import(specifier);
  } catch (e) {
    throw new Error(`failed to load custom ${kind} provider '${specifier}': ${e?.message || e}`);
  }
  const provider = mod[kind] || mod.default;
  if (!provider || typeof provider !== 'object') {
    throw new Error(`custom ${kind} provider '${specifier}' must export '${kind}' or a default object`);
  }
  customCache.set(specifier, provider);
  return provider;
}

// ─── Resolution ──────────────────────────────────────────────────────────────
// LOT_PROVIDER / COMPS_PROVIDER select a built-in by name. Setting either to
// 'custom' loads the module named by LOT_PROVIDER_MODULE / COMPS_PROVIDER_MODULE
// — an npm package name or an absolute path (a file: URL on Windows).

export async function getLotProvider(env = {}) {
  const name = String(env.LOT_PROVIDER || 'sample').trim();
  if (name === 'custom') {
    const spec = env.LOT_PROVIDER_MODULE;
    if (!spec) throw new Error("LOT_PROVIDER=custom requires LOT_PROVIDER_MODULE");
    return loadCustom(spec, 'lotProvider');
  }
  const p = LOT_PROVIDERS[name];
  if (!p) {
    throw new Error(`unknown LOT_PROVIDER '${name}' (built-ins: ${BUILTIN_LOT_PROVIDERS.join(', ')}, or 'custom')`);
  }
  return p;
}

export async function getCompsProvider(env = {}) {
  const name = String(env.COMPS_PROVIDER || 'sample').trim();
  if (name === 'custom') {
    const spec = env.COMPS_PROVIDER_MODULE;
    if (!spec) throw new Error("COMPS_PROVIDER=custom requires COMPS_PROVIDER_MODULE");
    return loadCustom(spec, 'compsProvider');
  }
  const p = COMPS_PROVIDERS[name];
  if (!p) {
    throw new Error(`unknown COMPS_PROVIDER '${name}' (built-ins: ${BUILTIN_COMPS_PROVIDERS.join(', ')}, or 'custom')`);
  }
  return p;
}

// ─── Capability helpers ──────────────────────────────────────────────────────

const NOT_SUPPORTED = (provider, method) => ({
  ok: false,
  supported: false,
  error: `provider '${provider?.id || 'unknown'}' does not implement ${method}()`,
});

/**
 * Call a provider method, returning a structured "unsupported" result rather
 * than throwing when the provider doesn't implement it. Routes turn that into
 * a 501 so the Hub can show "not configured" instead of a generic failure.
 */
export async function callProvider(provider, method, env, args) {
  if (typeof provider?.[method] !== 'function') return NOT_SUPPORTED(provider, method);
  return provider[method](env, args);
}

/** Provider identity + capabilities, for /health. */
export function describeProvider(provider) {
  if (!provider) return null;
  return {
    id:    provider.id || 'unknown',
    label: provider.label || provider.id || 'unknown',
    supports: ['searchLots', 'fetchManifest', 'fetchLotState', 'fetchImage', 'lookup']
      .filter((m) => typeof provider[m] === 'function'),
  };
}

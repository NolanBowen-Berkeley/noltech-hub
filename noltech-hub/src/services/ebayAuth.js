// ─── eBay OAuth2 token manager ────────────────────────────────────────────────
// Centralized helper for obtaining a valid eBay OAuth2 access token. Resolution
// order, given a creds object from EBAY_TOKEN_KEY:
//
//   1. If a refresh token + client id/secret exist → mint a fresh access token
//      via the scraper's /api/ebay/oauth/refresh endpoint, cache it in
//      IndexedDB until ~5 min before expiry.
//   2. Else, if a static `oauthUserToken` is set → return that as-is. (Legacy
//      path — these expire every couple of hours and have to be re-pasted.)
//   3. Else → return null. Caller should treat this as "no Finances API
//      access" and fall back to GetOrders estimates.
//
// The cache lives at `noltech:ebay:oauth-cache` with shape:
//   { accessToken: string, expiresAt: number, refreshTokenFingerprint: string }
// Fingerprint is a short hash of the refresh token — if the user pastes a new
// refresh token, we invalidate the cache so the new one is used.

import { PIPELINE_BASE } from '../utils/constants';
import { encryptObject, decryptObject } from './crypto';

const CACHE_KEY = 'noltech:ebay:oauth-cache';
const SAFETY_MS = 5 * 60 * 1000; // refresh 5 min before expiry

let _memCache = null;

async function loadCache() {
  if (_memCache) return _memCache;
  try {
    const raw = await window.storage.get(CACHE_KEY);
    // decryptObject returns {} for null / unrecognized blobs, which is the
    // right behavior — a stale plaintext cache (from before this change)
    // gets dropped silently and we just refresh on next use.
    const decrypted = await decryptObject(raw || {});
    _memCache = (decrypted && typeof decrypted === 'object') ? decrypted : {};
  } catch {
    _memCache = {};
  }
  return _memCache;
}

async function saveCache(cache) {
  _memCache = cache;
  try {
    const encrypted = await encryptObject(cache || {});
    await window.storage.set(CACHE_KEY, encrypted);
  } catch (e) {
    console.error('[ebayAuth] cache save failed:', e);
  }
}

// Tiny non-cryptographic fingerprint of a refresh token so we can detect
// when the user pastes a new one and invalidate the cache. We do NOT need
// secure hashing here — we just need stability + cheap.
function fingerprint(s) {
  if (!s) return '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

// Public: get a valid access token (refreshing if needed). Throws on failure
// so callers can surface the error to the user.
export async function getEbayAccessToken(creds) {
  if (!creds) return null;

  const hasRefreshFlow = !!(creds.oauthRefreshToken && creds.appId && creds.certId);

  if (!hasRefreshFlow) {
    // Legacy path: static access token pasted from the dev portal
    return creds.oauthUserToken || null;
  }

  const cache = await loadCache();
  const now   = Date.now();
  const fp    = fingerprint(creds.oauthRefreshToken);
  const cacheStillValid = cache.accessToken
    && cache.expiresAt
    && cache.refreshTokenFingerprint === fp
    && cache.expiresAt - now > SAFETY_MS;

  if (cacheStillValid) return cache.accessToken;

  // Mint a new one
  const res = await fetch(`${PIPELINE_BASE}/api/ebay/oauth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken: creds.oauthRefreshToken,
      clientId:     creds.appId,
      clientSecret: creds.certId,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    throw new Error(data.error || 'eBay OAuth refresh failed');
  }

  await saveCache({
    accessToken: data.accessToken,
    expiresAt:   data.expiresAt,
    refreshTokenFingerprint: fp,
  });
  return data.accessToken;
}

// Public: invalidate the cached token (call after a 401 from the Finances API
// to force a fresh refresh next time).
export async function invalidateEbayAccessToken() {
  await saveCache({});
}

// Public: peek at cache state for diagnostics / Settings UI.
export async function inspectEbayAccessTokenCache() {
  const cache = await loadCache();
  return {
    hasToken: !!cache.accessToken,
    expiresAt: cache.expiresAt || null,
    msUntilExpiry: cache.expiresAt ? cache.expiresAt - Date.now() : null,
  };
}

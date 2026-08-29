// ─── eBay OAuth2 token manager (server flavor) ───────────────────────────────
// Headless variant of noltech-hub/src/services/ebayAuth.js. Reads credentials
// from process.env (loaded via config.js), keeps the minted access token in
// an in-memory module-level cache, and refreshes ~5 min before expiry by
// calling the pipeline's /api/ebay/oauth/refresh endpoint.
//
// On the Pi we have no IndexedDB and no encryption layer — env-supplied
// secrets stay in memory, the token cache is plain JS, and a process restart
// transparently re-mints on first use.
//
// Resolution order, mirroring the desktop:
//   1. If REFRESH_TOKEN + APP_ID + CERT_ID are present → mint via the pipeline.
//   2. Else if EBAY_USER_TOKEN is set → return it as-is (legacy static path).
//   3. Else → null.
//
// Public API:
//   getEbayAccessToken({ pipelineUrl, ebayCreds })  → string|null (throws on refresh failure)
//   invalidateEbayAccessToken()                    → void
//   inspectEbayAccessTokenCache()                  → diagnostic object

const SAFETY_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// In-memory cache. Lives for the life of the process; lost on restart, which
// is fine — the next call simply mints a fresh token.
let _cache = {
  accessToken: null,
  expiresAt: 0,
  refreshTokenFingerprint: '',
};

// Tiny non-cryptographic fingerprint of a refresh token so we can detect when
// the user rotated it via .env + service restart and discard the old cache.
function fingerprint(s) {
  if (!s) return '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

// Public: get a valid access token, refreshing if needed. Throws on failure
// so callers can surface the error.
//
// `creds` shape matches the desktop's decrypted EBAY_TOKEN_KEY object:
//   { token, oauthRefreshToken, oauthUserToken, appId, certId, devId }
// On the Pi we hand it the config.ebay object renamed to match.
export async function getEbayAccessToken({ pipelineUrl, ebayCreds }) {
  if (!ebayCreds) return null;

  const refreshToken = ebayCreds.oauthRefreshToken || ebayCreds.refreshToken;
  const clientId     = ebayCreds.appId;
  const clientSecret = ebayCreds.certId;
  const staticToken  = ebayCreds.oauthUserToken || ebayCreds.userToken;

  const hasRefreshFlow = !!(refreshToken && clientId && clientSecret);
  if (!hasRefreshFlow) {
    return staticToken || null;
  }

  const now = Date.now();
  const fp  = fingerprint(refreshToken);
  const cacheStillValid = _cache.accessToken
    && _cache.expiresAt
    && _cache.refreshTokenFingerprint === fp
    && _cache.expiresAt - now > SAFETY_MS;

  if (cacheStillValid) return _cache.accessToken;

  // Mint a new one
  const res = await fetch(`${pipelineUrl}/api/ebay/oauth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken,
      clientId,
      clientSecret,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    throw new Error(data.error || 'eBay OAuth refresh failed');
  }

  _cache = {
    accessToken: data.accessToken,
    expiresAt:   data.expiresAt,
    refreshTokenFingerprint: fp,
  };
  return data.accessToken;
}

// Public: invalidate the cached token (call after a 401 from the Finances API
// to force a fresh refresh next time).
export async function invalidateEbayAccessToken() {
  _cache = { accessToken: null, expiresAt: 0, refreshTokenFingerprint: '' };
}

// Public: peek at cache state for diagnostics.
export async function inspectEbayAccessTokenCache() {
  return {
    hasToken: !!_cache.accessToken,
    expiresAt: _cache.expiresAt || null,
    msUntilExpiry: _cache.expiresAt ? _cache.expiresAt - Date.now() : null,
  };
}

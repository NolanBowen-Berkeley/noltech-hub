// ─── eBay OAuth — refresh-token flow with Supabase-backed cache ──────────────
// The Hub keeps its access token in IndexedDB (encrypted). The Worker has no
// access to that, so we cache the access token in the workspace's sync_state
// row instead. Re-use across ticks until ~5 min before expiry.
//
// Refresh token must come in via env. Rotation: when the user re-issues at
// developer.ebay.com, run `wrangler secret put EBAY_OAUTH_REFRESH_TOKEN` —
// the next tick detects the fingerprint mismatch and forces a fresh mint.

const SAFETY_MS = 5 * 60 * 1000; // mint a fresh token if cached expires inside 5 min

// Scopes requested when minting a fresh access token.
//
// eBay rejects the refresh with `invalid_scope` if ANY requested scope is
// not in the set the user originally consented to. To survive a token
// generated with a narrower consent (e.g. only fulfillment), we now read
// the active scope list from env so the user can adjust without code
// changes.
//
// Default = sell.fulfillment ONLY (the minimum to fetch orders). Add more
// via `wrangler secret put EBAY_OAUTH_SCOPES` with a space-separated list,
// e.g.:
//   "sell.fulfillment sell.finances sell.inventory sell.marketing"
//
// Reference:
//   sell.finances      → Finances API (REFUND, CREDIT, DISPUTE, fees, labels)
//   sell.fulfillment   → GetOrders (Trading API + IAF Bearer)
//   sell.marketing     → eBay Ad Fee / Promoted Listings detail
//   sell.inventory     → GetMyeBaySelling (active listings, via IAF Bearer)
const DEFAULT_SCOPES = ['sell.fulfillment'];
const SCOPE_PREFIX = 'https://api.ebay.com/oauth/api_scope/';

function buildScopes(env) {
  const raw = String(env.EBAY_OAUTH_SCOPES || '').trim();
  const list = raw
    ? raw.split(/\s+/).filter(Boolean)
    : DEFAULT_SCOPES;
  return list
    .map((s) => (s.startsWith('http') ? s : SCOPE_PREFIX + s))
    .join(' ');
}

// Worker-runtime hash of the refresh token. Used to detect rotation —
// changing the refresh token in env automatically invalidates the cache.
async function fingerprintRefreshToken(refreshToken) {
  const data = new TextEncoder().encode(refreshToken || '');
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Mint a fresh access token from the refresh token. Calls eBay's
// identity API directly (Worker fetch).
async function mintAccessToken(env) {
  const appId = env.EBAY_APP_ID;
  const certId = env.EBAY_CERT_ID;
  const refreshToken = env.EBAY_OAUTH_REFRESH_TOKEN;
  if (!appId || !certId || !refreshToken) {
    throw new Error('Missing EBAY_APP_ID / EBAY_CERT_ID / EBAY_OAUTH_REFRESH_TOKEN');
  }
  const basic = btoa(`${appId}:${certId}`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: buildScopes(env),
  });

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`eBay OAuth refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`eBay OAuth body not JSON: ${text.slice(0, 200)}`); }
  if (!json.access_token || !json.expires_in) {
    throw new Error(`eBay OAuth missing fields: ${JSON.stringify(json).slice(0, 200)}`);
  }
  // Subtract the safety buffer up front so our cached expiry reflects the
  // moment we'd want to refresh, not the actual eBay-side expiry.
  const expiresAt = new Date(Date.now() + Math.max(0, (json.expires_in - 300) * 1000)).toISOString();
  return { accessToken: json.access_token, expiresAt };
}

// Read the cached token from sync_state. Returns null if no row OR if the
// row's fingerprint doesn't match the current refresh token (rotation).
async function readCachedToken(supabase, workspaceId, currentFingerprint) {
  const { data, error } = await supabase
    .from('sync_state')
    .select('ebay_access_token, ebay_access_token_expires_at, ebay_refresh_token_fingerprint')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) {
    console.error('[ebay-sync] sync_state read failed:', error.message);
    return null;
  }
  if (!data?.ebay_access_token || !data?.ebay_access_token_expires_at) return null;
  if (data.ebay_refresh_token_fingerprint !== currentFingerprint) {
    console.log('[ebay-sync] cached token fingerprint mismatch — refresh token rotated');
    return null;
  }
  const expiresAt = new Date(data.ebay_access_token_expires_at).getTime();
  if (expiresAt - Date.now() < SAFETY_MS) return null;
  return { accessToken: data.ebay_access_token, expiresAt: data.ebay_access_token_expires_at };
}

// Persist the new token + fingerprint back to sync_state. UPSERT so the
// first run creates the row.
async function writeCachedToken(supabase, workspaceId, { accessToken, expiresAt }, fingerprint) {
  const { error } = await supabase
    .from('sync_state')
    .upsert({
      workspace_id: workspaceId,
      ebay_access_token: accessToken,
      ebay_access_token_expires_at: expiresAt,
      ebay_refresh_token_fingerprint: fingerprint,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id' });
  if (error) console.error('[ebay-sync] sync_state token write failed:', error.message);
}

// Public API. Returns `{ accessToken, source: 'cache' | 'fresh' }`. Throws
// if minting fails — caller decides whether to fall back to partial sync.
export async function getEbayAccessToken({ env, supabase, workspaceId }) {
  const fingerprint = await fingerprintRefreshToken(env.EBAY_OAUTH_REFRESH_TOKEN);
  const cached = await readCachedToken(supabase, workspaceId, fingerprint);
  if (cached) {
    return { accessToken: cached.accessToken, source: 'cache', expiresAt: cached.expiresAt };
  }
  const fresh = await mintAccessToken(env);
  await writeCachedToken(supabase, workspaceId, fresh, fingerprint);
  console.log(`[ebay-sync] refreshed access token, expires_at=${fresh.expiresAt}`);
  return { accessToken: fresh.accessToken, source: 'fresh', expiresAt: fresh.expiresAt };
}

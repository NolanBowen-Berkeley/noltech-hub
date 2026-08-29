// ─── Request path helpers ────────────────────────────────────────────────────
// The router in index.js strips a leading /api before matching, because the
// Hub calls both shapes (/api/lots/all and /lots/all). Handlers that pull a
// path parameter out of the URL themselves see the RAW pathname, still with
// the prefix — so they need the same normalization or they 400 on exactly the
// half of the traffic that uses /api.

const API_PREFIX_RE = /^\/api(?=\/|$)/;

/** The pathname of `url` with a leading /api removed. */
export function normalizedPath(url) {
  return String(url.pathname).replace(API_PREFIX_RE, '') || '/';
}

/**
 * Match a path pattern against the request URL, ignoring any /api prefix.
 * @returns {RegExpMatchArray | null}
 */
export function matchPath(url, pattern) {
  return normalizedPath(url).match(pattern);
}

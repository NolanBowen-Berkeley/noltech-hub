// CORS — open for Hub (Electron file://) and dev (localhost).

export const CORS_HEADERS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-trace-id',
  'access-control-max-age':       '86400',
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

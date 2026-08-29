// HTTP response helpers. All JSON responses go through here so headers stay
// consistent (CORS, content-type, no-store). Errors include the trace_id so
// every failure can be cross-referenced with the worker tail.

import { CORS_HEADERS } from './cors.js';

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type':  'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function ok(data, traceId) {
  return json({ ok: true, ...data, traceId });
}

export function err(status, code, message, traceId, extra = {}) {
  return json({ ok: false, code, error: message, traceId, ...extra }, status);
}

export const errors = {
  unauthorized: (traceId) => err(401, 'unauthorized',  'missing or invalid bearer token', traceId),
  notFound:     (traceId, path) => err(404, 'not_found',     `route not found: ${path}`, traceId),
  badRequest:   (traceId, msg)  => err(400, 'bad_request',   msg, traceId),
  internal:     (traceId, msg)  => err(500, 'internal',      msg || 'internal error', traceId),
  upstream:     (traceId, msg)  => err(502, 'upstream',      msg || 'upstream call failed', traceId),
  timeout:      (traceId)       => err(504, 'timeout',       'upstream call timed out', traceId),
};

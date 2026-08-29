// ─── node:http ↔ Web Fetch adapter ───────────────────────────────────────────
// Every route handler in this codebase has the Workers signature
//   (Request, env, ctx, log) → Response
// using the WHATWG Request/Response globals. Node 20+ ships those globals, so
// rather than rewriting 40-odd files onto Express req/res, we translate at the
// edge: IncomingMessage → Request on the way in, Response → ServerResponse on
// the way out. The route layer stays byte-identical to the Worker version.

import { Readable } from 'node:stream';

const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

// Builds the absolute URL the Request constructor requires. node:http gives us
// only the path, so the authority comes from the Host header (falling back to
// the bound port for HTTP/1.0 clients that omit it).
function absoluteUrl(req, fallbackPort) {
  const host = req.headers.host || `localhost:${fallbackPort}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}${req.url || '/'}`;
}

export function toWebRequest(req, fallbackPort) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // node:http collapses repeated headers into an array (except set-cookie,
    // which it always arrays). Headers.append preserves both shapes.
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }

  const method = (req.method || 'GET').toUpperCase();
  const init = { method, headers };

  if (!BODYLESS_METHODS.has(method)) {
    init.body = Readable.toWeb(req);
    // Required by Node's fetch whenever a stream body is supplied.
    init.duplex = 'half';
  }

  return new Request(absoluteUrl(req, fallbackPort), init);
}

export async function sendWebResponse(res, response) {
  if (res.writableEnded) return;

  const headers = {};
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    headers[key] = value;
  }
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  if (cookies.length) headers['set-cookie'] = cookies;

  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  try {
    // Stream rather than buffer — /lots/all/stream is a long-lived SSE-style
    // response and image proxying can move multi-MB payloads.
    await Readable.fromWeb(response.body).pipe(res);
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('close', resolve);
      res.on('error', reject);
    });
  } catch (e) {
    // Client hung up mid-stream, or the upstream body errored. Nothing useful
    // left to send; just make sure the socket closes.
    if (!res.writableEnded) res.end();
    throw e;
  }
}

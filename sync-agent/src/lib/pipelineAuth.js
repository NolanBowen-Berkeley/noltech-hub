// ─── Pipeline auth header ────────────────────────────────────────────────────
// The noltech-pipeline service (formerly a Cloudflare Worker, now a local Node
// service on PIPELINE_URL) enforces bearer auth only when it was started with
// SHARED_AUTH_SECRET set. That's optional for a loopback-only install and
// required when it binds a LAN address — which is exactly the setup where this
// agent runs on a different box than the pipeline.
//
// Set PIPELINE_AUTH_SECRET in this agent's .env to the same value. Leave it
// unset for a same-host, loopback pipeline.

const SECRET = process.env.PIPELINE_AUTH_SECRET || process.env.SHARED_AUTH_SECRET || '';

// Merge into any existing headers rather than replacing them, so callers keep
// their Content-Type.
export function withPipelineAuth(headers = {}) {
  if (!SECRET) return headers;
  return { ...headers, Authorization: `Bearer ${SECRET}` };
}

export const pipelineAuthConfigured = Boolean(SECRET);

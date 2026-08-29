// Structured logging. Always writes JSON to console (visible in wrangler
// tail). If LOGFLARE_SOURCE_TOKEN is configured, also POSTs to Logflare
// via ctx.waitUntil so log shipping doesn't block the response.
//
// Usage:
//   const log = createLogger(env, ctx, { route: 'comps.lookup', traceId });
//   log.info('cache_hit', { query, count: 12 });
//   log.warn('brightdata_slow', { ms: 28000 });
//   log.error('upsert_failed', { table: 'sold_comps', err: e.message });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldLog(configured, level) {
  return (LEVELS[level] || 0) >= (LEVELS[configured] || 20);
}

export function createLogger(env, ctx, baseFields = {}) {
  const minLevel = env.CRON_LOG_LEVEL || 'info';

  function emit(level, event, fields = {}) {
    if (!shouldLog(minLevel, level)) return;
    const payload = { level, event, ...baseFields, ...fields, ts: new Date().toISOString() };
    // Console — always
    const line = JSON.stringify(payload);
    if (level === 'error')      console.error(line);
    else if (level === 'warn')  console.warn(line);
    else                        console.log(line);
    // Logflare — fire-and-forget
    if (env.LOGFLARE_SOURCE_TOKEN && env.LOGFLARE_API_KEY && ctx?.waitUntil) {
      ctx.waitUntil(shipToLogflare(env, payload));
    }
  }

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info:  (event, fields) => emit('info',  event, fields),
    warn:  (event, fields) => emit('warn',  event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (extra) => createLogger(env, ctx, { ...baseFields, ...extra }),
    // Exposed so handlers can stamp the trace id into their response bodies.
    // routes/health.js already reached for `log.baseFields.traceId`, which
    // never existed on the object and silently resolved to undefined.
    baseFields,
    traceId: baseFields.traceId,
  };
}

async function shipToLogflare(env, payload) {
  try {
    await fetch(`https://api.logflare.app/logs?source=${env.LOGFLARE_SOURCE_TOKEN}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key':    env.LOGFLARE_API_KEY,
      },
      body: JSON.stringify({ event_message: payload.event, metadata: payload }),
    });
  } catch {
    // Logging the failure-to-log creates a loop. Eat it.
  }
}

export function newTraceId() {
  // 12-char hex; collisions extremely unlikely within a single Worker invocation.
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

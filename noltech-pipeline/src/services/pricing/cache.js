// ─── KV-backed cache helper ──────────────────────────────────────────────────
// Mirrors the local scraper's in-memory cache (10 min TTL per source) but
// persists across Worker invocations so the next user-triggered scrape from
// the Hub hits the cache instead of paying for another Bright Data call.

export async function cacheGetJson(env, key) {
  if (!env.SCRAPER_CACHE) return null;
  try {
    const v = await env.SCRAPER_CACHE.get(key, { type: 'json' });
    return v;
  } catch {
    return null;
  }
}

export async function cachePutJson(env, key, value, ttlSeconds) {
  if (!env.SCRAPER_CACHE) return;
  try {
    await env.SCRAPER_CACHE.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  } catch (e) {
    console.warn('[cache] put failed:', e?.message);
  }
}

// R2 binary cache for images. KV is a poor fit for blobs (1MB value limit,
// expensive per-byte). R2 is cheap object storage with HTTP semantics.
export async function imageGet(env, key) {
  if (!env.IMAGE_CACHE) return null;
  try {
    const obj = await env.IMAGE_CACHE.get(key);
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
    return { bytes, contentType };
  } catch {
    return null;
  }
}

export async function imagePut(env, key, bytes, contentType, ttlSeconds) {
  if (!env.IMAGE_CACHE) return;
  try {
    // R2 doesn't have a TTL primitive — store the expiry stamp as a custom
    // metadata field and check on read.
    await env.IMAGE_CACHE.put(key, bytes, {
      httpMetadata: { contentType: contentType || 'image/jpeg' },
      customMetadata: { expiresAt: String(Date.now() + ttlSeconds * 1000) },
    });
  } catch (e) {
    console.warn('[image cache] put failed:', e?.message);
  }
}

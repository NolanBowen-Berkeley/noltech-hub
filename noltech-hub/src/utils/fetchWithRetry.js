// ─── Fetch with Retry ─────────────────────────────────────────────────────────
// Wraps fetch() with configurable retries, linear backoff, and timeout.

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {{ retries?: number, timeout?: number }} [config]
 * @returns {Promise<Response>}
 */
export default async function fetchWithRetry(url, options = {}, { retries = 2, timeout = 15000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok && attempt < retries && resp.status >= 500) {
        // Retry on server errors only
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      return resp;
    } catch (e) {
      if (attempt === retries) throw e;
      // Wait before retry (linear backoff)
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

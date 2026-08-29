// ─── Continuous-concurrency map ──────────────────────────────────────────────
// Direct port of mapWithConcurrency() in scraper/server.js. N workers each
// pull next index from a shared cursor until exhausted. Per-completion
// onProgress callback. shouldStop() polled before each new pick — in-flight
// items always resolve so partial results aren't lost.

export async function mapWithConcurrency(items, limit, fn, opts = {}) {
  const results = new Array(items.length);
  const { onProgress, shouldStop } = opts;
  let cursor = 0;
  let done = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (true) {
      if (shouldStop && shouldStop()) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err };
      }
      done++;
      if (onProgress) {
        try { onProgress(done, results[idx]); } catch {}
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ─── ExecutionContext shim ───────────────────────────────────────────────────
// Cloudflare hands every handler a `ctx` with waitUntil(promise), which keeps
// the isolate alive until background work settles. Routes across this codebase
// use it for fire-and-forget cache writes (see routes/lots.js) and log
// shipping (lib/logger.js).
//
// In a long-lived Node process there is nothing to keep alive, so waitUntil
// mainly needs to (a) not throw, and (b) not let a rejected background promise
// become an unhandled rejection that kills the process. It also tracks pending
// work so shutdown can drain it instead of cutting off half-written caches.

export function createExecutionContext(label = 'ctx') {
  const pending = new Set();

  return {
    waitUntil(promise) {
      if (!promise || typeof promise.then !== 'function') return;

      const tracked = Promise.resolve(promise)
        .catch((e) => {
          // Swallow — matches Workers semantics, where a failed waitUntil task
          // is logged but never surfaces to the client. Without this catch a
          // background cache write failure would crash the whole service.
          console.warn(`[${label}] background task failed:`, e?.message || e);
        })
        .finally(() => pending.delete(tracked));

      pending.add(tracked);
    },

    // Workers' passThroughOnException() is a no-op here: an unhandled throw is
    // already contained by the per-request try/catch in server.js.
    passThroughOnException() {},

    pendingCount() { return pending.size; },

    // Await outstanding background work, bounded so a hung fetch can't block
    // shutdown forever.
    async drain(timeoutMs = 5000) {
      if (pending.size === 0) return;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
      ]);
    },
  };
}

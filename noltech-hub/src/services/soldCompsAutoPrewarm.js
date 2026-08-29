// ─── Sold-Comps Auto-Prewarm ─────────────────────────────────────────────────
// Listens for `manifest:priced` events (fired by enrichmentService when a lot's
// manifest UPC pricing completes). For each priced item, kicks off a background
// sold-comps lookup so the data is ready by the time the user opens the lot.
//
// Cache-first: each lookup goes through fetchSoldComps, which short-circuits on
// a fresh Supabase row and skips the Lambda call entirely. Only items with no
// (or stale) cache entry actually hit the Lambda — and even then, the call is
// fire-and-forget so the user never waits.
//
// Throttle:
//   - One Lambda call at a time (sequential queue), 1.5s gap between calls.
//   - Per-manifest cap: prevents a 200-item lot from hammering the Lambda.
//   - Pi sync-agent has its own prewarmer running every 30 min; the two
//     coexist safely because Lambda checks Supabase first on every call.
//
// Skip rules — only prewarm queries that look like real product searches:
//   - Item must have either ebayTitle (UPC matched a real listing)
//     OR brand AND model both present.
//   - Generic titles like "Wireless Mouse Lot" or "Mixed Electronics" are
//     skipped — they'd return junk results and waste Lambda calls.

import eventBus from './eventBus';
import { fetchSoldComps, isLambdaConfigured } from './soldComps';
import { isCloudEnabled, getActiveWorkspace } from './supabase';

// Tunables — keep these conservative; Lambda + Bright Data both cost money per
// call. The cache covers most repeat queries, so only truly novel ones land
// here.
const THROTTLE_MS         = 1500;      // gap between Lambda calls
const MAX_PER_MANIFEST    = 30;        // cap items prewarmed per manifest event
const MAX_QUEUE_LENGTH    = 200;       // hard cap to avoid runaway memory if many manifests fire
const MIN_TITLE_LENGTH    = 12;        // titles shorter than this are too generic

// Module-level queue. Each entry: { query, workspaceId }.
// We process sequentially in a single timer chain.
const queue = [];
let processing = false;
let unsub = null;

// Pick the best query for a manifest item — prefer the matched eBay listing
// title (highest signal), fall back to brand+model. Returns null if neither
// is informative enough to be worth a sold-comps lookup.
function bestQueryFor(item) {
  if (!item) return null;
  const ebayTitle = (item.ebayTitle || '').trim();
  if (ebayTitle && ebayTitle.length >= MIN_TITLE_LENGTH) return ebayTitle;
  const brand = (item.brand || '').trim();
  const model = (item.model || '').trim();
  if (brand && model) {
    const combined = `${brand} ${model}`.trim();
    if (combined.length >= MIN_TITLE_LENGTH) return combined;
  }
  // Last resort: the raw manifest title. Often noisy, only use when we have
  // nothing else and the string is moderately specific.
  const title = (item.title || '').trim();
  if (title && title.length >= MIN_TITLE_LENGTH) return title;
  return null;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift();
      try {
        // fetchSoldComps does the cache check internally and only hits the
        // Lambda on a miss. We don't await its result for the caller — this
        // is purely a fire-and-forget warmer.
        await fetchSoldComps(next.query, { soldDays: 90, forceRefresh: false });
      } catch (err) {
        // Swallow — prewarm errors are non-fatal. The user can still hit
        // "Get sold comps" manually and see the failure surfaced there.
        // eslint-disable-next-line no-console
        console.warn('[soldCompsAutoPrewarm] prewarm failed:', next.query, err.message);
      }
      // Throttle between calls — gives Bright Data + Lambda some breathing
      // room and avoids triggering anti-bot heuristics.
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  } finally {
    processing = false;
  }
}

// Enqueue a manifest's priced items, respecting the per-manifest cap and
// per-process queue ceiling.
async function enqueueManifest({ manifestItems }) {
  if (!Array.isArray(manifestItems) || manifestItems.length === 0) return;
  // Bail early if cloud sync isn't configured — without Supabase there's no
  // cache to fill, and without the Lambda configured the calls just become
  // a no-op (still wastes time iterating). Cheaper to short-circuit.
  if (!isCloudEnabled) return;
  const workspaceId = await getActiveWorkspace().catch(() => null);
  if (!workspaceId) return;
  const lambdaReady = await isLambdaConfigured();
  // Even without a Lambda configured we DO want to read from cache (so other
  // teammates' workers might have populated it), but we can skip enqueueing
  // outright since fetchSoldComps will only return cached rows.
  if (!lambdaReady) return;

  // Dedupe queries within the manifest — multi-quantity manifests often
  // repeat the same listing; we only need one lookup per unique query.
  const seen = new Set();
  let added = 0;
  for (const item of manifestItems) {
    if (added >= MAX_PER_MANIFEST) break;
    const query = bestQueryFor(item);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ query, workspaceId });
    added++;
    if (queue.length >= MAX_QUEUE_LENGTH) break;
  }
  if (added > 0) processQueue();
}

// ─── Public lifecycle ─────────────────────────────────────────────────────────

export function startSoldCompsAutoPrewarm() {
  if (unsub) return; // already started
  unsub = eventBus.on('manifest:priced', (payload) => {
    enqueueManifest(payload).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[soldCompsAutoPrewarm] enqueue failed:', err.message);
    });
  });
}

export function stopSoldCompsAutoPrewarm() {
  if (unsub) {
    unsub();
    unsub = null;
  }
  queue.length = 0;
  processing = false;
}

// Visibility helper for diagnostics / debug UI.
export function getSoldCompsPrewarmStatus() {
  return {
    queueLength: queue.length,
    processing,
    listening: !!unsub,
  };
}

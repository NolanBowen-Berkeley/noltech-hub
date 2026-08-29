// ─── Background Enrichment Service ────────────────────────────────────────────
// Module-level singleton that runs manifest pricing in the background.
// Survives component unmounts — switching tabs won't kill in-flight pricing.
// Components subscribe to state updates via callbacks.

import { PIPELINE_BASE } from '../utils/constants';
import { decryptObject } from './crypto';
import eventBus from './eventBus';
import { mergeUpcCache, saveUpcCache } from '../utils/upcCacheMerge';

const KEY_BROWSE = 'noltech:arbitrage:browse-lots';

let _enrichments = {};       // { [lotId]: { status, manifestItems, totals, noAppId } }
let _listeners = new Set();  // Set of (enrichments) => void callbacks
let _aborted = false;
let _running = false;
let _runId = 0;              // Incremented on each run to detect stale completions

function notify() {
  const snapshot = { ..._enrichments };
  _listeners.forEach(fn => { try { fn(snapshot); } catch (e) { console.error('[enrichmentService] listener failed:', e); } });
}

/** Subscribe to enrichment state changes. Returns unsubscribe fn. */
export function onEnrichmentChange(fn) {
  _listeners.add(fn);
  // Immediately send current state
  fn({ ..._enrichments });
  return () => _listeners.delete(fn);
}

/** Get current enrichment state */
export function getEnrichments() {
  return { ..._enrichments };
}

/** Set enrichments (e.g. when restoring from storage).
 *  Automatically converts stale 'loading' entries to 'error' since
 *  no async work is actually running on restore. */
export function setEnrichments(data) {
  _enrichments = { ...data };
  // Clean up stale loading states from previous sessions
  for (const [id, entry] of Object.entries(_enrichments)) {
    if (entry.status === 'loading') {
      _enrichments[id] = { status: 'error' };
    }
  }
  _running = false;
  notify();
}

/** Clear all enrichments */
export function clearEnrichments() {
  _enrichments = {};
  notify();
}

/** Cancel any running enrichment */
export function cancelEnrichment() {
  _aborted = true;
  _running = false;
  // Mark all loading lots as error
  let changed = false;
  for (const [id, data] of Object.entries(_enrichments)) {
    if (data.status === 'loading') {
      _enrichments[id] = { status: 'error' };
      changed = true;
    }
  }
  if (changed) notify();
}

/** Is enrichment currently running? */
export function isEnriching() {
  return _running;
}

/** Persist enrichments to storage */
async function persistEnrichments() {
  try {
    const cached = await window.storage.get(KEY_BROWSE);
    if (cached && typeof cached === 'object') {
      cached.enrichments = _enrichments;
      await window.storage.set(KEY_BROWSE, cached);
    }
  } catch (e) { console.error('[enrichmentService] persist failed:', e); }
}

/**
 * Run enrichment for the given lots. Runs in background — safe across tab switches.
 * @param {object[]} lots - Array of lot objects to enrich
 * @param {function} [onCallStatsRefresh] - Optional callback after each batch to refresh eBay call stats
 * @param {object} [opts]
 * @param {boolean} [opts.force] - If true, re-enrich even lots that are already done
 */
export async function enrichLots(lots, onCallStatsRefresh, opts = {}) {
  if (_running) return; // Don't double-run
  _running = true;
  _aborted = false;
  const myRunId = ++_runId;
  const force = !!opts.force;

  // Filter to enrichable lots. Skip already-done lots unless force=true.
  const enrichableLots = (lots || []).filter(
    l => (force || _enrichments[l.id]?.status !== 'done') && (
      (l.source?.includes('techliq') && l.palletId && l.manifestSlug) ||
      false /* Liquidation.com uses MSRP-based estimation instead */
    )
  );

  if (!enrichableLots.length) {
    _running = false;
    return;
  }

  // Get eBay credentials
  let appId = '', certId = '';
  try {
    const rawCreds = await window.storage.get('noltech:ebay:token');
    const creds = await decryptObject(rawCreds || {});
    appId  = creds?.appId?.trim() || '';
    certId = creds?.certId?.trim() || '';
  } catch (e) { console.error('[enrichmentService] credential load failed:', e); }

  // Mark as loading
  for (const l of enrichableLots) {
    _enrichments[l.id] = { status: 'loading' };
  }
  notify();

  const LOT_CONCURRENCY = 5;

  const enrichOneLot = async (lot) => {
    try {
      const body = {
        palletId: lot.palletId,
        manifestSlug: lot.manifestSlug,
        appId,
        certId,
      };

      const resp = await fetch(`${PIPELINE_BASE}/api/lots/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // 5 minutes (was 2). Slow manifests + Lambda queueing can take longer
        // than 2 minutes — aborting at 2 was creating false failures.
        signal: AbortSignal.timeout(300000),
      });
      const data = await resp.json();

      if (data.success) {
        _enrichments[lot.id] = {
          status: 'done',
          manifestItems: data.manifestItems,
          totals: data.totals,
          noAppId: data.noAppId || false,
        };
        eventBus.emit('manifest:priced', { lotId: lot.id, manifestItems: data.manifestItems, totals: data.totals });
      } else {
        _enrichments[lot.id] = { status: 'error' };
      }
    } catch (e) {
      console.error('[enrichmentService] lot enrichment failed:', e);
      _enrichments[lot.id] = { status: 'error' };
    }
    notify();
  };

  for (let i = 0; i < enrichableLots.length; i += LOT_CONCURRENCY) {
    if (_aborted) break;
    const batch = enrichableLots.slice(i, i + LOT_CONCURRENCY);
    await Promise.all(batch.map(enrichOneLot));

    // Persist after each batch
    await persistEnrichments();
    if (onCallStatsRefresh) onCallStatsRefresh();

    // Sync UPC cache — merge instead of overwrite to preserve client-only
    // fields (cleanTitle, manual edits) and any UPCs the server doesn't
    // know about yet.
    try {
      const cacheResp = await fetch(`${PIPELINE_BASE}/api/upc-cache`, { signal: AbortSignal.timeout(5000) });
      const cacheData = await cacheResp.json();
      if (cacheData.success && cacheData.cache) {
        const local = (await window.storage.get('noltech:arbitrage:upc-cache')) || {};
        const merged = mergeUpcCache(local, cacheData.cache);
        await saveUpcCache(merged);
        eventBus.emit('sync:array-updated', { storageKey: 'noltech:arbitrage:upc-cache' });
      }
    } catch (e) { console.error('[enrichmentService] UPC cache sync failed:', e); }
  }

  // Only finalize if this run is still the active one (not superseded by cancel + restart)
  if (myRunId === _runId) {
    const doneCount = Object.values(_enrichments).filter(e => e.status === 'done').length;
    const errorCount = Object.values(_enrichments).filter(e => e.status === 'error').length;
    if (!_aborted) {
      eventBus.emit('notification:push', {
        type: errorCount > 0 ? 'warning' : 'success',
        title: 'Manifest Pricing Complete',
        message: `${doneCount} lot${doneCount !== 1 ? 's' : ''} priced${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
      });
    }
    _running = false;
  }
}

// ─── Lot Analysis Queue (Tier 39 auto-analyze) ────────────────────────────────
// Bridges the Liquidation.com scraper + manifest enricher to the local
// pipeline's analysis cron, which scores lots. Each queued lot, on
// detection, gets a queue row the analysis cron pulls and processes.
//
// Pre-filters at enqueue time to avoid wasting Bright Data budget on lots
// that obviously don't warrant deep analysis.

import { supabase, isCloudEnabled, getActiveWorkspace } from './supabase';
import { enrichManifest, summarizeManifest } from './manifestParser';
import { pipelineFetch } from './pipelineFetch';

// ── Configuration ────────────────────────────────────────────────────────────

// Skip enqueueing if the lot was already queued in the last N hours.
// Prevents duplicate scans across repeat scrapes.
const REQUEUE_COOLDOWN_HOURS = 24;

// Pre-filter: skip lots where current bid exceeds (manifest_msrp * this).
// Crude profitability gate — if someone's already bid 80% of the estimated
// MSRP, there's no meaningful upside in deep-analyzing.
const PREFILTER_BID_TO_MSRP_CEILING = 0.80;

// Pre-filter: skip lots with no extractable items in the manifest.
// (Empty manifest = nothing to price, nothing to score.)
const PREFILTER_MIN_ITEMS = 1;

// ── Internal: fetch a lot's manifest from the pipeline ──────────────────────

// Accepts either a full lot object or a bare URL. The pipeline serves
// GET /liquidation/manifest?lotId=<id> | ?lotUrl=<url>, responding with
// { ok, manifestUrl, headers, rows }. cloudRowsToItems() adapts those row
// arrays into the { title, brand, upc, qty, msrp } items enrichManifest wants.
async function fetchLotManifest(lotOrUrl) {
  const isObj = lotOrUrl && typeof lotOrUrl === 'object';
  const lotUrl = isObj ? lotOrUrl.url   : lotOrUrl;
  const lotId  = isObj ? lotOrUrl.lotId : null;
  if (!lotUrl && !lotId) return [];

  try {
    // The pipeline resolves either param, so prefer the ID when we have one
    // and let it derive the ID from the URL otherwise.
    const query = lotId
      ? `lotId=${encodeURIComponent(lotId)}`
      : `lotUrl=${encodeURIComponent(lotUrl)}`;
    const r = await pipelineFetch(`/api/lots/manifest?${query}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      console.warn(`[lotAnalysisQueue] manifest fetch failed: ${r.status}`);
      return [];
    }
    const data = await r.json();
    // Manifests come back as a { headers, rows } table. Older local-scraper
    // responses used a flat { items } array — still handled so a cached or
    // replayed response doesn't come back empty.
    if (data?.ok && Array.isArray(data.rows) && data.rows.length > 0) {
      return cloudRowsToItems(data.headers || [], data.rows);
    }
    return Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    console.warn(`[lotAnalysisQueue] manifest fetch error: ${err.message}`);
    return [];
  }
}

// Adapt the cloud worker's table-row shape (headers[] + rows[][]) to the
// item-object shape enrichManifest expects. Header heuristics mirror the
// worker's mapColumns logic, but kept here so we don't have to round-trip.
function cloudRowsToItems(headers, rows) {
  const lc = headers.map((h) => String(h || '').toLowerCase());
  const findIdx = (...patterns) => {
    for (const p of patterns) {
      const idx = lc.findIndex((h) => p.test(h));
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const idxDesc  = findIdx(/\bdescription\b/, /\bproduct\b/, /\bname\b/, /\btitle\b/, /\bitem\b/);
  const idxUpc   = findIdx(/\bupc\b/, /\bbarcode\b/, /\bean\b/, /\bgtin\b/);
  const idxQty   = findIdx(/\b(quantity|qty)\b/, /\bcount\b/, /\bunits?\b/);
  const idxMsrp  = findIdx(/\bmsrp\b/, /\bretail\b/, /\bunit\s+price\b/);
  const idxBrand = findIdx(/\bbrand\b/, /\bmanufacturer\b/);
  return rows
    .map((row) => ({
      title: idxDesc  !== -1 ? String(row[idxDesc] || '').trim() : '',
      brand: idxBrand !== -1 ? String(row[idxBrand] || '').trim() : null,
      upc:   idxUpc   !== -1 ? String(row[idxUpc] || '').replace(/\D/g, '') || null : null,
      qty:   idxQty   !== -1 ? Number(String(row[idxQty] || '').replace(/[^\d.]/g, '')) || 1 : 1,
      msrp:  idxMsrp  !== -1 ? Number(String(row[idxMsrp] || '').replace(/[^\d.]/g, '')) || null : null,
    }))
    .filter((it) => it.title && it.title.length > 1);
}

// ── Public: enqueue a single lot ─────────────────────────────────────────────

/**
 * Enqueue a Liquidation.com lot for auto-analysis.
 *
 * @returns {Promise<{ ok: boolean, status: 'queued' | 'skipped' | 'error',
 *                      reason?: string, queueId?: number }>}
 */
export async function enqueueLot(lot) {
  if (!isCloudEnabled || !supabase) {
    return { ok: false, status: 'error', reason: 'cloud_disabled' };
  }
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) {
    return { ok: false, status: 'error', reason: 'no_workspace' };
  }
  if (!lot || !lot.lotId || lot.source !== 'liquidation.com') {
    return { ok: false, status: 'error', reason: 'invalid_lot' };
  }

  // 1. Cooldown — skip if recently queued.
  try {
    const cutoff = new Date(Date.now() - REQUEUE_COOLDOWN_HOURS * 3600 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('lot_analysis_queue')
      .select('id, status, enqueued_at')
      .eq('workspace_id', workspaceId)
      .eq('lot_id', lot.lotId)
      .gte('enqueued_at', cutoff)
      .order('enqueued_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return { ok: true, status: 'skipped', reason: `cooldown (${existing.status})` };
    }
  } catch (e) {
    // Non-fatal — continue with enqueue
    console.warn('[lotAnalysisQueue] cooldown check failed (continuing):', e?.message || e);
  }

  // 2. Fetch + enrich manifest.
  const rawItems = await fetchLotManifest(lot);
  const items = enrichManifest(rawItems, lot);
  const summary = summarizeManifest(items);

  // 3. Pre-filters.
  if (summary.totalItems < PREFILTER_MIN_ITEMS) {
    return { ok: true, status: 'skipped', reason: 'no_manifest_items' };
  }
  // For the bid-vs-MSRP gate, prefer the scraper's own lot-level MSRP estimate
  // over the manifest sum. Liquidation.com's aucimg manifest is often a
  // partial preview (1-4 of N items) so summary.totalMsrp under-states the
  // true lot value and the gate false-positives. lot.estimation.totalMsrp is
  // computed at scrape time from the lot's posted retail and is far more
  // reliable for this comparison.
  const lotMsrp = Math.max(
    Number(lot?.estimation?.totalMsrp) || 0,
    Number(summary.totalMsrp) || 0,
  );
  if (lot.price > 0 && lotMsrp > 0) {
    const bidRatio = lot.price / lotMsrp;
    if (bidRatio > PREFILTER_BID_TO_MSRP_CEILING) {
      return { ok: true, status: 'skipped', reason: 'bid_too_close_to_msrp' };
    }
  }

  // 4. Insert queue row + manifest cache row.
  try {
    // 4a. Lot metadata
    await supabase
      .from('liquidation_lots_newegg')
      .upsert({
        workspace_id: workspaceId,
        lot_id: lot.lotId,
        title: lot.title,
        url: lot.url,
        seller: lot.seller || null,
        current_bid: lot.price || 0,
        num_bids: lot.numBids || 0,
        quantity: lot.quantity || null,
        condition: lot.condition || null,
        location: lot.location || null,
        ends_at: lot.endsAt || null,
        manifest_url: lot.manifestUrl || null,
        scraped_at: lot.scrapedAt || new Date().toISOString(),
      }, { onConflict: 'workspace_id,lot_id' });

    // 4b. Manifest rows
    if (items.length > 0) {
      const manifestRows = items.map((it, idx) => ({
        workspace_id: workspaceId,
        lot_id: lot.lotId,
        item_index: idx,
        description: it.title || '',
        brand: it.brand || null,
        upc: it.upc || null,
        quantity: it.qty || 1,
        msrp: it.msrp || null,
        category_raw: it.category || null,
        category_refined: it.categoryRefined || 'other',
        condition_raw: it.conditionRaw || null,
        condition: it.condition || 'unknown',
        model_guess: it.modelGuess || null,
      }));
      await supabase
        .from('liquidation_manifests')
        .upsert(manifestRows, { onConflict: 'workspace_id,lot_id,item_index' });
    }

    // 4c. Queue row
    const { data: queueRow, error: queueErr } = await supabase
      .from('lot_analysis_queue')
      .insert({
        workspace_id: workspaceId,
        lot_id: lot.lotId,
        status: 'pending',
        attempts: 0,
        enqueued_at: new Date().toISOString(),
        summary: summary,    // JSON snapshot for the worker's pre-filter
      })
      .select('id')
      .single();

    if (queueErr) {
      console.error('[lotAnalysisQueue] queue insert failed:', queueErr.message);
      return { ok: false, status: 'error', reason: queueErr.message };
    }

    return { ok: true, status: 'queued', queueId: queueRow.id };
  } catch (e) {
    console.error('[lotAnalysisQueue] enqueue exception:', e?.message || e);
    return { ok: false, status: 'error', reason: e?.message || 'unknown' };
  }
}

// ── Public: enqueue a batch of lots (used by post-scrape hook) ───────────────

// Cap manifest-fetch concurrency. Each call spawns a Puppeteer page in the
// scraper backend's shared browser. 8 is a safe default — gives ~8× speedup
// vs sequential without blasting Liquidation.com with simultaneous hits or
// blowing out the shared-browser RAM budget. Tune via window.storage setting
// (`noltech:arbitrage:enqueue-concurrency`) if your machine handles more.
const DEFAULT_ENQUEUE_CONCURRENCY = 8;

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = [];
  const n = Math.min(limit, items.length);
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

async function readEnqueueConcurrency() {
  try {
    const v = await window.storage.get('noltech:arbitrage:enqueue-concurrency');
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0 && n <= 30) return n;
  } catch {}
  return DEFAULT_ENQUEUE_CONCURRENCY;
}

/**
 * Enqueue many lots at once IN PARALLEL. Respects per-lot cooldown +
 * pre-filters. Manifest fetches happen concurrently with a configurable
 * cap so the scraper backend isn't overwhelmed.
 *
 * Returns { queued, skipped, errors, details } counts.
 */
export async function enqueueLots(lots) {
  const liqLots = lots.filter((l) => l && l.source === 'liquidation.com');
  if (liqLots.length === 0) {
    return { queued: 0, skipped: 0, errors: 0, details: [] };
  }

  const concurrency = await readEnqueueConcurrency();
  const results = await mapWithConcurrency(liqLots, concurrency, async (lot) => {
    const result = await enqueueLot(lot);
    return { lotId: lot.lotId, ...result };
  });

  const out = { queued: 0, skipped: 0, errors: 0, details: results };
  for (const r of results) {
    if (r.status === 'queued') out.queued += 1;
    else if (r.status === 'skipped') out.skipped += 1;
    else out.errors += 1;
  }
  return out;
}

// ── Public: read queue + analysis status for the UI ──────────────────────────

/**
 * Get the latest analysis status for a lot (queue + result, if any).
 * Returns null if no row exists.
 */
export async function getLotAnalysisStatus(lotId) {
  if (!isCloudEnabled || !supabase) return null;
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) return null;

  try {
    const [{ data: queue }, { data: result }] = await Promise.all([
      supabase
        .from('lot_analysis_queue')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('lot_id', lotId)
        .order('enqueued_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('lot_analyses')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('lot_id', lotId)
        .order('scored_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return { queue: queue || null, result: result || null };
  } catch (e) {
    console.warn('[lotAnalysisQueue] status read failed:', e?.message || e);
    return null;
  }
}

/**
 * Force-requeue a lot (user clicked "Redo analysis").
 * Bypasses cooldown by inserting a new row with status='pending'.
 */
export async function requeueLot(lotId, lotContext = null) {
  if (!isCloudEnabled || !supabase) return { ok: false, reason: 'cloud_disabled' };
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) return { ok: false, reason: 'no_workspace' };

  try {
    const { data, error } = await supabase
      .from('lot_analysis_queue')
      .insert({
        workspace_id: workspaceId,
        lot_id: lotId,
        status: 'pending',
        attempts: 0,
        force: true,
        enqueued_at: new Date().toISOString(),
        summary: lotContext?.summary || null,
      })
      .select('id')
      .single();
    if (error) return { ok: false, reason: error.message };
    return { ok: true, queueId: data.id };
  } catch (e) {
    return { ok: false, reason: e?.message || 'unknown' };
  }
}

// ─── Lot discovery — find new lots, enqueue them for analysis ──────────────
// The HTTP route and the cron driver share a single runDiscovery() function.
//
// Pipeline per invocation:
//   1. Ask the configured lot provider for the current listings
//   2. Dedupe against existing liquidation_lots_newegg (excludes dismissed)
//   3. Cooldown — skip if a queue row exists in the last 24h
//   4. Pre-filter — drop lots where bid/MSRP > BID_TO_MSRP_CEILING
//   5. Sort earliest-closing first; cap at MAX_NEW_PER_RUN
//   6. processLot() each in concurrent chunks: fetch manifest, dismiss if
//      empty, detect relists, upsert rows, enqueue for analysis

import { ok, errors } from '../lib/response.js';
import { getSupabase } from '../services/supabase.js';
import { getLotProvider, callProvider } from '../providers/index.js';
import { fetchAndParseManifest } from './manifest.js';
import { sanitizeText, isValidLotUrl } from '../shared/htmlUtils.js';

const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MANIFEST_BATCH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── HTTP route (POST /lots/discover) ────────────────────────────────────────
export async function discoverLotsRoute(_request, env, ctx, log) {
  const traceId = log?.baseFields?.traceId;
  const result = await runDiscovery(env, ctx, log.child({ route: 'discover.lots' }));
  if (!result.ok) return errors.upstream(traceId, result.error || 'discovery failed');
  return ok(result, traceId);
}

// ── Cron driver ─────────────────────────────────────────────────────────────
export async function runDiscoveryCron(env, ctx, log) {
  return runDiscovery(env, ctx, log);
}

// ── Core ────────────────────────────────────────────────────────────────────
async function runDiscovery(env, ctx, log) {
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId || !UUID_RE.test(workspaceId)) {
    log.error('workspace_id_invalid');
    return { ok: false, error: 'WORKSPACE_ID invalid or missing' };
  }
  const supabase = getSupabase(env);

  const maxNew        = Math.max(1, Math.min(50, Number(env.DISCOVERY_MAX_LOTS_PER_TICK) || Number(env.MAX_NEW_PER_RUN) || 10));
  const msrpCeiling   = Number(env.DISCOVERY_BID_CEILING_RATIO) || Number(env.BID_TO_MSRP_CEILING) || 0.80;
  const concurrency   = Math.max(1, Math.min(10, Number(env.DISCOVERY_CONCURRENCY) || Number(env.CONCURRENCY) || 5));
  const sources       = String(env.LOT_SOURCES || 'sample')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  log.info('start', { maxNew, msrpCeiling, concurrency, sources });

  // 1. Ask the provider for current listings, one call per configured source.
  let provider;
  try {
    provider = await getLotProvider(env);
  } catch (e) {
    log.error('provider_unavailable', { message: e?.message });
    return { ok: false, stage: 'search', error: e?.message };
  }

  const candidates = [];
  for (const source of sources) {
    const r = await callProvider(provider, 'searchLots', env, { source, page: 1, log });
    if (r?.supported === false) {
      log.warn('search_unsupported', { provider: provider.id });
      return { ok: false, stage: 'search', error: r.error };
    }
    if (!r?.ok) {
      log.warn('search_failed', { source, error: r?.error });
      continue;
    }
    for (const lot of (r.lots || [])) candidates.push(lot);
  }

  if (candidates.length === 0) {
    return { ok: true, status: 'no_candidates', searched: 0 };
  }
  log.info('candidates_found', { count: candidates.length, provider: provider.id });

  // 2. Dedupe against existing rows
  const lotIds = candidates.map((c) => c.lotId);
  const knownSet = new Set();
  for (let i = 0; i < lotIds.length; i += 50) {
    const chunk = lotIds.slice(i, i + 50);
    const { data, error } = await supabase
      .from('liquidation_lots_newegg')
      .select('lot_id')
      .eq('workspace_id', workspaceId)
      .in('lot_id', chunk);
    if (error) { log.error('dedupe_read_failed', { message: error.message }); return { ok: false, stage: 'dedupe', error: error.message }; }
    for (const r of (data || [])) knownSet.add(r.lot_id);
  }
  let fresh = candidates.filter((c) => !knownSet.has(c.lotId));
  if (fresh.length === 0) return { ok: true, status: 'all_known', searched: candidates.length, known: knownSet.size };

  // 3. Cooldown — skip if queued in last 24h
  const cutoff = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const cooldownSet = new Set();
  for (let i = 0; i < fresh.length; i += 50) {
    const chunk = fresh.slice(i, i + 50).map((c) => c.lotId);
    const { data, error } = await supabase
      .from('lot_analysis_queue')
      .select('lot_id')
      .eq('workspace_id', workspaceId)
      .gte('enqueued_at', cutoff)
      .in('lot_id', chunk);
    if (error) {
      log.error('cooldown_read_failed', { message: error.message });
      for (const c of fresh.slice(i, i + 50)) cooldownSet.add(c.lotId);
      continue;
    }
    for (const r of (data || [])) cooldownSet.add(r.lot_id);
  }
  fresh = fresh.filter((c) => !cooldownSet.has(c.lotId));

  // 4. Pre-filter (drop overbid lots)
  const filtered = [];
  const skipped  = [];
  for (const c of fresh) {
    if (Number.isFinite(c.msrp) && c.msrp > 0 && Number.isFinite(c.price)) {
      const ratio = c.price / c.msrp;
      if (ratio > msrpCeiling) {
        skipped.push({ lotId: c.lotId, reason: 'bid_to_msrp_ceiling', ratio: ratio.toFixed(2) });
        continue;
      }
    }
    filtered.push(c);
  }

  // 5. Earliest-closing first; cap
  filtered.sort((a, b) => {
    const ax = a.endsAt ? Date.parse(a.endsAt) : Infinity;
    const bx = b.endsAt ? Date.parse(b.endsAt) : Infinity;
    return ax - bx;
  });
  const toProcess = filtered.slice(0, maxNew);
  const deferred  = filtered.slice(maxNew).map((c) => ({ lotId: c.lotId, reason: 'cap_reached' }));

  log.info('processing', { candidates: candidates.length, fresh: fresh.length, postFilter: filtered.length, thisTick: toProcess.length });

  // 6. Process concurrently in chunks
  const results = [];
  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((lot) =>
        processLot(lot, env, supabase, workspaceId, log)
          .catch((e) => ({ lotId: lot.lotId, status: 'error', error: e?.message || String(e) }))
      ),
    );
    results.push(...batchResults);
  }

  const summary = {
    ok: true, status: 'completed',
    searched:        candidates.length,
    knownInDb:       knownSet.size,
    fresh:           fresh.length,
    skippedByFilter: skipped.length,
    deferredByCap:   deferred.length,
    enqueued:        results.filter((r) => r.status === 'enqueued').length,
    relistsCarried:  results.filter((r) => r.status === 'relist_carried').length,
    dismissed:       results.filter((r) => r.status === 'dismissed').length,
    failed:          results.filter((r) => r.status?.includes('failed') || r.status === 'error').length,
    results, skippedDetail: skipped, deferredDetail: deferred,
  };
  log.info('done', { enqueued: summary.enqueued, dismissed: summary.dismissed, failed: summary.failed });
  return summary;
}

// ── Process one new lot ────────────────────────────────────────────────────
async function processLot(lot, env, supabase, workspaceId, log) {
  if (!isValidLotUrl(lot.url)) return { lotId: lot.lotId, status: 'invalid_url', url: lot.url };

  let manifest;
  try {
    manifest = await fetchAndParseManifest(lot, env);
  } catch (e) {
    manifest = { ok: false, error: e?.message || 'fetch_threw', items: [] };
  }

  // Manifest fetch failed or empty — write a dismissal sentinel so the next
  // tick's dedupe skips this lot. Prevents the runaway retry loop.
  if (!manifest.ok || manifest.items.length === 0) {
    const reason = manifest.error || 'empty_manifest';
    await supabase.from('liquidation_lots_newegg').upsert({
      workspace_id: workspaceId,
      lot_id:       lot.lotId,
      title:        sanitizeText(lot.title, 500) || '(unknown)',
      url:          lot.url,
      seller:       sanitizeText(lot.seller, 200) || null,
      current_bid:  Number.isFinite(lot.price) ? lot.price : 0,
      num_bids:     Number.isFinite(lot.numBids) ? lot.numBids : 0,
      quantity:     sanitizeText(lot.quantity, 200),
      condition:    sanitizeText(lot.condition, 200),
      location:     sanitizeText(lot.location, 200),
      ends_at:      lot.endsAt || null,
      manifest_url: null,
      scraped_at:   new Date().toISOString(),
      dismissed_at: new Date().toISOString(),
      dismiss_reason: reason,
    }, { onConflict: 'workspace_id,lot_id' });
    return { lotId: lot.lotId, status: 'dismissed', reason };
  }

  const nowIso = new Date().toISOString();

  // Relist detection via manifest fingerprint
  const fingerprint = computeManifestFingerprint(manifest.items);
  let relistedFrom = null;
  let priorStartingBid = null;
  if (fingerprint) {
    try {
      const { data: priorRow } = await supabase
        .from('liquidation_lots_newegg')
        .select('lot_id, current_bid, scraped_at')
        .eq('workspace_id', workspaceId)
        .eq('manifest_fingerprint', fingerprint)
        .neq('lot_id', lot.lotId)
        .order('scraped_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priorRow) {
        relistedFrom = priorRow.lot_id;
        priorStartingBid = Number.isFinite(priorRow.current_bid) ? Number(priorRow.current_bid) : null;
        log.info('relist_detected', { lotId: lot.lotId, priorLot: relistedFrom, priorBid: priorStartingBid });
      }
    } catch (e) {
      log.warn('fingerprint_lookup_failed', { message: e?.message });
    }
  }

  // Upsert lot row
  const { error: lotErr } = await supabase
    .from('liquidation_lots_newegg')
    .upsert({
      workspace_id: workspaceId,
      lot_id:       lot.lotId,
      title:        sanitizeText(lot.title, 500) || '(unknown)',
      url:          lot.url,
      seller:       sanitizeText(lot.seller, 200) || null,
      current_bid:  Number.isFinite(lot.price) ? lot.price : 0,
      num_bids:     Number.isFinite(lot.numBids) ? lot.numBids : 0,
      quantity:     sanitizeText(lot.quantity, 200),
      condition:    sanitizeText(lot.condition, 200),
      location:     sanitizeText(lot.location, 200),
      ends_at:      lot.endsAt || null,
      manifest_url: manifest.manifestUrl || null,
      image_url:    lot.image || null,
      scraped_at:   nowIso,
      dismissed_at: null,
      dismiss_reason: null,
      manifest_fingerprint: fingerprint,
      relisted_from:        relistedFrom,
      prior_starting_bid:   priorStartingBid,
    }, { onConflict: 'workspace_id,lot_id' });
  if (lotErr) return { lotId: lot.lotId, status: 'lots_upsert_failed', error: lotErr.message };

  // Clear stale manifest rows
  const { error: delErr } = await supabase
    .from('liquidation_manifests')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('lot_id', lot.lotId);
  if (delErr) {
    await safeRollback(supabase, workspaceId, lot.lotId);
    return { lotId: lot.lotId, status: 'manifests_delete_failed', error: delErr.message };
  }

  // Batch-upsert manifest rows
  const manifestRows = manifest.items.map((it) => ({
    workspace_id:     workspaceId,
    lot_id:           lot.lotId,
    item_index:       it.item_index,
    description:      sanitizeText(it.description || it.title || '', 2000) || '(unknown)',
    brand:            sanitizeText(it.brand, 200),
    upc:              it.upc || null,
    quantity:         Number.isFinite(it.qty) && it.qty > 0 ? Math.round(it.qty) : 1,
    msrp:             Number.isFinite(it.msrp) ? it.msrp : null,
    category_raw:     null,
    category_refined: it.category_refined || it.categoryRefined || 'other',
    condition_raw:    sanitizeText(it.condition_raw || it.conditionRaw, 200),
    condition:        it.condition || 'unknown',
    model_guess:      sanitizeText(it.model_guess || it.modelGuess, 200),
  }));

  for (let i = 0; i < manifestRows.length; i += MANIFEST_BATCH) {
    const chunk = manifestRows.slice(i, i + MANIFEST_BATCH);
    const { error: manErr } = await supabase
      .from('liquidation_manifests')
      .upsert(chunk, { onConflict: 'workspace_id,lot_id,item_index' });
    if (manErr) {
      await safeRollback(supabase, workspaceId, lot.lotId);
      return { lotId: lot.lotId, status: 'manifests_insert_failed', error: manErr.message, chunkStart: i };
    }
  }

  const summary = manifest.summary || {};

  // Relist analysis carry-over
  if (relistedFrom) {
    try {
      const { data: priorAnalysis } = await supabase
        .from('lot_analyses')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('lot_id', relistedFrom)
        .maybeSingle();
      if (priorAnalysis) {
        const carry = {
          ...priorAnalysis,
          lot_id:    lot.lotId,
          scored_at: new Date().toISOString(),
          total_cost_to_score_usd: 0,
        };
        delete carry.id;
        const { error: copyErr } = await supabase
          .from('lot_analyses')
          .upsert(carry, { onConflict: 'workspace_id,lot_id' });
        if (!copyErr) {
          return {
            lotId: lot.lotId, status: 'relist_carried',
            items: manifest.items.length, totalMsrp: summary.totalMsrp,
            relistedFrom, priorStartingBid,
            title: (lot.title || '').slice(0, 80),
          };
        }
        log.warn('relist_carry_failed', { lotId: lot.lotId, message: copyErr.message });
      }
    } catch (e) {
      log.warn('relist_carry_threw', { message: e?.message });
    }
  }

  // Normal enqueue
  const { error: queueErr } = await supabase
    .from('lot_analysis_queue')
    .insert({
      workspace_id: workspaceId,
      lot_id:       lot.lotId,
      status:       'pending',
      attempts:     0,
      enqueued_at:  new Date().toISOString(),
      summary,
    });
  if (queueErr) {
    await safeRollback(supabase, workspaceId, lot.lotId);
    return { lotId: lot.lotId, status: 'queue_insert_failed', error: queueErr.message };
  }

  return {
    lotId: lot.lotId, status: 'enqueued',
    items: manifest.items.length, totalMsrp: summary.totalMsrp,
    title: (lot.title || '').slice(0, 80),
    relistedFrom, priorStartingBid,
  };
}

function computeManifestFingerprint(items) {
  if (!items || items.length < 3) return null;
  const norm = items.map((it) => {
    const upc = (it.upc || '').replace(/\D/g, '');
    const title = (it.description || it.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return `${upc}|${title}`;
  }).filter((s) => s !== '|' && s.length > 2).sort();
  if (norm.length < 3) return null;
  const blob = norm.join('\n');
  let h = 5381;
  for (let i = 0; i < blob.length; i++) h = ((h * 33) ^ blob.charCodeAt(i)) >>> 0;
  return `fp_${h.toString(36)}_${norm.length}`;
}

async function safeRollback(supabase, workspaceId, lotId) {
  try { await supabase.from('liquidation_manifests').delete().eq('workspace_id', workspaceId).eq('lot_id', lotId); } catch {}
  try { await supabase.from('liquidation_lots_newegg').delete().eq('workspace_id', workspaceId).eq('lot_id', lotId); } catch {}
}

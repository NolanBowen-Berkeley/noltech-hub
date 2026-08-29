// ─── Browse-Lots Refresh (sync-agent → Supabase) ───────────────────────
// Periodically asks the pipeline for fresh lots from techliquidators /
// liquidation.com / etc. and upserts them into the Supabase `browse_lots`
// table. The Hub subscribes to that table via Realtime so newly-fetched
// lots appear without the user clicking Refresh.
//
// Strategy:
//   1. Hit /api/lots/all on the pipeline. Pass the workspace's enabled
//      sources (read from Supabase workspace_settings) so we don't request
//      sources the user has disabled.
//   2. Bulk upsert each lot keyed by (workspace_id, id).
//   3. Optional: prune lots whose source returned successfully but no longer
//      includes them (auctions ended, listings removed) — older than 7d.
//
// Returns `{ added, updated, skipped, deleted, sources }` for the heartbeat.

import { withPipelineAuth } from '../lib/pipelineAuth.js';

const PIPELINE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min — covers Puppeteer + multiple sources
const PRUNE_AFTER_DAYS  = 7;
const UPSERT_CHUNK_SIZE = 200;

export async function syncBrowseLots({ supabase, workspaceId, pipelineUrl, logger }) {
  // 1. Read enabled sources from the workspace_settings table so we honor
  //    the user's Settings → Sources toggles. Falls back to all-sources if
  //    the field is missing.
  let sourceParam = '';
  try {
    const { data: settings } = await supabase
      .from('workspace_settings')
      .select('sources')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const enabled = settings?.sources?.enabled;
    if (Array.isArray(enabled) && enabled.length) {
      sourceParam = `?sources=${enabled.join(',')}`;
    }
  } catch (e) {
    logger?.warn({ err: e.message }, 'browse-lots: source config read failed; defaulting to all');
  }

  // 2. Call the pipeline. /api/lots/all returns { ok, lots, sources }.
  const url = `${pipelineUrl}/api/lots/all${sourceParam}`;
  logger?.info({ url }, 'browse-lots: requesting lots');
  const res = await fetch(url, { headers: withPipelineAuth(), signal: AbortSignal.timeout(PIPELINE_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Pipeline returned HTTP ${res.status}`);
  }
  const data = await res.json();
  const fetchedLots = Array.isArray(data?.lots) ? data.lots : [];
  // Never persist generated data. The pipeline's default provider produces
  // plausible-looking fixtures; writing those into the workspace's browse_lots
  // would put fake auctions in front of real bidding decisions.
  if (data?.sample || data?.mock) {
    logger?.info('browse-lots: pipeline returned sample data — skipping upsert');
    return { added: 0, updated: 0, skipped: fetchedLots.length, deleted: 0, sample: true };
  }
  if (!fetchedLots.length) {
    logger?.warn({ errors: data?.errors }, 'browse-lots: zero lots returned');
    return { added: 0, updated: 0, skipped: 0, deleted: 0, errors: data?.errors };
  }

  const sourcesSeen = new Set(fetchedLots.map((l) => l.source).filter(Boolean));
  const scrapedAtIso = new Date().toISOString();

  // 3. Build upsert rows. Drop lots without a stable id — without that,
  //    the conflict target can't dedupe and we'd insert duplicates.
  const rows = fetchedLots
    .filter((l) => l && l.id)
    .map((l) => ({
      id: String(l.id),
      workspace_id: workspaceId,
      source: l.source || 'unknown',
      data: l,
      scraped_at: scrapedAtIso,
    }));

  // 4. Chunked upsert (Supabase has a default 1000-row limit; we use 200
  //    to keep payloads small and avoid PostgREST URL issues).
  let upsertedCount = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error: upErr } = await supabase
      .from('browse_lots')
      .upsert(chunk, { onConflict: 'workspace_id,id' });
    if (upErr) {
      throw new Error(`browse_lots UPSERT failed: ${upErr.message}`);
    }
    upsertedCount += chunk.length;
  }

  // 5. Prune lots that haven't been seen in PRUNE_AFTER_DAYS — only for
  //    sources that returned successfully this run (don't delete TL lots
  //    if TL itself was down). Conservative: only mark as gone after a week.
  const cutoffIso = new Date(Date.now() - PRUNE_AFTER_DAYS * 86400 * 1000).toISOString();
  let deleted = 0;
  if (sourcesSeen.size > 0) {
    const { count, error: delErr } = await supabase
      .from('browse_lots')
      .delete({ count: 'exact' })
      .eq('workspace_id', workspaceId)
      .in('source', Array.from(sourcesSeen))
      .lt('scraped_at', cutoffIso);
    if (delErr) {
      logger?.warn({ err: delErr.message }, 'browse-lots: prune failed (non-fatal)');
    } else {
      deleted = count || 0;
    }
  }

  const summary = {
    upserted: upsertedCount,
    deleted,
    sources: Array.from(sourcesSeen),
    scrapedAt: scrapedAtIso,
    fetchedErrors: Array.isArray(data?.errors) ? data.errors.length : 0,
  };
  logger?.info(summary, 'browse-lots: sync complete');
  return summary;
}

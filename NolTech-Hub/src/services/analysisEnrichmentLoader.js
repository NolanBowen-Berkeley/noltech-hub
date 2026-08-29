// ─── Analysis → enrichment loader ────────────────────────────────────────────
// Bridges the auto-analyze-worker's output (lot_analyses + liquidation_manifests
// in Supabase) into the in-memory enrichments state BrowseLotsView already
// consumes. The cron has been paying for sold-comps pricing on every
// lot it scores — this lets the Hub READ that work instead of asking
// the user to re-pay via the Price Manifests button.
//
// Why this exists: before this loader, the cron's analysis was visible only
// in Tier 39 dashboard. The full pricing grid on each LotCard stayed empty
// until the user clicked Price Manifests, which re-ran the same Lambda calls
// the cron had already paid for. Net effect of this loader: any lot the cron
// has analyzed displays its full pricing automatically on Fetch.

import { supabase, getActiveWorkspace } from './supabase';

// Convert a single `item_results[]` entry (auto-analyze pipeline shape) into
// the `manifestItems[]` entry shape BrowseLotsView expects.
function mapItemResultToManifestItem(itemResult, manifestItem) {
  const description = itemResult?.description || manifestItem?.description || '';
  const qty = Number.isFinite(Number(itemResult?.qty)) ? Number(itemResult.qty) : (Number(manifestItem?.quantity) || 1);
  const avgPrice  = Number.isFinite(Number(itemResult?.unit_market_price)) ? Number(itemResult.unit_market_price) : null;
  // Q1 / Q3 added to pipeline.js — older rows have these undefined; use ?? null so missing values render as "—" in the UI.
  const lowPrice  = Number.isFinite(Number(itemResult?.unit_low_price))  ? Number(itemResult.unit_low_price)  : null;
  const highPrice = Number.isFinite(Number(itemResult?.unit_high_price)) ? Number(itemResult.unit_high_price) : null;
  const found = !!itemResult?.priced && avgPrice != null && avgPrice > 0;
  return {
    title:       description,
    ebayTitle:   description,
    brand:       manifestItem?.brand || null,
    upc:         manifestItem?.upc || null,
    qty,
    msrp:        Number(manifestItem?.msrp) || null,
    category:    itemResult?.category || manifestItem?.category_refined || 'other',
    condition:   itemResult?.condition || manifestItem?.condition || 'unknown',
    avgPrice,
    lowPrice,
    highPrice,
    numSales:    Number(itemResult?.comp_count) || 0,
    found,
    priceSource: 'sold-comps-cache',
    cachedAt:    null,
  };
}

// Load enrichments for a list of lot IDs, sourced from prior auto-analyze
// runs. Returns a Map<lotId, enrichmentObject> shaped like BrowseLotsView's
// `enrichments` state. Lots without a prior analysis are simply absent —
// caller merges into existing state.
export async function loadEnrichmentsFromAnalyses(lotIds) {
  if (!Array.isArray(lotIds) || lotIds.length === 0) return new Map();
  const workspaceId = await getActiveWorkspace();
  if (!workspaceId) return new Map();

  // Strip the source-prefix from Hub-side lot IDs ("liq-12345678" → "12345678")
  // since auto-analyze writes raw lot_ids. The Hub stores both forms in
  // lot.id (prefixed) and lot.lotId (raw) — we accept either form for safety.
  const rawIds = lotIds.map((id) => String(id || '').replace(/^liq-/, ''));

  // Parallel reads — analyses + manifests for the same lot_ids.
  const [analysesRes, manifestsRes] = await Promise.all([
    supabase
      .from('lot_analyses')
      .select('lot_id, item_results, scenarios, recommendation, scored_at')
      .eq('workspace_id', workspaceId)
      .in('lot_id', rawIds),
    supabase
      .from('liquidation_manifests')
      .select('lot_id, item_index, description, brand, upc, quantity, msrp, category_refined, condition')
      .eq('workspace_id', workspaceId)
      .in('lot_id', rawIds),
  ]);

  if (analysesRes.error) {
    console.warn('[analysisEnrichmentLoader] lot_analyses read failed:', analysesRes.error.message);
    return new Map();
  }
  const analyses = analysesRes.data || [];
  const manifests = manifestsRes.data || [];

  // Index manifests by lot_id → item_index → row for quick joins.
  const manifestsByLot = new Map();
  for (const m of manifests) {
    if (!manifestsByLot.has(m.lot_id)) manifestsByLot.set(m.lot_id, new Map());
    manifestsByLot.get(m.lot_id).set(m.item_index, m);
  }

  const out = new Map();
  for (const a of analyses) {
    const itemResults = Array.isArray(a.item_results) ? a.item_results : [];
    if (itemResults.length === 0) continue;

    const manifestByIdx = manifestsByLot.get(a.lot_id) || new Map();
    const manifestItems = itemResults.map((ir) =>
      mapItemResultToManifestItem(ir, manifestByIdx.get(ir.item_index))
    );

    // Totals derived from item_results so they always agree with the lot's
    // priced rows (rather than racing against a different calculation).
    let estResale = 0, numItems = 0, numPriced = 0;
    for (const it of manifestItems) {
      const q = Number.isFinite(it.qty) && it.qty > 0 ? it.qty : 1;
      numItems += q;
      if (it.found && Number.isFinite(it.avgPrice)) {
        numPriced += q;
        estResale += it.avgPrice * q;
      }
    }

    out.set(a.lot_id, {
      status:        'done',
      noAppId:       false,
      manifestItems,
      totals: {
        estResale: Math.round(estResale * 100) / 100,
        numItems,
        numPriced,
      },
      _source: 'auto_analyze_cron',  // sentinel so the UI can tell the source apart if useful
      _scoredAt: a.scored_at,
    });
  }

  // Map the cron's raw lot_ids back to whatever id form the caller passed.
  // BrowseLotsView keys enrichments by lot.id (which is `liq-${lotId}` for
  // Liquidation.com lots), so produce both keys to make matching idempotent.
  const remapped = new Map();
  for (const id of lotIds) {
    const raw = String(id || '').replace(/^liq-/, '');
    const entry = out.get(raw);
    if (entry) remapped.set(id, entry);
  }
  return remapped;
}

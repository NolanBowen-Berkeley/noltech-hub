// ─── Sample provider ─────────────────────────────────────────────────────────
// The default lot + comps provider. Serves deterministic generated data from
// src/providers/fixtures.js — no network calls, no credentials, no terms of
// service to honor.
//
// It exists so that a fresh clone actually runs: the browse UI populates, the
// analysis queue drains, the scoring model produces numbers, and the crons
// exercise both the "auction still open" and "auction ended" branches. What it
// cannot do is tell you anything true about the market. Swap in a real
// provider before making a purchase decision with this — see
// docs/DATA-SOURCES.md.

import {
  sampleLots,
  sampleManifestTable,
  sampleLotState,
  samplePlaceholderImage,
  sampleSoldComps,
} from './fixtures.js';

const SAMPLE_SOURCE = 'sample';

function lotIdFrom({ lotId, lotUrl }) {
  if (lotId) return String(lotId).replace(/[^\w-]/g, '');
  if (!lotUrl) return null;
  const m = String(lotUrl).match(/[?&]id=(\w+)/) || String(lotUrl).match(/\/lots?\/(\w+)/);
  return m ? m[1] : null;
}

export const lotProvider = {
  id:    'sample',
  label: 'Sample data (generated, offline)',

  async searchLots(env, { source = SAMPLE_SOURCE, page = 1, count, log } = {}) {
    const perPage = Math.max(1, Math.min(60, Number(count) || Number(env.SAMPLE_LOTS_PER_PAGE) || 24));
    const lots = sampleLots({ count: perPage, page: Number(page) || 1, source });
    log?.info?.('sample_search_lots', { source, page, count: lots.length });
    return { ok: true, source, lots, page: Number(page) || 1, sample: true };
  },

  async fetchManifest(env, { lotId, lotUrl, log } = {}) {
    const id = lotIdFrom({ lotId, lotUrl });
    if (!id) return { ok: false, error: 'invalid_lot_id' };
    const { headers, rows } = sampleManifestTable(id);
    log?.info?.('sample_manifest', { lotId: id, rows: rows.length });
    return {
      ok: true,
      manifestUrl: `sample://manifests/${id}`,
      headers,
      rows,
      sample: true,
    };
  },

  async fetchLotState(env, { lotId, lotUrl, log } = {}) {
    const id = lotIdFrom({ lotId, lotUrl });
    if (!id) return { ok: false, error: 'invalid_lot_id', status: 'not_found' };
    const state = sampleLotState(id);
    log?.info?.('sample_lot_state', { lotId: id, status: state.status });
    return { ...state, fetchedAt: new Date().toISOString(), sample: true };
  },

  async fetchImage(env, _args = {}) {
    // Always the same 1x1 placeholder — the sample provider has no imagery.
    return samplePlaceholderImage();
  },
};

export const compsProvider = {
  id:          'sample',
  label:       'Sample sold comparables (generated, offline)',
  sourceLabel: 'sample',

  async lookup(env, { query, condition = 'any', soldDays = 90, maxResults = 60, log } = {}) {
    const limit = Math.max(1, Math.min(200, Number(maxResults) || 60));
    const { items, total } = sampleSoldComps(query, { maxResults: limit, soldDays, condition });
    log?.info?.('sample_comps', { query: String(query || '').slice(0, 60), count: items.length });
    return { ok: true, items, total, sample: true };
  },
};

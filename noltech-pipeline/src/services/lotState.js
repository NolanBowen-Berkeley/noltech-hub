// ─── Lot state lookup ────────────────────────────────────────────────────────
// One helper over the configured lot provider's fetchLotState, shared by the
// refresh cron (keeps current_bid / ends_at fresh) and the bid-alerts cron
// (decides when to fire a phone alert).
//
// Normalizes every failure mode into the same `{ ok: false, error }` shape so
// callers never have to distinguish "provider missing" from "provider said no"
// — both mean the same thing to a cron: skip this lot, try again next tick.

import { getLotProvider, callProvider } from '../providers/index.js';

/**
 * @param {string|null} lotUrl
 * @param {object}      env
 * @param {object}     [opts]  { lotId, log }
 * @returns {Promise<{ok: true, ended, status, currentPrice, finalBid, endsAt}
 *                  | {ok: false, error}>}
 */
export async function getLotState(lotUrl, env, opts = {}) {
  const lotId = opts.lotId || null;
  if (!lotUrl && !lotId) return { ok: false, error: 'invalid_url' };

  let provider;
  try {
    provider = await getLotProvider(env);
  } catch (e) {
    return { ok: false, error: e?.message || 'provider_unavailable' };
  }

  const r = await callProvider(provider, 'fetchLotState', env, { lotId, lotUrl, log: opts.log });
  if (r?.supported === false) return { ok: false, error: r.error || 'lot_state_unsupported' };
  if (!r?.ok)                 return { ok: false, error: r?.error || 'lot_state_failed' };
  return r;
}

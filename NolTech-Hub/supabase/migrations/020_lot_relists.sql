-- ─── Relist detection support ────────────────────────────────────────────────
-- Liquidation.com gives every relisted auction a new lot_id even when the
-- manifest is identical. To recognize relists, the discovery worker now
-- computes a `manifest_fingerprint` from the sorted UPC + description list
-- when it ingests a lot. When the same fingerprint already exists in the
-- table from a prior listing, the new lot:
--   - records `relisted_from` = the prior lot_id
--   - records `prior_starting_bid` = the prior lot's last seen current_bid
--   - has the prior lot_analyses row copied across (skips re-analysis)
--
-- Backward compat: existing rows have NULL fingerprint and never match.

ALTER TABLE public.liquidation_lots_newegg
  ADD COLUMN IF NOT EXISTS manifest_fingerprint text,
  ADD COLUMN IF NOT EXISTS relisted_from        text,
  ADD COLUMN IF NOT EXISTS prior_starting_bid   numeric;

-- Fast fingerprint lookup for the relist check at enqueue time.
CREATE INDEX IF NOT EXISTS idx_liq_lots_newegg_fingerprint
  ON public.liquidation_lots_newegg (workspace_id, manifest_fingerprint)
  WHERE manifest_fingerprint IS NOT NULL;

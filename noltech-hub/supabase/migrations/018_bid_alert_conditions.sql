-- ─── Per-bid alert preset ────────────────────────────────────────────────────
-- Adds bids.alert_conditions so the bid-alerts Worker can apply a different
-- rule per bid (standard / early / last_call / any_price / muted).
-- Worker reads this column; UI dropdown in BidTracker writes it.

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS alert_conditions text;

-- Backfill anything pre-existing with the default preset so the Worker
-- doesn't need to coalesce null on every iteration.
UPDATE bids SET alert_conditions = 'standard'
WHERE alert_conditions IS NULL;

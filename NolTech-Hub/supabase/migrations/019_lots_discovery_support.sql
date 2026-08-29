-- ─── Lots-discovery worker support ──────────────────────────────────────────
-- Adds a dismissal sentinel to liquidation_lots_newegg so the discovery
-- cron can mark "this lot's manifest couldn't be fetched / was empty" and
-- skip it on every subsequent tick instead of re-fetching every 30 min.
--
-- dismissed_at IS NULL = active row (eligible for analysis)
-- dismissed_at IS NOT NULL = sentinel row (skip on rediscovery)
--
-- The Hub UI can also set this when the user manually dismisses a lot they
-- don't want to bid on; the discovery worker's dedupe will then ignore it.

ALTER TABLE public.liquidation_lots_newegg
  ADD COLUMN IF NOT EXISTS dismissed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS dismiss_reason text;

-- Partial index for the active-lots lookup. Helps the auto-analyze worker
-- and BrowseLotsView avoid scanning dismissed rows.
CREATE INDEX IF NOT EXISTS idx_liq_lots_newegg_active
  ON public.liquidation_lots_newegg (workspace_id, lot_id)
  WHERE dismissed_at IS NULL;

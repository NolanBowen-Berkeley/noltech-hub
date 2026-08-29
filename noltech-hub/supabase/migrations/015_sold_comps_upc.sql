-- ─── Migration 015: Sold Comps UPC tagging ─────────────────────────────────
-- Adds a `upc` column to sold_comps so callers can find prices by barcode
-- without having to compute the same normalized query string the Lambda
-- used. Enables Hub-side "pull all UPC-priced data from cloud into local
-- IndexedDB" without depending on a query-key reverse lookup.
--
-- The Lambda will populate this when callers pass a `upc` field. Existing
-- rows have null upc; rescrapes will gradually fill them in. We don't
-- backfill — too risky (a query like "Apple iPhone 13" might match
-- multiple UPCs and we'd guess wrong).

ALTER TABLE sold_comps
  ADD COLUMN IF NOT EXISTS upc text;

-- Fast workspace-scoped UPC lookup. The Hub's pull-by-UPC flow queries
-- "all sold_comps in workspace where upc is not null and scraped_at > X".
CREATE INDEX IF NOT EXISTS idx_sold_comps_workspace_upc
  ON sold_comps(workspace_id, upc)
  WHERE upc IS NOT NULL;

-- Optional: enforce 12-13 digit format on upc to catch typos. Lambda
-- writes are validated in code, but a CHECK constraint catches manual
-- inserts via Supabase Studio.
ALTER TABLE sold_comps
  DROP CONSTRAINT IF EXISTS sold_comps_upc_format;
ALTER TABLE sold_comps
  ADD CONSTRAINT sold_comps_upc_format
  CHECK (upc IS NULL OR upc ~ '^[0-9]{12,13}$');

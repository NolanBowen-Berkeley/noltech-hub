-- ─── Migration 012: Sold Comps Cache ─────────────────────────────────────────
-- Cached eBay sold-listings data scraped via the AWS Lambda + Bright Data
-- pipeline. Each row holds the aggregate stats + a JSONB array of sample
-- listings for one normalized query. TTL is enforced in the Lambda by
-- comparing scraped_at against now() — rows older than 14 days trigger a
-- re-scrape; older rows are kept indefinitely so we always have SOMETHING
-- to show even when the scraper is down.

CREATE TABLE IF NOT EXISTS sold_comps (
  -- Composite primary key: workspace + cache_key. Cache key is the
  -- normalized query + sold-days window (e.g. "12 9 ipad pro:90").
  cache_key text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Original (non-normalized) query that produced this row, for display.
  query text NOT NULL,
  sold_days integer NOT NULL DEFAULT 90,

  -- Aggregate stats computed by the Lambda.
  count integer NOT NULL DEFAULT 0,
  median_price numeric(10,2),
  low_price numeric(10,2),
  high_price numeric(10,2),
  avg_price numeric(10,2),

  -- Sample listings (capped at ~60 per row). JSONB array of:
  --   { itemId, title, conditionLabel, price, currency, shippingCost,
  --     totalPrice, soldAt, imageUrl, itemUrl }
  samples jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Bookkeeping.
  scraped_at timestamptz NOT NULL DEFAULT now(),
  scraped_by text,                 -- 'lambda' | 'pi' | 'manual'
  source text NOT NULL DEFAULT 'brightdata',
  raw_html_size integer,           -- bytes of raw HTML (for debugging parser regressions)
  parser_version text,             -- bump when parser changes; old cached rows can be re-scraped

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, cache_key)
);

-- Fast lookup by recency (UI shows "comps from 3 days ago" etc).
CREATE INDEX IF NOT EXISTS idx_sold_comps_workspace_recent
  ON sold_comps(workspace_id, scraped_at DESC);

-- Fast lookup by query for autocomplete / "recent searches".
CREATE INDEX IF NOT EXISTS idx_sold_comps_query
  ON sold_comps(workspace_id, query);

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE sold_comps ENABLE ROW LEVEL SECURITY;

-- Workspace members can read.
DROP POLICY IF EXISTS members_read_sold_comps ON sold_comps;
CREATE POLICY members_read_sold_comps ON sold_comps
  FOR SELECT USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

-- Workspace members can insert/update (so the Hub can manually trigger a
-- request via the Lambda from any teammate's session).
DROP POLICY IF EXISTS members_write_sold_comps ON sold_comps;
CREATE POLICY members_write_sold_comps ON sold_comps
  FOR INSERT WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS members_update_sold_comps ON sold_comps;
CREATE POLICY members_update_sold_comps ON sold_comps
  FOR UPDATE USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

-- Service role (Lambda) bypasses RLS automatically — no policies needed.

-- ─── Auto-update updated_at on row changes ─────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_sold_comps_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sold_comps_updated_at ON sold_comps;
CREATE TRIGGER sold_comps_updated_at
  BEFORE UPDATE ON sold_comps
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sold_comps_updated_at();

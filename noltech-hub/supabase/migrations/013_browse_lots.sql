-- ─── Migration 013: Browse Lots Cache ────────────────────────────────────────
-- Cached scraped lots from techliquidators.com / liquidation.com / etc.
-- Populated by the AWS sync-agent's `scrape-lots` cron (every N hours).
-- The Hub subscribes to changes via Supabase Realtime so newly-scraped lots
-- appear without the user clicking Refresh.
--
-- Each row is one lot. The `data` JSONB column holds the full lot object as
-- the scraper produces it (title, price, palletId, manifestSlug, condition,
-- auction.endsAt, estimation, metrics, etc.) — schema flexibility so we
-- don't need a migration each time the scraper output evolves.

CREATE TABLE IF NOT EXISTS browse_lots (
  -- lot.id from the scraper (e.g. "CSRA413507", auction-id, etc.)
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Source slug: 'techliquidators' | 'liquidation' | 'bstock' | etc.
  source text NOT NULL,

  -- Full lot object as JSONB — see scraper/scrapers/*.js for shape.
  data jsonb NOT NULL,

  -- When the scraper last saw this lot. Used by the Hub to decide whether
  -- to refresh the local browse-lots cache and to surface "Stale" warnings.
  scraped_at timestamptz NOT NULL DEFAULT now(),

  -- Bookkeeping.
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, id)
);

-- Fast lookup by recency for incremental Hub-side reads.
CREATE INDEX IF NOT EXISTS idx_browse_lots_workspace_recent
  ON browse_lots(workspace_id, scraped_at DESC);

-- Fast filter by source so the Hub can pull just one provider.
CREATE INDEX IF NOT EXISTS idx_browse_lots_workspace_source
  ON browse_lots(workspace_id, source, scraped_at DESC);

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE browse_lots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_read_browse_lots ON browse_lots;
CREATE POLICY members_read_browse_lots ON browse_lots
  FOR SELECT USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS members_write_browse_lots ON browse_lots;
CREATE POLICY members_write_browse_lots ON browse_lots
  FOR INSERT WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS members_update_browse_lots ON browse_lots;
CREATE POLICY members_update_browse_lots ON browse_lots
  FOR UPDATE USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS members_delete_browse_lots ON browse_lots;
CREATE POLICY members_delete_browse_lots ON browse_lots
  FOR DELETE USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

-- Service role (sync-agent) bypasses RLS automatically — no policies needed.

-- ─── Auto-update updated_at on row changes ─────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_browse_lots_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS browse_lots_updated_at ON browse_lots;
CREATE TRIGGER browse_lots_updated_at
  BEFORE UPDATE ON browse_lots
  FOR EACH ROW
  EXECUTE FUNCTION trigger_browse_lots_updated_at();

-- ─── Realtime publication ──────────────────────────────────────────────────
-- Hub subscribes via supabase.channel(workspace).on('postgres_changes', ...)
-- so newly-scraped lots appear without polling.
ALTER PUBLICATION supabase_realtime ADD TABLE browse_lots;

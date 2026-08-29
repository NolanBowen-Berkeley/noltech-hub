-- ─── Migration 014: Lot Closes ───────────────────────────────────────────────
-- Captures the final winning bid / closing state for ended auctions across
-- techliquidators, liquidation.com, etc. Populated by the AWS sync-agent's
-- `lot-closes` cron, which polls the local scraper for any browse_lots whose
-- auction.endsAt is in the past and that don't already have a close row.
--
-- Two use cases:
--   1. "What did this lot actually go for?" (comparable-closes signal,
--      analytics, tracking lots you watched but didn't bid on).
--   2. Auto-determine win/loss for the user's bids — when a close lands,
--      the same cron updates any matching `bids` row to status='won' or
--      'lost' based on whether bid.bidCeiling >= closing_price.

CREATE TABLE IF NOT EXISTS lot_closes (
  -- lot.id from browse_lots (techliquidators palletId, liquidation auction-id, etc.)
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  source text NOT NULL,
  closing_price numeric(10,2),         -- final winning bid; null if no_bids / pulled
  closing_status text,                 -- 'sold' | 'no_bids' | 'pulled' | 'unknown'
  num_bids int,
  ended_at timestamptz,                -- when the auction officially ended
  detected_at timestamptz NOT NULL DEFAULT now(), -- when the cron captured this

  -- Full closing-state response for debugging + future fields without a migration.
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, id)
);

-- Fast lookup: which lots in this workspace have ended but DON'T have a close yet?
CREATE INDEX IF NOT EXISTS idx_lot_closes_workspace_ended
  ON lot_closes(workspace_id, ended_at DESC);

CREATE INDEX IF NOT EXISTS idx_lot_closes_workspace_source
  ON lot_closes(workspace_id, source, ended_at DESC);

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE lot_closes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS members_read_lot_closes ON lot_closes;
CREATE POLICY members_read_lot_closes ON lot_closes
  FOR SELECT USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS members_write_lot_closes ON lot_closes;
CREATE POLICY members_write_lot_closes ON lot_closes
  FOR INSERT WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

DROP POLICY IF EXISTS members_update_lot_closes ON lot_closes;
CREATE POLICY members_update_lot_closes ON lot_closes
  FOR UPDATE USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

-- ─── Auto-update updated_at ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_lot_closes_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lot_closes_updated_at ON lot_closes;
CREATE TRIGGER lot_closes_updated_at
  BEFORE UPDATE ON lot_closes
  FOR EACH ROW
  EXECUTE FUNCTION trigger_lot_closes_updated_at();

-- ─── Realtime publication ──────────────────────────────────────────────────
-- Hub subscribes to lot_closes so closed bids flip status without a refresh.
ALTER PUBLICATION supabase_realtime ADD TABLE lot_closes;

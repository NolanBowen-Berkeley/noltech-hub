-- ─── Bid-alerts worker support ──────────────────────────────────────────────
-- Adds: user_preferences.phone_webhook_url + bid_alerts_sent (cooldown / dedup).

-- 1. Phone webhook URL on user_preferences. Synced from the Hub via
-- syncEngine so the bid-alerts Worker can read it.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS phone_webhook_url text;

-- 2. bid_alerts_sent — one row per alert the Worker fires. Used as a cooldown
-- table so we don't re-ping the same bid every 5 minutes once it enters the
-- alert window. Old rows can be pruned later.
CREATE TABLE IF NOT EXISTS bid_alerts_sent (
  id           bigserial   PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- bids.id is `text` (see 001_initial_schema.sql), not uuid — match it.
  bid_id       text        NOT NULL,
  lot_id       text,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  minutes_left integer,
  asking       numeric,
  ceiling      numeric
);

CREATE INDEX IF NOT EXISTS bid_alerts_sent_lookup
  ON bid_alerts_sent (workspace_id, bid_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS bid_alerts_sent_recent
  ON bid_alerts_sent (workspace_id, sent_at DESC);

-- 3. RLS — service-role on the Worker bypasses, but enable the policy for
-- defensive consistency with the rest of the schema. Postgres doesn't accept
-- `CREATE POLICY IF NOT EXISTS`, so drop-then-create for re-runnability.
ALTER TABLE bid_alerts_sent ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bid_alerts_sent_workspace_member ON bid_alerts_sent;

CREATE POLICY bid_alerts_sent_workspace_member
  ON bid_alerts_sent
  FOR ALL
  USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ))
  WITH CHECK (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

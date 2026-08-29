-- ─── 024: agent_heartbeats — ensure table + unique constraint ──────────────
-- The eBay sync's heartbeat upsert at noltech-pipeline/src/services/ebay/
-- persist.js:164 uses `onConflict: 'agent_id,workspace_id'`. If the table
-- exists but lacks that unique constraint (older deployments), every tick
-- spams "[ebay-sync] heartbeat upsert failed: there is no unique ..." into
-- the worker logs. The try/catch around the upsert keeps it non-fatal, but
-- the noise is real.
--
-- Idempotent — safe to re-run on any environment.

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id                bigserial PRIMARY KEY,
  workspace_id      uuid        NOT NULL,
  agent_id          text        NOT NULL,
  hostname          text,
  status            text,
  last_run_at       timestamptz NOT NULL DEFAULT now(),
  last_run_summary  jsonb
);

-- Add the unique constraint if missing. Wrapped in a DO block so the
-- migration succeeds on environments where the constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'agent_heartbeats_agent_workspace_unique'
  ) THEN
    ALTER TABLE agent_heartbeats
      ADD CONSTRAINT agent_heartbeats_agent_workspace_unique
      UNIQUE (agent_id, workspace_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_heartbeats_workspace_idx
  ON agent_heartbeats (workspace_id, last_run_at DESC);

-- RLS: service-role bypasses this anyway, but enable + add a permissive
-- read policy so the Hub's SystemHealthCard can query its own workspace's
-- heartbeats via the user JWT.
ALTER TABLE agent_heartbeats ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_policies
    WHERE  schemaname = 'public'
      AND  tablename  = 'agent_heartbeats'
      AND  policyname = 'agent_heartbeats_workspace_read'
  ) THEN
    CREATE POLICY agent_heartbeats_workspace_read
      ON agent_heartbeats
      FOR SELECT
      USING (
        workspace_id IN (
          SELECT workspace_id
          FROM   workspace_members
          WHERE  user_id = auth.uid()
        )
      );
  END IF;
END $$;

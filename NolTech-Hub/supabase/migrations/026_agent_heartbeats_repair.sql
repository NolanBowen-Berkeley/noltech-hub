-- ─── 026: agent_heartbeats — repair legacy schema once and for all ───────────
-- Migration 011 originally created agent_heartbeats with agent_id as the
-- sole PRIMARY KEY (intended for the deprecated single-Pi sync agent).
-- Migration 024 was supposed to add a (agent_id, workspace_id) unique
-- constraint that the Cloudflare Worker's heartbeat upsert depends on,
-- but its CREATE TABLE IF NOT EXISTS noop'd on legacy environments AND
-- the worker is still throwing:
--   "[ebay-sync] heartbeat upsert failed: there is no unique or exclusion
--    constraint matching the ON CONFLICT specification"
-- on every */30 cron tick.
--
-- This migration repairs both schemas in one shot:
--   1. If the legacy PK on agent_id alone exists, drop it (it blocks
--      multi-workspace heartbeats anyway — two workspaces can't share an
--      agent_id under that constraint).
--   2. Ensure an `id bigserial PRIMARY KEY` column exists (no-op if 024 already added it).
--   3. Ensure the (agent_id, workspace_id) UNIQUE constraint exists, which is
--      what the Worker's `onConflict: 'agent_id,workspace_id'` needs to match.
--   4. Ensure useful columns exist with sensible types.
--
-- Idempotent — every step guards with IF (NOT) EXISTS or pg_constraint lookup.
-- Safe to re-run on any environment.

-- ── Step 1 — drop the legacy single-column PK on agent_id (if present) ──
-- Note: pg_attribute.attname is the `name` type, not `text`, so we cast to
-- text on both sides of the comparison.
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
  FROM   pg_constraint
  WHERE  conrelid = 'agent_heartbeats'::regclass
    AND  contype  = 'p'
    AND  (
      SELECT array_agg(attname::text ORDER BY attname::text)
      FROM   pg_attribute
      WHERE  attrelid = 'agent_heartbeats'::regclass
        AND  attnum   = ANY(conkey)
    ) = ARRAY['agent_id']::text[];
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agent_heartbeats DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

-- ── Step 2 — ensure id bigserial PRIMARY KEY column exists ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'agent_heartbeats'::regclass
      AND attname  = 'id'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE agent_heartbeats ADD COLUMN id bigserial;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_heartbeats'::regclass
      AND contype  = 'p'
  ) THEN
    ALTER TABLE agent_heartbeats ADD CONSTRAINT agent_heartbeats_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- ── Step 3 — ensure (agent_id, workspace_id) UNIQUE constraint exists ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'agent_heartbeats'::regclass
      AND  contype  = 'u'
      AND  (
        SELECT array_agg(attname::text ORDER BY attname::text)
        FROM   pg_attribute
        WHERE  attrelid = 'agent_heartbeats'::regclass
          AND  attnum   = ANY(conkey)
      ) = ARRAY['agent_id', 'workspace_id']::text[]
  ) THEN
    ALTER TABLE agent_heartbeats
      ADD CONSTRAINT agent_heartbeats_agent_workspace_unique
      UNIQUE (agent_id, workspace_id);
  END IF;
END $$;

-- ── Step 4 — ensure baseline columns exist (idempotent ADD COLUMN IF NOT EXISTS) ──
ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS workspace_id     uuid;
ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS agent_id         text;
ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS hostname         text;
ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS status           text;
ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS last_run_at      timestamptz;
ALTER TABLE agent_heartbeats ADD COLUMN IF NOT EXISTS last_run_summary jsonb;

-- Useful read index for the SystemHealthCard's per-workspace query.
CREATE INDEX IF NOT EXISTS agent_heartbeats_workspace_idx
  ON agent_heartbeats (workspace_id, last_run_at DESC);

-- Verification helper — pasteable into the SQL editor to confirm the repair
-- landed. Should return at least one PRIMARY KEY constraint (on id) AND
-- one UNIQUE constraint (on agent_id, workspace_id).
--   SELECT conname, contype
--   FROM   pg_constraint
--   WHERE  conrelid = 'agent_heartbeats'::regclass;

-- ─── Migration 011: Agent heartbeats ────────────────────────────────────────
-- The headless sync agent (Pi) replaces the per-device Electron sync loop.
-- Each agent process upserts a row here every minute so the Hub UI can show
-- whether sync is alive, when it last ran, and what it did. Writes come from
-- the service-role key (the Pi); reads come from any workspace member.

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  agent_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hostname text,
  status text,                    -- 'idle' | 'running' | 'ok' | 'error' | 'shutting-down'
  last_run_at timestamptz,
  last_run_summary jsonb,
  last_error text,
  version text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_heartbeats_workspace ON agent_heartbeats(workspace_id, updated_at DESC);

ALTER TABLE agent_heartbeats ENABLE ROW LEVEL SECURITY;

-- Workspace members can read heartbeats for their workspace.
CREATE POLICY members_read_agent_heartbeats ON agent_heartbeats
  FOR SELECT USING (workspace_id IN (
    SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid()
  ));

-- Only the service role (the Pi agent) can write. No anon/authenticated INSERT.

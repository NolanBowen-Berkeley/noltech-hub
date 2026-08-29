-- ─── Fix Workspace RLS Policy ──────────────────────────────────────────────
-- The original INSERT policy for workspaces is too strict.
-- Drop and recreate with a simpler rule.

DROP POLICY IF EXISTS "authenticated_create_workspace" ON workspaces;

CREATE POLICY "authenticated_create_workspace" ON workspaces
  FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

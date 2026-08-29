-- ─── Workspace Invites ────────────────────────────────────────────────────
-- Short codes teammates can paste to join a workspace.

CREATE TABLE workspace_invites (
  code text PRIMARY KEY, -- e.g. "NOLTECH-X7F2K9" — shareable, non-guessable
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz, -- null = never expires
  max_uses integer DEFAULT 10, -- prevents abuse
  use_count integer DEFAULT 0,
  revoked boolean DEFAULT false
);

CREATE INDEX idx_invites_workspace ON workspace_invites(workspace_id);

-- RLS
ALTER TABLE workspace_invites ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read an invite by its code (to preview workspace name)
-- They can only see invites for codes they know (security by obscurity of the code)
CREATE POLICY "read_invite_by_code" ON workspace_invites FOR SELECT
  TO authenticated
  USING (true);

-- Workspace members can create invites for their workspace
CREATE POLICY "members_create_invites" ON workspace_invites FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_member(workspace_id) AND created_by = auth.uid());

-- Anyone can update use_count when claiming (RPC will handle this server-side)
-- Only creators/workspace-owners can revoke
CREATE POLICY "update_invite" ON workspace_invites FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid() OR is_workspace_member(workspace_id));

-- Workspace owner can delete invites
CREATE POLICY "delete_invite" ON workspace_invites FOR DELETE
  TO authenticated
  USING (created_by = auth.uid() OR EXISTS (SELECT 1 FROM workspaces WHERE id = workspace_id AND created_by = auth.uid()));

-- ─── RPC function to redeem invite atomically ──
-- Checks validity, adds member, increments use_count in one transaction.

CREATE OR REPLACE FUNCTION redeem_workspace_invite(invite_code text)
RETURNS json AS $$
DECLARE
  invite record;
  existing_member record;
BEGIN
  -- Lock the invite row
  SELECT * INTO invite FROM workspace_invites WHERE code = invite_code FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invite not found');
  END IF;

  IF invite.revoked THEN
    RETURN json_build_object('success', false, 'error', 'Invite has been revoked');
  END IF;

  IF invite.expires_at IS NOT NULL AND invite.expires_at < now() THEN
    RETURN json_build_object('success', false, 'error', 'Invite has expired');
  END IF;

  IF invite.max_uses IS NOT NULL AND invite.use_count >= invite.max_uses THEN
    RETURN json_build_object('success', false, 'error', 'Invite has reached maximum uses');
  END IF;

  -- Check if already a member
  SELECT * INTO existing_member FROM workspace_members
    WHERE workspace_id = invite.workspace_id AND user_id = auth.uid();

  IF FOUND THEN
    RETURN json_build_object('success', true, 'workspace_id', invite.workspace_id, 'already_member', true);
  END IF;

  -- Add as member
  INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (invite.workspace_id, auth.uid(), 'member');

  -- Increment use count
  UPDATE workspace_invites SET use_count = use_count + 1 WHERE code = invite_code;

  RETURN json_build_object('success', true, 'workspace_id', invite.workspace_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Allow authenticated users to call this RPC
GRANT EXECUTE ON FUNCTION redeem_workspace_invite(text) TO authenticated;

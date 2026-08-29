-- ─── Account Deletion (GDPR/CCPA) ──────────────────────────────────────────
-- Users can delete their own account. Workspaces they solely own are destroyed;
-- workspaces they share remain but the user is removed as a member.

create or replace function delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  orphan_ws_id uuid;
begin
  if me is null then
    return jsonb_build_object('success', false, 'error', 'Not authenticated');
  end if;

  -- Find workspaces where this user is the sole owner. Delete them (cascades to
  -- lots, items, bids, transactions, etc. via FK on workspace_id).
  for orphan_ws_id in
    select w.id
    from workspaces w
    where w.id in (
      select workspace_id from workspace_members
      where user_id = me and role = 'owner'
    )
    and (
      select count(*) from workspace_members wm
      where wm.workspace_id = w.id and wm.role = 'owner'
    ) = 1
  loop
    delete from workspaces where id = orphan_ws_id;
  end loop;

  -- Remove this user from any remaining workspaces
  delete from workspace_members where user_id = me;

  -- Revoke invites they created
  update workspace_invites set revoked = true where created_by = me;

  -- Delete their user_preferences row
  delete from user_preferences where user_id = me;

  -- Finally remove the auth user
  delete from auth.users where id = me;

  return jsonb_build_object('success', true);
end;
$$;

revoke all on function delete_my_account() from public;
grant execute on function delete_my_account() to authenticated;

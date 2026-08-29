-- ─── Workspace Creation Limits ─────────────────────────────────────────────
-- Prevent free-tier users from creating unlimited workspaces and exhausting DB quota.
-- Limit is enforced by a trigger on workspaces.INSERT and scales with tier.

create or replace function check_workspace_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owned_count int;
  user_tier text;
  max_workspaces int;
begin
  -- Only apply to new inserts where this user will be the creator
  if new.created_by is null then
    return new;
  end if;

  -- Look up tier (row auto-created on signup; defaults to 'free')
  select tier into user_tier from subscriptions where user_id = new.created_by;
  user_tier := coalesce(user_tier, 'free');

  max_workspaces := case user_tier
    when 'business' then 25
    when 'pro'      then 5
    else                 2   -- free / unknown
  end;

  select count(*) into owned_count
  from workspace_members
  where user_id = new.created_by and role = 'owner';

  if owned_count >= max_workspaces then
    raise exception 'Workspace limit reached for % tier (max %). Upgrade or delete an existing workspace.',
      user_tier, max_workspaces
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_workspace_limit on workspaces;
create trigger enforce_workspace_limit
  before insert on workspaces
  for each row execute function check_workspace_limit();

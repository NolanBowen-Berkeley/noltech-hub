-- ─── Subscriptions / Tier Gating ───────────────────────────────────────────
-- Server-authoritative tier storage. Clients can READ their own row but
-- NEVER write — only the service role (via Stripe webhook or admin action)
-- can update tier. This prevents self-serve tier escalation.

create table if not exists subscriptions (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  tier         text not null default 'free' check (tier in ('free','pro','business')),
  status       text not null default 'active' check (status in ('active','past_due','canceled','trialing')),
  stripe_customer_id   text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table subscriptions enable row level security;

drop policy if exists "users_read_own_subscription" on subscriptions;
create policy "users_read_own_subscription" on subscriptions
  for select using (user_id = auth.uid());

-- No insert/update/delete policies → regular users can't modify this table.
-- Only the service role (used by server-side webhooks) bypasses RLS.

-- Auto-create a free-tier row when a user signs up
create or replace function create_free_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into subscriptions (user_id, tier, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function create_free_subscription();

-- Backfill for existing users
insert into subscriptions (user_id, tier, status)
select id, 'free', 'active' from auth.users
on conflict (user_id) do nothing;

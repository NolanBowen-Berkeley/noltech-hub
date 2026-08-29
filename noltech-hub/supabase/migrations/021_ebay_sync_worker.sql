-- ─── 021: Cloud-side eBay sync — sync_state + finances_events ────────────────
-- Backs the noltech-ebay-sync Cloudflare Worker which replicates useSyncAll
-- end-to-end on a 30-minute cron. Two new tables:
--
--   • sync_state          — per-workspace: cached OAuth access token + expiry,
--                            last-run metadata, skipped-orders log
--   • finances_events     — per-event Finances API ledger (cloud equivalent
--                            of the Hub's noltech:ebay:finances-events key)
--
-- Also adds a GIN index on items.sale jsonb so the Worker can match by
-- orderId without a sequential scan.

create table if not exists sync_state (
  workspace_id                    uuid primary key references workspaces(id) on delete cascade,
  ebay_access_token               text,
  ebay_access_token_expires_at    timestamptz,
  ebay_refresh_token_fingerprint  text,
  last_run_at                     timestamptz,
  last_run_status                 text,
  last_summary                    jsonb default '{}'::jsonb,
  skipped_orders                  jsonb default '[]'::jsonb,
  run_started_at                  timestamptz,
  updated_at                      timestamptz not null default now()
);

create index if not exists sync_state_workspace_idx
  on sync_state (workspace_id);

create table if not exists finances_events (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  ebay_txn_id         text not null,
  event_type          text not null,                       -- NON_SALE_CHARGE | SHIPPING_LABEL | REFUND | CREDIT | DISPUTE
  fee_type            text,
  order_id            text,
  order_line_item_id  text,
  amount              numeric(12,2) not null,
  currency            text not null default 'USD',
  memo                text,
  occurred_at         timestamptz not null,
  recorded_at         timestamptz not null default now(),
  raw_payload         jsonb not null,
  source              text not null default 'ebay-finances-api',
  created_at          timestamptz not null default now(),
  unique (workspace_id, ebay_txn_id)
);

create index if not exists finances_events_workspace_occurred_at_idx
  on finances_events (workspace_id, occurred_at desc);

create index if not exists finances_events_workspace_order_idx
  on finances_events (workspace_id, order_id)
  where order_id is not null;

create index if not exists finances_events_workspace_type_idx
  on finances_events (workspace_id, event_type);

-- ─── RLS ───
alter table sync_state       enable row level security;
alter table finances_events  enable row level security;

drop policy if exists sync_state_workspace_member_select on sync_state;
create policy sync_state_workspace_member_select on sync_state
  for select using (is_workspace_member(workspace_id));

drop policy if exists sync_state_workspace_member_insert on sync_state;
create policy sync_state_workspace_member_insert on sync_state
  for insert with check (is_workspace_member(workspace_id));

drop policy if exists sync_state_workspace_member_update on sync_state;
create policy sync_state_workspace_member_update on sync_state
  for update using (is_workspace_member(workspace_id))
              with check (is_workspace_member(workspace_id));

drop policy if exists finances_events_workspace_member_select on finances_events;
create policy finances_events_workspace_member_select on finances_events
  for select using (is_workspace_member(workspace_id));

drop policy if exists finances_events_workspace_member_insert on finances_events;
create policy finances_events_workspace_member_insert on finances_events
  for insert with check (is_workspace_member(workspace_id));

-- ─── GIN index on items.sale jsonb for fast orderId lookups ───
-- The Worker matches eBay orders to inventory by querying items.sale->>id.
-- Without this, every order match is a sequential scan.
create index if not exists items_sale_jsonb_idx
  on items using gin (sale jsonb_path_ops);

-- ─── Realtime publication ───
alter publication supabase_realtime add table sync_state;
alter publication supabase_realtime add table finances_events;

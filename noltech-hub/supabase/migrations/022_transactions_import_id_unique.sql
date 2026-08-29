-- ─── 022: Add UNIQUE constraint on transactions(workspace_id, import_id) ────
-- The ebay-sync Worker uses `.upsert({...}, { onConflict: 'workspace_id,import_id' })`
-- to write Returns & Refunds rows idempotently. PostgREST needs an actual
-- unique constraint or index matching the conflict target — otherwise the
-- insert fails with `there is no unique or exclusion constraint matching
-- the ON CONFLICT specification`.
--
-- The Hub previously generated importIds locally (`auto:<orderId>`,
-- `auto_refund:<orderId>`, etc.) without enforcing global uniqueness — dedup
-- ran at insert time via array filter in JS. To switch to DB-level dedup
-- across both Hub + Worker writers, this migration:
--   1. Drops any existing duplicate (workspace_id, import_id) rows (keeps oldest)
--   2. Adds the UNIQUE constraint
-- NULL import_ids (manual entries, CSV imports) are unaffected — Postgres
-- treats each NULL as distinct, so multiple NULLs per workspace remain legal.

-- Step 1: dedupe in-place. CTE picks rn=1 (oldest by created_at) per group.
with ranked as (
  select id,
         row_number() over (
           partition by workspace_id, import_id
           order by created_at asc
         ) as rn
    from transactions
   where import_id is not null
)
delete from transactions
 where id in (select id from ranked where rn > 1);

-- Step 2: install the constraint. Drop first in case a prior partial
-- migration left a stale half-installed constraint.
alter table transactions
  drop constraint if exists transactions_workspace_id_import_id_key;

alter table transactions
  add constraint transactions_workspace_id_import_id_key
  unique (workspace_id, import_id);

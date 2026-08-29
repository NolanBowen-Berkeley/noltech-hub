-- ─── Audit Log Retention ───────────────────────────────────────────────────
-- Audit log grows forever otherwise. Prune entries older than 90 days.
-- Runs via pg_cron if the extension is enabled, otherwise run manually:
--   select prune_audit_log();

create or replace function prune_audit_log()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted int;
begin
  delete from audit_log
  where created_at < now() - interval '90 days';
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function prune_audit_log() from public;

-- Schedule daily pruning at 3am UTC (requires pg_cron extension)
-- If pg_cron is not available, this block is skipped and you run it manually.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('prune-audit-log-daily', '0 3 * * *', $sql$select prune_audit_log();$sql$);
  end if;
exception when others then
  -- pg_cron not available on this plan — no-op, user can run prune_audit_log() manually
  null;
end $$;

-- ─── 023: Add item-count columns to lot_analyses ──────────────────────────────
-- The auto-analyze pipeline (parser_version v3-2026-05) returns three integer
-- diagnostic counters that the original 016_tier39_auto_analyze.sql migration
-- never added:
--   • items_total        — total items in the manifest
--   • items_priced_live  — count successfully priced via sold-comps Lambda
--   • items_estimated    — count fallback-estimated from MSRP (no live comp)
--
-- Adding all three at once because the previously-silent upsert failure (now
-- fixed) was hiding these as "Could not find the 'items_estimated' column"
-- in PostgREST. Without the columns, every upsert silently rejected and
-- lot_analyses.scored_at stayed frozen at 2026-05-27 for 3 days.

alter table lot_analyses
  add column if not exists items_total       integer,
  add column if not exists items_priced_live integer,
  add column if not exists items_estimated   integer;

-- Tiny composite index so the Hub's BrowseLotsView can quickly find lots
-- where the analysis was mostly real-comp-priced (high signal) vs mostly
-- MSRP-estimated (low signal).
create index if not exists idx_lot_analyses_priced_coverage
  on lot_analyses (workspace_id, items_priced_live desc nulls last)
  where items_priced_live is not null;

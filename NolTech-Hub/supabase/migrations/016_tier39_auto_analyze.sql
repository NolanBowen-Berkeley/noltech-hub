-- ─── Migration 016 — Tier 39 auto-analyze pipeline ──────────────────────────
--
-- Tables added:
--   liquidation_lots_newegg   — scraped Newegg_Business lots (cache)
--   liquidation_manifests     — per-lot manifest items (one row per item)
--   lot_analysis_queue        — FIFO of lots awaiting Worker analysis
--   lot_analyses              — Worker output: scenarios + recommendation + red flags
--   partout_cache             — cached desktop part-out decompositions (30-day TTL)
--   analysis_costs            — daily cost meter for the Worker's $5/day cap
--
-- Extends:
--   sold_comps                — add condition / category / raw_count / raw_avg_price
--                                / dropped_title / dropped_outlier columns
--
-- All new tables have RLS enabled with the standard workspace-membership
-- policy (matches existing pattern from migrations 001/012/013).

-- ── 1. Extend sold_comps with Tier 39 fields ────────────────────────────────
ALTER TABLE public.sold_comps
  ADD COLUMN IF NOT EXISTS condition         TEXT DEFAULT 'working',
  ADD COLUMN IF NOT EXISTS category          TEXT DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS raw_count         INTEGER,
  ADD COLUMN IF NOT EXISTS raw_avg_price     NUMERIC,
  ADD COLUMN IF NOT EXISTS dropped_title     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dropped_outlier   INTEGER DEFAULT 0;


-- ── 2. liquidation_lots_newegg — scraped lot cache ──────────────────────────
CREATE TABLE IF NOT EXISTS public.liquidation_lots_newegg (
  id              BIGSERIAL PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lot_id          TEXT NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  seller          TEXT DEFAULT 'Newegg_Business',
  current_bid     NUMERIC DEFAULT 0,
  num_bids        INTEGER DEFAULT 0,
  quantity        TEXT,
  condition       TEXT,
  location        TEXT,
  ends_at         TIMESTAMPTZ,
  manifest_url    TEXT,
  scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, lot_id)
);
CREATE INDEX IF NOT EXISTS idx_liq_lots_newegg_ws_scraped
  ON public.liquidation_lots_newegg(workspace_id, scraped_at DESC);
ALTER TABLE public.liquidation_lots_newegg ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lots_newegg select for workspace members"
  ON public.liquidation_lots_newegg FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "lots_newegg insert for workspace members"
  ON public.liquidation_lots_newegg FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "lots_newegg update for workspace members"
  ON public.liquidation_lots_newegg FOR UPDATE
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
    )
  );


-- ── 3. liquidation_manifests — per-item manifest rows ───────────────────────
CREATE TABLE IF NOT EXISTS public.liquidation_manifests (
  id                BIGSERIAL PRIMARY KEY,
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lot_id            TEXT NOT NULL,
  item_index        INTEGER NOT NULL,
  description       TEXT NOT NULL,
  brand             TEXT,
  upc               TEXT,
  quantity          INTEGER DEFAULT 1,
  msrp              NUMERIC,
  category_raw      TEXT,                   -- Liquidation.com's category column
  category_refined  TEXT NOT NULL DEFAULT 'other',
                                            -- 'gpu' | 'cpu' | 'ram' | 'desktop' | 'storage' | 'other'
  condition_raw     TEXT,
  condition         TEXT NOT NULL DEFAULT 'unknown',
                                            -- 'working' | 'for_parts' | 'unknown'
  model_guess       TEXT,
  ingested_at       TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (workspace_id, lot_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_liq_manifests_ws_lot
  ON public.liquidation_manifests(workspace_id, lot_id);
ALTER TABLE public.liquidation_manifests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "manifests select for workspace members"
  ON public.liquidation_manifests FOR SELECT
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );
CREATE POLICY "manifests insert for workspace members"
  ON public.liquidation_manifests FOR INSERT
  WITH CHECK (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );
CREATE POLICY "manifests update for workspace members"
  ON public.liquidation_manifests FOR UPDATE
  USING (
    workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid())
  );


-- ── 4. lot_analysis_queue — FIFO for the Worker ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.lot_analysis_queue (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lot_id        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
                  -- 'pending' | 'processing' | 'done' | 'error' | 'deferred_cost_cap'
  attempts      INTEGER DEFAULT 0,
  force         BOOLEAN DEFAULT FALSE,       -- TRUE = user-triggered redo, ignore cooldown
  summary       JSONB,                       -- manifest summary snapshot for pre-filter
  error         TEXT,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_lot_queue_status_enqueued
  ON public.lot_analysis_queue(workspace_id, status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_lot_queue_lot_id
  ON public.lot_analysis_queue(workspace_id, lot_id);
ALTER TABLE public.lot_analysis_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "queue select for workspace members"
  ON public.lot_analysis_queue FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "queue insert for workspace members"
  ON public.lot_analysis_queue FOR INSERT
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "queue update for workspace members"
  ON public.lot_analysis_queue FOR UPDATE
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));


-- ── 5. lot_analyses — Worker output ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lot_analyses (
  id                          BIGSERIAL PRIMARY KEY,
  workspace_id                UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lot_id                      TEXT NOT NULL,
  scored_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_lot_price               NUMERIC,
  items_total_estimated_msrp  NUMERIC,
  scenarios                   JSONB NOT NULL,
                                -- { resell_whole_lot: {...}, part_out_desktops: {...},
                                --   full_part_out: {...} }
                                -- each: { revenue, cost_basis, profit, margin_pct }
  recommendation              TEXT NOT NULL,
                                -- 'resell_whole_lot' | 'part_out_desktops' | 'full_part_out'
  red_flags                   JSONB DEFAULT '[]',
  item_results                JSONB,
  partout_results             JSONB,
  total_cost_to_score_usd     NUMERIC DEFAULT 0,
  soldcomps_calls             INTEGER DEFAULT 0,
  claude_calls                INTEGER DEFAULT 0,
  parser_version              TEXT,

  UNIQUE (workspace_id, lot_id)
);
CREATE INDEX IF NOT EXISTS idx_lot_analyses_ws_scored
  ON public.lot_analyses(workspace_id, scored_at DESC);
ALTER TABLE public.lot_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analyses select for workspace members"
  ON public.lot_analyses FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "analyses insert for workspace members"
  ON public.lot_analyses FOR INSERT
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "analyses update for workspace members"
  ON public.lot_analyses FOR UPDATE
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));


-- ── 6. partout_cache — 30-day cache of part-out decompositions ──────────────
CREATE TABLE IF NOT EXISTS public.partout_cache (
  id                     BIGSERIAL PRIMARY KEY,
  workspace_id           UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  description_normalized TEXT NOT NULL,
  description_raw        TEXT,
  result                 JSONB NOT NULL,
  cached_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (workspace_id, description_normalized)
);
CREATE INDEX IF NOT EXISTS idx_partout_cache_ws_cached
  ON public.partout_cache(workspace_id, cached_at DESC);
ALTER TABLE public.partout_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "partout select for workspace members"
  ON public.partout_cache FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "partout insert for workspace members"
  ON public.partout_cache FOR INSERT
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "partout update for workspace members"
  ON public.partout_cache FOR UPDATE
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));


-- ── 7. analysis_costs — daily cost meter (Worker enforces $5/day cap) ───────
CREATE TABLE IF NOT EXISTS public.analysis_costs (
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  date           DATE NOT NULL,
  total_usd      NUMERIC NOT NULL DEFAULT 0,
  lots_analyzed  INTEGER NOT NULL DEFAULT 0,
  last_updated   TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (workspace_id, date)
);
ALTER TABLE public.analysis_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "costs select for workspace members"
  ON public.analysis_costs FOR SELECT
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "costs insert for workspace members"
  ON public.analysis_costs FOR INSERT
  WITH CHECK (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "costs update for workspace members"
  ON public.analysis_costs FOR UPDATE
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));


-- ── 8. Add the new tables to supabase_realtime publication (for Hub UI to
--      auto-update when Worker writes a row) ──────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.lot_analysis_queue;
ALTER PUBLICATION supabase_realtime ADD TABLE public.lot_analyses;
ALTER PUBLICATION supabase_realtime ADD TABLE public.analysis_costs;

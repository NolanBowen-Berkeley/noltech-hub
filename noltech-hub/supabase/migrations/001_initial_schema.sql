-- ─── NolTech Hub Initial Schema ─────────────────────────────────────────────
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- This creates all tables, indexes, and Row Level Security policies for team workspaces.

-- ========================================================================
-- 1. WORKSPACES + MEMBERS
-- ========================================================================

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member', -- 'owner' | 'member'
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

-- ========================================================================
-- 2. INVENTORY
-- ========================================================================

CREATE TABLE lots (
  id text PRIMARY KEY, -- Keep existing UUID format from app
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text,
  source_name text,
  purchase_date date,
  cost numeric(10,2),
  item_count integer,
  status text DEFAULT 'received',
  notes text,
  sku_prefix text,
  sku_suffix text,
  manifest text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  version integer DEFAULT 1
);

CREATE INDEX idx_lots_workspace ON lots(workspace_id);
CREATE INDEX idx_lots_status ON lots(workspace_id, status);

CREATE TABLE items (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id text REFERENCES lots(id) ON DELETE CASCADE,
  brand text,
  model text,
  category text,
  serial_number text,
  sku text,
  status text DEFAULT 'received',
  condition_grade text,
  condition_on_arrival text,
  disposition text,
  listing_price numeric(10,2),
  cost_basis numeric(10,2),
  estimated_value numeric(10,2),
  ebay_item_id text,
  date_added timestamptz,
  sale jsonb,
  test_results jsonb,
  photos jsonb,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id),
  version integer DEFAULT 1
);

CREATE INDEX idx_items_workspace ON items(workspace_id);
CREATE INDEX idx_items_lot ON items(lot_id);
CREATE INDEX idx_items_status ON items(workspace_id, status);
CREATE INDEX idx_items_ebay_id ON items(ebay_item_id) WHERE ebay_item_id IS NOT NULL;

-- ========================================================================
-- 3. APPEND-ONLY LOGS (no conflicts, high volume)
-- ========================================================================

CREATE TABLE bids (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lot_id text,
  lot_title text,
  source text,
  lot_url text,
  bid_amount numeric(10,2),
  bid_ceiling numeric(10,2),
  est_resale numeric(10,2),
  won_price numeric(10,2),
  actual_profit numeric(10,2),
  status text,
  inventory_lot_id text,
  notes text,
  bid_date timestamptz,
  updated_at timestamptz DEFAULT now(),
  imported_at timestamptz
);

CREATE INDEX idx_bids_workspace ON bids(workspace_id);
CREATE INDEX idx_bids_status ON bids(workspace_id, status);

CREATE TABLE transactions (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date,
  type text, -- 'income' | 'expense'
  category text,
  description text,
  amount numeric(10,2),
  notes text,
  source text,
  import_id text, -- dedup key
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_transactions_workspace ON transactions(workspace_id);
CREATE INDEX idx_transactions_date ON transactions(workspace_id, date DESC);
CREATE UNIQUE INDEX idx_transactions_import ON transactions(workspace_id, import_id) WHERE import_id IS NOT NULL;

CREATE TABLE sales_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id text,
  lot_id text,
  sale jsonb,
  brand text,
  model text,
  recorded_at timestamptz DEFAULT now()
);

CREATE INDEX idx_sales_workspace ON sales_history(workspace_id, recorded_at DESC);

CREATE TABLE price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id text,
  price numeric(10,2),
  date date,
  reason text, -- 'initial' | 'markdown' | 'auto_markdown' | 'manual'
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_price_history_item ON price_history(workspace_id, item_id, date DESC);

-- ========================================================================
-- 4. WORKSPACE-LEVEL CONFIG (single row per workspace)
-- ========================================================================

CREATE TABLE workspace_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  sources jsonb,
  categories jsonb,
  condition_multipliers jsonb,
  ebay_fee_rate numeric(5,4),
  auto_sync_config jsonb,
  price_reductor_rules jsonb,
  auto_relist_config jsonb,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

-- ========================================================================
-- 5. USER-SPECIFIC PREFERENCES (per member, not shared)
-- ========================================================================

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL, -- active workspace
  watchlist jsonb,
  lot_notes jsonb,
  saved_searches jsonb,
  alerts jsonb,
  updated_at timestamptz DEFAULT now()
);

-- ========================================================================
-- 6. ROW LEVEL SECURITY
-- ========================================================================

-- Helper function: check if user is member of a workspace
CREATE OR REPLACE FUNCTION is_workspace_member(ws_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = ws_id AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Enable RLS on all tables
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Workspaces: members can read, owner can update
CREATE POLICY "members_read_workspace" ON workspaces FOR SELECT
  USING (is_workspace_member(id));
CREATE POLICY "authenticated_create_workspace" ON workspaces FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "owner_update_workspace" ON workspaces FOR UPDATE
  USING (created_by = auth.uid());

-- Workspace members: members can read, owner can add/remove
CREATE POLICY "members_read_members" ON workspace_members FOR SELECT
  USING (is_workspace_member(workspace_id));
CREATE POLICY "owner_insert_members" ON workspace_members FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM workspaces WHERE id = workspace_id AND created_by = auth.uid())
    OR auth.uid() = user_id -- user can add themselves via invite
  );
CREATE POLICY "members_delete_self" ON workspace_members FOR DELETE
  USING (user_id = auth.uid() OR EXISTS (SELECT 1 FROM workspaces WHERE id = workspace_id AND created_by = auth.uid()));

-- All workspace-scoped tables: members can CRUD within their workspace
CREATE POLICY "members_all_lots" ON lots FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY "members_all_items" ON items FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY "members_all_bids" ON bids FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY "members_all_transactions" ON transactions FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY "members_all_sales" ON sales_history FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY "members_all_prices" ON price_history FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

CREATE POLICY "members_all_settings" ON workspace_settings FOR ALL
  USING (is_workspace_member(workspace_id))
  WITH CHECK (is_workspace_member(workspace_id));

-- User preferences: only the user themselves
CREATE POLICY "user_own_prefs" ON user_preferences FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ========================================================================
-- 7. AUTO-UPDATE TIMESTAMPS
-- ========================================================================

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lots_touch BEFORE UPDATE ON lots FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER items_touch BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_touch BEFORE UPDATE ON workspace_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER prefs_touch BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ========================================================================
-- 8. REALTIME PUBLICATION (enable real-time subscriptions)
-- ========================================================================

-- Supabase Realtime uses Postgres logical replication.
-- Add our tables to the supabase_realtime publication so clients can subscribe.
ALTER PUBLICATION supabase_realtime ADD TABLE lots, items, bids, transactions, sales_history, price_history, workspace_settings;

-- ========================================================================
-- DONE. Save and run this whole file in Supabase SQL Editor.
-- ========================================================================

-- ─── Migration 010: Add order_id and sku to transactions ─────────────────────
-- The auto-bookkeeping flow stamps each row with its eBay order ID and the
-- inventory SKU that drove it. These were stored locally on transaction
-- objects but the transactions table (created in 001_initial_schema.sql)
-- never had columns for them, so they got silently dropped on cloud sync.
-- This migration adds both columns plus an index to support fast order-ID
-- lookups for the bookkeeping search.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sku text;

-- Speeds up the "search bookkeeping by eBay order number" lookup that the
-- ledger search bar and eBay Match reconciliation both rely on.
CREATE INDEX IF NOT EXISTS idx_transactions_order
  ON transactions(workspace_id, order_id)
  WHERE order_id IS NOT NULL;

-- ─── 025_lots_image_url.sql ──────────────────────────────────────────────────
-- Adds image_url to liquidation_lots_newegg so bid alerts can render a lot
-- thumbnail. The raw Liquidation.com CDN URL is stored; clients (Discord,
-- the Hub UI) fetch it via the public /liquidation/image worker route,
-- which proxies + R2-caches the bytes (Liq.com hotlink-blocks direct fetches).

ALTER TABLE liquidation_lots_newegg
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN liquidation_lots_newegg.image_url IS
  'Raw Liquidation.com lot thumbnail URL captured at discovery. Served to clients via the public /liquidation/image proxy (R2-cached) — never hotlinked directly.';

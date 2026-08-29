-- ─── Phase 6: Extend realtime to workspace_settings + user_preferences ────
-- These tables were created in migration 001 but not added to realtime.

ALTER PUBLICATION supabase_realtime ADD TABLE user_preferences;

-- Note: workspace_settings + price_history were already in 001
-- Verify with: SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

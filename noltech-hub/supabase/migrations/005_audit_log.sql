-- ─── Audit Log ────────────────────────────────────────────────────────────
-- Automatically tracks who changed what across all synced tables.

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id),
  actor_email text, -- Cached for easy display
  table_name text NOT NULL,
  row_id text NOT NULL,
  operation text NOT NULL, -- 'INSERT' | 'UPDATE' | 'DELETE'
  changed_fields jsonb, -- For UPDATE: { field: { old, new } }
  row_snapshot jsonb, -- For INSERT/DELETE: full row
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_audit_workspace ON audit_log(workspace_id, created_at DESC);
CREATE INDEX idx_audit_row ON audit_log(workspace_id, table_name, row_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_read_audit" ON audit_log FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id));

-- Trigger function: captures changes and writes to audit_log
CREATE OR REPLACE FUNCTION audit_trigger()
RETURNS trigger AS $$
DECLARE
  actor_id uuid;
  actor_mail text;
  changed jsonb;
  old_json jsonb;
  new_json jsonb;
  field_name text;
BEGIN
  actor_id := auth.uid();
  IF actor_id IS NOT NULL THEN
    SELECT email INTO actor_mail FROM auth.users WHERE id = actor_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (workspace_id, actor_user_id, actor_email, table_name, row_id, operation, row_snapshot)
    VALUES (NEW.workspace_id, actor_id, actor_mail, TG_TABLE_NAME, NEW.id::text, 'INSERT', to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    old_json := to_jsonb(OLD);
    new_json := to_jsonb(NEW);
    changed := '{}'::jsonb;
    FOR field_name IN SELECT key FROM jsonb_each(new_json) LOOP
      IF new_json->field_name IS DISTINCT FROM old_json->field_name AND field_name NOT IN ('updated_at', 'version', 'updated_by') THEN
        changed := changed || jsonb_build_object(field_name, jsonb_build_object('old', old_json->field_name, 'new', new_json->field_name));
      END IF;
    END LOOP;
    IF changed <> '{}'::jsonb THEN
      INSERT INTO audit_log (workspace_id, actor_user_id, actor_email, table_name, row_id, operation, changed_fields)
      VALUES (NEW.workspace_id, actor_id, actor_mail, TG_TABLE_NAME, NEW.id::text, 'UPDATE', changed);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (workspace_id, actor_user_id, actor_email, table_name, row_id, operation, row_snapshot)
    VALUES (OLD.workspace_id, actor_id, actor_mail, TG_TABLE_NAME, OLD.id::text, 'DELETE', to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach trigger to key tables
CREATE TRIGGER audit_lots AFTER INSERT OR UPDATE OR DELETE ON lots FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER audit_items AFTER INSERT OR UPDATE OR DELETE ON items FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER audit_bids AFTER INSERT OR UPDATE OR DELETE ON bids FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER audit_transactions AFTER INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION audit_trigger();

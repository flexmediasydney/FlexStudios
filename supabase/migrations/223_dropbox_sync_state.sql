-- Migration 223: Dropbox cursor state + path-lookup RPC for the webhook (PR5)
--
-- Dropbox webhooks signal "something changed" — they don't carry the changes.
-- The webhook handler then calls /files/list_folder/continue with a stored
-- cursor to fetch the diff. This table holds that cursor.
--
-- One row per "watched root path". Phase 1 watches /FlexMedia/Projects only,
-- but the schema supports multiple watches for future expansion.
--
-- The find_project_folder_for_path RPC does longest-prefix matching from a
-- file's full path back to the owning project_folders row. Used by the
-- webhook to attribute incoming file events to (project, folder_kind).

-- ============================================================================
-- 1. dropbox_sync_state
-- ============================================================================

CREATE TABLE IF NOT EXISTS dropbox_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_path TEXT NOT NULL UNIQUE,
  cursor TEXT,
  last_run_at TIMESTAMPTZ,
  last_changes_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dropbox_sync_state (watch_path)
VALUES ('/FlexMedia/Projects')
ON CONFLICT (watch_path) DO NOTHING;

ALTER TABLE dropbox_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dropbox_sync_state_admin_read" ON dropbox_sync_state
  FOR SELECT
  USING (get_user_role() IN ('master_admin', 'admin'));

-- No write policies — only the service role (webhook + reconcile) writes.

COMMENT ON TABLE dropbox_sync_state IS
  'Dropbox /files/list_folder cursor per watched root path. Maintained by dropbox-webhook + dropbox-reconcile.';

-- ============================================================================
-- 2. find_project_folder_for_path RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION find_project_folder_for_path(p_path TEXT)
RETURNS TABLE(project_id UUID, folder_kind TEXT, dropbox_path TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT project_id, folder_kind, dropbox_path
  FROM project_folders
  WHERE p_path = dropbox_path
     OR p_path LIKE dropbox_path || '/%'
  ORDER BY length(dropbox_path) DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION find_project_folder_for_path(TEXT) IS
  'Longest-prefix match: given a file path, returns the owning (project_id, folder_kind, dropbox_path) from project_folders. Used by dropbox-webhook to attribute incoming events.';

-- Grant execute to service_role + authenticated (RPC is SECURITY DEFINER so RLS still applies on underlying reads).
GRANT EXECUTE ON FUNCTION find_project_folder_for_path(TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

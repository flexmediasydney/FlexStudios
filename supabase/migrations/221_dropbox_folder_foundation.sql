-- Migration 221: Dropbox folder foundation (Phase 1 of drone module)
--
-- Reusable infrastructure layer that the drone module (Phases 2–7) and future
-- modules (shortlisting, floorplans, video) all sit on top of. See
-- ~/flexmedia-drone-spike/IMPLEMENTATION_PLAN_V2.md §1 for the full spec.
--
-- Three additive changes; nothing destructive:
--
-- 1. New columns on `projects`:
--      dropbox_root_path, dropbox_root_shared_link — set by the project-creation
--      hook in PR4; admin-overridable via the Files UI in PR7.
--      confirmed_lat / confirmed_lng / confirmed_at / confirmed_by — operator
--      override of geocoded coords for strata / ambiguous addresses (used by
--      the SfM rendering pipeline in Phase 3+).
--      primary_contact_person_id — drives drone-theme inheritance in Phase 4.
--      No FK on this column yet because the `people` entity is forward-
--      compatibility (referenced by frontend pages but not yet a DB table).
--
-- 2. `project_folders` — one row per (project, folder_kind). Mirrors the
--    9-folder skeleton provisioned in Dropbox per project. Maintained by the
--    `_shared/projectFolders.ts` lib (PR3). RLS mirrors the `projects` table
--    pattern — staff read all, contractors read only their assigned projects,
--    only master_admin can DELETE (FK CASCADE handles project teardown).
--
-- 3. `project_folder_events` — append-only audit log of every Dropbox event,
--    admin override, and shared-link change. Append-only via "no UPDATE/DELETE
--    policies" — service role still bypasses for the webhook/reconcile
--    functions. Indexed for project+time scans (UI activity log) and for
--    dropbox_id lookups (reconcile dedup).

-- ============================================================================
-- 1. Project column additions
-- ============================================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS dropbox_root_path TEXT,
  ADD COLUMN IF NOT EXISTS dropbox_root_shared_link TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_lat DECIMAL(10,8),
  ADD COLUMN IF NOT EXISTS confirmed_lng DECIMAL(11,8),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_contact_person_id UUID;

COMMENT ON COLUMN projects.dropbox_root_path IS
  'Absolute Dropbox path of this project''s root folder, e.g. /FlexMedia/Projects/abc123_6-3-silver-st. Populated by the project-creation hook; admin-overridable.';
COMMENT ON COLUMN projects.confirmed_lat IS
  'Operator-confirmed latitude. Overrides geocoded lat for strata/ambiguous addresses. Used by SfM rendering.';
COMMENT ON COLUMN projects.primary_contact_person_id IS
  'Forward-compat: drives drone-theme inheritance (person → org → brand → flexmedia default) in Phase 4.';

-- ============================================================================
-- 2. project_folders
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_kind TEXT NOT NULL CHECK (folder_kind IN (
    'raw_photos','raw_drones','raw_videos',
    'enrichment_drone_renders_proposed','enrichment_drone_renders_adjusted',
    'enrichment_orthomosaics','enrichment_sfm_meshes',
    'final_delivery_drones','audit'
  )),
  dropbox_path TEXT NOT NULL,
  shared_link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  UNIQUE(project_id, folder_kind)
);

CREATE INDEX IF NOT EXISTS idx_project_folders_project ON project_folders(project_id);
-- Prefix-match index for webhook path → folder lookups (text_pattern_ops enables LIKE 'prefix%').
CREATE INDEX IF NOT EXISTS idx_project_folders_path_prefix
  ON project_folders(dropbox_path text_pattern_ops);

ALTER TABLE project_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_folders_read" ON project_folders FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "project_folders_insert" ON project_folders FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "project_folders_update" ON project_folders FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "project_folders_delete_owner_only" ON project_folders FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 3. project_folder_events (append-only audit log)
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_folder_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','user','webhook')),
  actor_id UUID,
  file_name TEXT,
  file_size_bytes BIGINT,
  dropbox_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pfe_project_time
  ON project_folder_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pfe_dropbox_id
  ON project_folder_events(dropbox_id) WHERE dropbox_id IS NOT NULL;

ALTER TABLE project_folder_events ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT + INSERT only. No UPDATE/DELETE policies = blocked for
-- non-service-role queries. Service role (webhook + reconcile) bypasses RLS.
CREATE POLICY "project_folder_events_read" ON project_folder_events FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "project_folder_events_insert" ON project_folder_events FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));

-- ============================================================================
-- Notify PostgREST to refresh schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

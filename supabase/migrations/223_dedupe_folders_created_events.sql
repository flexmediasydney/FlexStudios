-- Migration 223: drop duplicate folders_created rows in project_folder_events.
--
-- Phase 1 PR4's project-creation hook + backfill is otherwise idempotent
-- (Dropbox createFolder swallows path/conflict, project_folders upsert ignores
-- duplicates on UNIQUE(project_id, folder_kind)) — but createProjectFolders
-- emitted a folders_created audit event on every invocation. Rate-limit-driven
-- retries during the backfill produced 5 duplicate events across 99 projects
-- (104 rows total). The companion code change in projectFolders.ts now gates
-- the audit emit on dropbox_root_path being NULL at entry, so this is a
-- one-time cleanup of the 5 already-written dupes.
--
-- Strategy: keep the earliest folders_created event per project (min(id) —
-- BIGSERIAL is monotonic so id ordering matches creation ordering). Other
-- event_types are untouched.
--
-- Note: project_folder_events RLS forbids DELETE for all non-service-role
-- callers. Migrations run as the owner role (postgres) and bypass RLS, so
-- this DELETE goes through.

BEGIN;

DO $$
DECLARE
  v_before_total int;
  v_before_per_project int;
  v_deleted int;
  v_after_total int;
BEGIN
  SELECT count(*) INTO v_before_total FROM project_folder_events
    WHERE event_type = 'folders_created';
  SELECT count(DISTINCT project_id) INTO v_before_per_project FROM project_folder_events
    WHERE event_type = 'folders_created';

  DELETE FROM project_folder_events
  WHERE event_type = 'folders_created'
    AND id NOT IN (
      SELECT min(id) FROM project_folder_events
      WHERE event_type = 'folders_created'
      GROUP BY project_id
    );

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT count(*) INTO v_after_total FROM project_folder_events
    WHERE event_type = 'folders_created';

  RAISE NOTICE 'Migration 223: folders_created dedup — before_total=%, projects=%, deleted=%, after_total=% (expect after_total = projects)',
    v_before_total, v_before_per_project, v_deleted, v_after_total;
END $$;

COMMIT;

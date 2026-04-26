-- ════════════════════════════════════════════════════════════════════════
-- Migration 290 — Wave 5 P3 (QC2-1 #11): backfill missing
-- drones_raws_shortlist_proposed project_folders rows.
--
-- BUG: 44 of 99 active projects had no `drones_raws_shortlist_proposed`
-- project_folders row, so dropbox-webhook's enqueueIngestForRecentRawDrones
-- never matched their raw drone uploads — webhook events landed but
-- find_project_folder_for_path returned no folder match (the legacy
-- `raw_drones` row was deleted in mig 247 but the new restructure-kind row
-- was never inserted for these 44).
--
-- ROOT CAUSE: drone-folder-backfill is the one-shot migrator that should
-- have inserted these rows in 2026-04, but it was never invoked for these
-- specific projects (likely created BEFORE backfill ran but AFTER the
-- mig 247 raw_drones cleanup, falling through the gap).
--
-- FIX: insert a project_folders row per missing project, computing
-- dropbox_path = projects.dropbox_root_path || '/Drones/Raws/Shortlist
-- Proposed' (matches the convention drone-folder-backfill uses at
-- functions/drone-folder-backfill/index.ts:52 — `Drones/Raws/Shortlist
-- Proposed`).
--
-- We do NOT touch Dropbox itself here. drone-folder-backfill creates the
-- physical folder; this migration ONLY fills the project_folders row so
-- the webhook's find_project_folder_for_path can resolve future events.
-- The folder will be auto-created on the first uploaded file (Dropbox
-- creates parent dirs on demand for /files/upload), or operators can
-- re-run drone-folder-backfill explicitly.
--
-- Skipped projects with NULL dropbox_root_path (cannot compute the path);
-- those are likely test/garbage rows and would also fail any other folder
-- operation.
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO project_folders (project_id, folder_kind, dropbox_path, last_synced_at)
SELECT
  p.id,
  'drones_raws_shortlist_proposed',
  p.dropbox_root_path || '/Drones/Raws/Shortlist Proposed',
  NOW()
FROM projects p
WHERE p.dropbox_root_path IS NOT NULL
  AND p.status NOT IN ('cancelled', 'archived')
  AND NOT EXISTS (
    SELECT 1 FROM project_folders pf
    WHERE pf.project_id = p.id
      AND pf.folder_kind = 'drones_raws_shortlist_proposed'
  )
ON CONFLICT (project_id, folder_kind) DO NOTHING;

-- Audit row so the backfill is traceable.
INSERT INTO project_folder_events (project_id, folder_kind, event_type, actor_type, metadata)
SELECT
  p.id,
  'drones_raws_shortlist_proposed',
  'folder_row_backfilled_mig290',
  'system',
  jsonb_build_object(
    'reason', 'QC2-1 #11 missing folder row',
    'computed_path', p.dropbox_root_path || '/Drones/Raws/Shortlist Proposed'
  )
FROM projects p
JOIN project_folders pf
  ON pf.project_id = p.id
 AND pf.folder_kind = 'drones_raws_shortlist_proposed'
 AND pf.last_synced_at >= NOW() - INTERVAL '5 seconds'  -- only just-inserted rows
WHERE p.dropbox_root_path IS NOT NULL;

NOTIFY pgrst, 'reload schema';

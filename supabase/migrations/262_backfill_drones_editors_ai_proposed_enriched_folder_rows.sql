-- ════════════════════════════════════════════════════════════════════════
-- Migration 262 — Backfill drones_editors_ai_proposed_enriched rows for
-- legacy projects (drone-render folder migration)
--
-- The drone-render Edge Function was migrated (2026-04-25) to write to
-- folder_kind='drones_editors_ai_proposed_enriched' (Drones/Editors/AI
-- Proposed Enriched/) instead of the legacy
-- 'enrichment_drone_renders_proposed' / 'enrichment_drone_renders_adjusted'
-- (06_ENRICHMENT/drone_renders_*/) folders.
--
-- Production audit: 99 projects had the legacy enrichment rows but only 55
-- had the new drones_editors_ai_proposed_enriched row provisioned. 44
-- projects would 500 on the first render attempt with
--   "No folder of kind 'drones_editors_ai_proposed_enriched' for project X"
-- because getFolderPath() reads from project_folders.
--
-- This migration synthesises the missing project_folders rows from each
-- project's existing dropbox_root_path. We deliberately DO NOT call Dropbox
-- to physically create the folder — uploadFile auto-creates intermediate
-- directories on first write, and the drone-folder-backfill one-shot has
-- already migrated existing files into the new tree for projects that have
-- run the backfill. For projects that haven't, the first drone-render call
-- will create the folder on demand.
--
-- Pattern used: take the project's existing dropbox_root_path (a property
-- present on every project that has any folders provisioned), append the
-- canonical relative path 'Drones/Editors/AI Proposed Enriched'. Skip
-- conflicts via ON CONFLICT.
-- ════════════════════════════════════════════════════════════════════════

INSERT INTO project_folders (project_id, folder_kind, dropbox_path, last_synced_at)
SELECT
  p.id,
  'drones_editors_ai_proposed_enriched',
  p.dropbox_root_path || '/Drones/Editors/AI Proposed Enriched',
  NOW()
FROM projects p
WHERE p.dropbox_root_path IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_folders pf
    WHERE pf.project_id = p.id
      AND pf.folder_kind = 'drones_editors_ai_proposed_enriched'
  )
ON CONFLICT (project_id, folder_kind) DO NOTHING;

NOTIFY pgrst, 'reload schema';

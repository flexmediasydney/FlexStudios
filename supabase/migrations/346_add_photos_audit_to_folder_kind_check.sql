-- Wave 7 P1-12 (W7.4) added the 'photos_audit' folder kind to the FolderKind
-- union in supabase/functions/_shared/projectFolders.ts but never widened the
-- project_folders.folder_kind CHECK constraint. createProjectFolders fails on
-- the photos_audit row insertion for any backfill or re-provisioning, blocking
-- the Photos/_AUDIT/ folder skeleton from materialising on existing projects.
--
-- Discovered 2026-04-28 while running backfillProjectFolders mode='missing_kinds'
-- to fill in Photos/ trees on projects provisioned before Wave 6 P1 landed
-- (root cause: 100/102 projects were missing the entire Photos/ branch).
--
-- This migration just adds 'photos_audit' to the constraint; everything else
-- about the constraint stays identical to migration 290.

ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_folder_kind_check;

ALTER TABLE project_folders ADD CONSTRAINT project_folders_folder_kind_check
  CHECK (folder_kind = ANY (ARRAY[
    'raw_photos'::text,
    'raw_drones'::text,
    'raw_videos'::text,
    'enrichment_drone_renders_proposed'::text,
    'enrichment_drone_renders_adjusted'::text,
    'enrichment_orthomosaics'::text,
    'enrichment_sfm_meshes'::text,
    'final_delivery_drones'::text,
    'audit'::text,
    'drones_raws_shortlist_proposed'::text,
    'drones_raws_shortlist_proposed_previews'::text,
    'drones_raws_final_shortlist'::text,
    'drones_raws_rejected'::text,
    'drones_raws_others'::text,
    'drones_editors_edited_post_production'::text,
    'drones_editors_ai_proposed_enriched'::text,
    'drones_editors_final_enriched'::text,
    'drones_finals'::text,
    'photos_raws_shortlist_proposed'::text,
    'photos_raws_shortlist_proposed_previews'::text,
    'photos_raws_final_shortlist'::text,
    'photos_raws_rejected'::text,
    'photos_raws_quarantine'::text,
    'photos_editors_edited_post_production'::text,
    'photos_editors_ai_proposed_enriched'::text,
    'photos_finals'::text,
    'photos_audit'::text
  ]));

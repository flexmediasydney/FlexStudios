-- Drone folder skeleton restructure (2026-04)
-- Adds new folder kinds. Old kinds stay in CHECK for backward compatibility
-- (existing rows in 53 active projects + 44 delivered still reference them
-- until the path-mapper migration moves files).

ALTER TABLE project_folders
  DROP CONSTRAINT IF EXISTS project_folders_folder_kind_check;

ALTER TABLE project_folders
  ADD CONSTRAINT project_folders_folder_kind_check
  CHECK (folder_kind = ANY (ARRAY[
    -- Legacy (deprecated, kept for backward compat with existing rows)
    'raw_photos'::text,
    'raw_drones'::text,
    'raw_videos'::text,
    'enrichment_drone_renders_proposed'::text,
    'enrichment_drone_renders_adjusted'::text,
    'enrichment_orthomosaics'::text,
    'enrichment_sfm_meshes'::text,
    'final_delivery_drones'::text,
    'audit'::text,
    -- New drone restructure (2026-04)
    'drones_raws_shortlist_proposed'::text,
    'drones_raws_shortlist_proposed_previews'::text,
    'drones_raws_final_shortlist'::text,
    'drones_raws_rejected'::text,
    'drones_raws_others'::text,
    'drones_editors_edited_post_production'::text,
    'drones_editors_ai_proposed_enriched'::text,
    'drones_editors_final_enriched'::text,
    'drones_finals'::text
  ]));

NOTIFY pgrst, 'reload schema';

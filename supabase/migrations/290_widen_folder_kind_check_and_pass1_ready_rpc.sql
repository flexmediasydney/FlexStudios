-- Wave 6 P2.5 SHORTLIST: mig 290: widen folder_kind CHECK + pass1_ready_compositions RPC
--
-- Background: Wave 6 P1 (mig 282-289) added 8 photos_* FolderKind values to
-- _shared/projectFolders.ts but did not widen the project_folders.folder_kind
-- CHECK constraint. provisionProjectFolders fails to create the new photos_*
-- folders for any project until this migration runs.
--
-- This migration:
--   1. Widens the folder_kind CHECK to include all 8 photos_* values
--   2. Adds pass1_ready_compositions(p_round_id UUID) — enumerates composition
--      groups ready for Pass 1 (not yet classified, not quarantined, not hard-rejected)

-- =============================================================================
-- 1. Widen folder_kind CHECK constraint
-- =============================================================================

ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_folder_kind_check;

ALTER TABLE project_folders ADD CONSTRAINT project_folders_folder_kind_check
  CHECK (folder_kind = ANY (ARRAY[
    -- Legacy + base
    'raw_photos'::text,
    'raw_drones'::text,
    'raw_videos'::text,
    'enrichment_drone_renders_proposed'::text,
    'enrichment_drone_renders_adjusted'::text,
    'enrichment_orthomosaics'::text,
    'enrichment_sfm_meshes'::text,
    'final_delivery_drones'::text,
    'audit'::text,
    -- Drones restructure (2026-04)
    'drones_raws_shortlist_proposed'::text,
    'drones_raws_shortlist_proposed_previews'::text,
    'drones_raws_final_shortlist'::text,
    'drones_raws_rejected'::text,
    'drones_raws_others'::text,
    'drones_editors_edited_post_production'::text,
    'drones_editors_ai_proposed_enriched'::text,
    'drones_editors_final_enriched'::text,
    'drones_finals'::text,
    -- Photos shortlisting (Wave 6 P1)
    'photos_raws_shortlist_proposed'::text,
    'photos_raws_shortlist_proposed_previews'::text,
    'photos_raws_final_shortlist'::text,
    'photos_raws_rejected'::text,
    'photos_raws_quarantine'::text,
    'photos_editors_edited_post_production'::text,
    'photos_editors_ai_proposed_enriched'::text,
    'photos_finals'::text
  ]));

-- =============================================================================
-- 2. pass1_ready_compositions RPC
-- =============================================================================
-- Returns composition_groups for a given round that are ready for Pass 1
-- classification. A group is "ready" when:
--   - It belongs to the round
--   - It has NOT yet been classified (no composition_classifications row)
--   - It has NOT been quarantined (no shortlisting_quarantine row)
--   - It has NOT been hard-rejected (no shortlisting_events row with
--     event_type='composition_hard_rejected' for the group)
--
-- Used by shortlisting-pass1 to enumerate work; can also be used by the
-- dispatcher and by ops dashboards.

CREATE OR REPLACE FUNCTION pass1_ready_compositions(p_round_id UUID)
RETURNS TABLE (
  id UUID,
  project_id UUID,
  round_id UUID,
  group_index INTEGER,
  files_in_group TEXT[],
  file_count INTEGER,
  best_bracket_stem TEXT,
  delivery_reference_stem TEXT,
  all_bracket_luminances NUMERIC[],
  selected_bracket_luminance NUMERIC,
  is_micro_adjustment_split BOOLEAN,
  dropbox_preview_path TEXT,
  preview_size_kb INTEGER,
  exif_metadata JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    cg.id,
    cg.project_id,
    cg.round_id,
    cg.group_index,
    cg.files_in_group,
    cg.file_count,
    cg.best_bracket_stem,
    cg.delivery_reference_stem,
    cg.all_bracket_luminances,
    cg.selected_bracket_luminance,
    cg.is_micro_adjustment_split,
    cg.dropbox_preview_path,
    cg.preview_size_kb,
    cg.exif_metadata,
    cg.created_at
  FROM composition_groups cg
  WHERE cg.round_id = p_round_id
    AND NOT EXISTS (
      SELECT 1 FROM composition_classifications cc
      WHERE cc.group_id = cg.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM shortlisting_quarantine q
      WHERE q.group_id = cg.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM shortlisting_events se
      WHERE se.group_id = cg.id
        AND se.event_type = 'composition_hard_rejected'
    )
  ORDER BY cg.group_index;
$$;

COMMENT ON FUNCTION pass1_ready_compositions(UUID) IS
  'Enumerate composition_groups in a round that are ready for Pass 1 classification: not yet classified, not quarantined, not hard-rejected. Used by shortlisting-pass1 edge function and ops queries.';

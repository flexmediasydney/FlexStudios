-- ════════════════════════════════════════════════════════════════════════
-- Migration 291 — Wave 5 P3 (QC2-8 #6): drop legacy
-- enrichment_drone_renders_* project_folders rows.
--
-- BUG: After mig 241 restructured the drone folder skeleton, the legacy
-- `enrichment_drone_renders_proposed` and `enrichment_drone_renders_adjusted`
-- rows had their dropbox_path REWRITTEN to point at the same physical path
-- as the new `drones_editors_ai_proposed_enriched` row
-- (`/Drones/Editors/AI Proposed Enriched`). When the webhook's
-- find_project_folder_for_path resolves a file_added event under that path,
-- PG's tie-breaker `ORDER BY length(dropbox_path) DESC LIMIT 1` is
-- non-deterministic for equal-length paths and the webhook attributes the
-- event to either kind interchangeably.
--
-- IMPACT: events for editor deliveries land under the legacy
-- `enrichment_drone_renders_*` kind ~half the time, so the
-- `linkRecentEditorDrops` filter in dropbox-webhook (which filters on the
-- canonical kind `drones_editors_edited_post_production`) misses some
-- legitimate editor uploads, AND the cross-kind shadowing pollutes
-- analytics that aggregate by folder_kind. Identical pattern to the
-- `raw_drones` cleanup that mig 247 deferred for these two kinds.
--
-- FIX: delete the 198 legacy rows. Verified BEFORE delete that:
--   1. NO active Edge Function writes to `enrichment_drone_renders_*` —
--      drone-render writes to `drones_raws_shortlist_proposed_previews`,
--      drone-render-edited writes to `drones_editors_ai_proposed_enriched`
--      (git grep + manual confirm).
--   2. NO drone_renders rows reference these folder paths via
--      `drone_renders.dropbox_path = pf.dropbox_path` (count = 0).
-- The shared physical path remains valid; only the redundant
-- project_folders attribution rows go.
--
-- After this migration, every event under /Drones/Editors/AI Proposed
-- Enriched is deterministically attributed to
-- `drones_editors_ai_proposed_enriched` (the only remaining row with that
-- path).
-- ════════════════════════════════════════════════════════════════════════

DELETE FROM project_folders
WHERE folder_kind IN (
  'enrichment_drone_renders_proposed',
  'enrichment_drone_renders_adjusted'
);

NOTIFY pgrst, 'reload schema';

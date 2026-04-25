-- ════════════════════════════════════════════════════════════════════════
-- Migration 247 — Drop deprecated project_folders rows post-backfill.
--
-- BUG: After mig 241 restructured the drone folder skeleton, the legacy
-- `raw_drones` rows had their dropbox_path REWRITTEN to point at the SAME
-- path as the new `drones_raws_shortlist_proposed` rows
-- (Drones/Raws/Shortlist Proposed/). PG's tie-breaker in
-- find_project_folder_for_path's `ORDER BY length(dropbox_path) DESC LIMIT 1`
-- is non-deterministic when paths are equal length, and consistently
-- returned the older (legacy) physical row first.
--
-- IMPACT: Webhook events for raw drone uploads landed under
-- folder_kind='raw_drones' instead of 'drones_raws_shortlist_proposed'.
-- Empirical: 717 events to raw_drones vs 742 to the new kind in 24h.
-- linkRecentEditorDrops in dropbox-webhook is unaffected (it filters on
-- 'drones_editors_edited_post_production' which has no legacy collision)
-- but enqueueIngestForRecentRawDrones now misses every raw_drones-attributed
-- event for backfilled projects, EXCEPT it OR-filters both kinds — so
-- ingest still fires. The real impact is on observability/audit and on
-- any future code that filters on a single kind.
--
-- For the editor-upload pipeline (Everton's render dead-letter):
-- find_project_folder_for_path on a path under
-- /Drones/Raws/Shortlist Proposed/ now returns either kind. After this
-- migration it's deterministic — only the new kind exists.
--
-- Same logical collision exists for `final_delivery_drones`
-- (rewritten to /Drones/Finals) ↔ `drones_finals`. drone-render-approve
-- writes to drones_editors_final_enriched first, falls back to
-- final_delivery_drones (legacy slot, now points at /Drones/Finals); after
-- delete, the fallback becomes inert which is correct — every project now
-- has drones_editors_final_enriched (per Step 2 backfill).
--
-- DELIBERATELY KEPT: enrichment_drone_renders_proposed and
-- enrichment_drone_renders_adjusted. drone-render writes its output via
-- getFolderPath('enrichment_drone_renders_*') (no fallback), and those
-- rows' dropbox_path was rewritten by the mig-241 backfill to point at
-- /Drones/Editors/AI Proposed Enriched. Deleting them would break ALL
-- drone-render invocations. Removing those rows requires teaching
-- drone-render to write to drones_editors_ai_proposed_enriched directly
-- (separate follow-up). The shadowing on those kinds is harmless for the
-- current editor-link pipeline (which keys on a different kind).
-- ════════════════════════════════════════════════════════════════════════

DELETE FROM project_folders
WHERE folder_kind IN (
  'raw_drones',
  'final_delivery_drones'
);

-- Drop the stale legacy dropbox_sync_state row whose cursor watches a
-- defunct top-level path. The active webhook watches
-- /Flex Media Team Folder/Projects (mig 234 corrected the path); the old
-- /FlexMedia/Projects row's cursor is invalid against the team folder.
DELETE FROM dropbox_sync_state WHERE watch_path = '/FlexMedia/Projects';

NOTIFY pgrst, 'reload schema';

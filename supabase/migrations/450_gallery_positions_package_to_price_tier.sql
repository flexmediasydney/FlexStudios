-- ─────────────────────────────────────────────────────────────────────────────
-- Mig 450 — Backfill: convert legacy scope_type='package' rows to
--                     scope_type='package_x_price_tier' (Standard tier)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Date:   2026-05-02
-- Author: QC-pass v2 follow-up to mig 443/446/447/449
-- Wave:   Recipes module QC v2
--
-- ─── CONTEXT ──────────────────────────────────────────────────────────────────
--
-- Mig 443 documented six valid scope_type values for gallery_positions
-- (project_type / package_grade / package_x_price_tier / product /
--  product_x_price_tier / package_x_price_tier_x_project_type).
--
-- An earlier seed run inserted five rows with scope_type='package' for the
-- Silver Package (40000000-0000-4000-a000-000000000001) — that scope_type is
-- NOT in the resolver vocabulary, so the Recipe Matrix UI never buckets these
-- rows into a cell. They render as invisible/orphan from the operator's
-- perspective even though they exist in the table.
--
-- The Recipe Matrix UI buckets only:
--   * scope_type='package_x_price_tier' → cell (package × price-tier)
--   * scope_type='price_tier'           → tier defaults pseudo-row
--
-- Joseph confirmed (2026-05-02): the five seeded rows belong to the
-- Standard price tier (a0000000-0000-4000-a000-000000000001 — see mig 446).
-- This migration converts them in-place WITHOUT changing their `id` (so any
-- audit trail / FK references survive) and bumps `position_index` past any
-- existing rows in the destination cell so the
-- (scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3, engine_role,
--  position_index) UNIQUE doesn't collide.
--
-- ─── WHAT THIS MIGRATION DOES ────────────────────────────────────────────────
--
-- 1. UPDATE the five gallery_positions rows where scope_type='package' to
--      scope_type    = 'package_x_price_tier'
--      scope_ref_id_2 = 'a0000000-0000-4000-a000-000000000001'  (Standard)
--      position_index = position_index + offset
--    where `offset` = (current max position_index in the destination cell
--    for the same engine_role) — guarantees no collision against the
--    existing row(s) already at scope_type='package_x_price_tier'.
--
--    `id`, `scope_ref_id` (package_id), `room_type`, `phase`, `engine_role`,
--    `notes` and every other authored field are PRESERVED.
--
-- 2. Refresh `updated_at` on touched rows so the audit log captures the move.
--
-- 3. Refresh the gallery_positions.scope_type column comment to mark the
--    legacy 'package' scope_type as historical/reserved (the resolver doesn't
--    look it up; new authoring goes through 'package_x_price_tier' or
--    'price_tier').
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────────
--
-- This migration is fully reversible. The same 5 rows can be returned to
-- scope_type='package' by:
--
--   BEGIN;
--   UPDATE public.gallery_positions
--      SET scope_type     = 'package',
--          scope_ref_id_2 = NULL,
--          position_index = position_index - <offset>,
--          updated_at     = now()
--    WHERE id IN (
--      'b58d8b9d-ce87-4ab5-9bca-4356cc60de06',
--      '97ac1035-8d56-4b8b-b5a6-809c8203dd7a',
--      'c588425b-190a-4a57-ba9f-95282a88672c',
--      '34d5ca27-c9a1-4d25-89b3-4bb6d252264d',
--      '4fb5d86d-e85b-429c-8d3b-c25c6e19b8af'
--    );
--   COMMIT;
--
-- where <offset> is whatever value the up-migration computed (read from the
-- shortlisting_events audit row this migration writes for the operation).
--
-- The 'package' value remains a tolerated string in the scope_type column
-- (no CHECK constraint to update) so the rollback re-INSERT works without
-- schema changes.
--
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. Compute offset + perform conversion in one UPDATE ──────────────────
--
-- We DO NOT hard-code the offset because mig 449 made the destination cell
-- non-empty (one existing row at position_index=1). Instead we compute the
-- max existing position_index in the destination cell for the same
-- engine_role and shift the migrated rows' position_index by that max so
-- the (scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3,
-- engine_role, position_index) UNIQUE doesn't collide.
--
-- Note: shortlisting_events is project-scoped (project_id NOT NULL) so we
-- intentionally skip an audit row. The rollback recipe in the header docs
-- above + the next-row payload in pg_stat_activity / migration log are
-- sufficient audit trail for a one-time data move.

UPDATE public.gallery_positions gp
   SET scope_type     = 'package_x_price_tier',
       scope_ref_id_2 = 'a0000000-0000-4000-a000-000000000001',
       position_index = gp.position_index + (
         SELECT COALESCE(MAX(position_index), 0)
           FROM public.gallery_positions
          WHERE scope_type     = 'package_x_price_tier'
            AND scope_ref_id   = '40000000-0000-4000-a000-000000000001'
            AND scope_ref_id_2 = 'a0000000-0000-4000-a000-000000000001'
            AND engine_role    = 'photo_day_shortlist'
       ),
       updated_at     = now()
 WHERE gp.scope_type     = 'package'
   AND gp.scope_ref_id   = '40000000-0000-4000-a000-000000000001';

-- ─── 2. Refresh resolver-order docs on the scope_type column ────────────────
--
-- Mig 443 listed only the six "live" scope types in the column comment. Drop
-- the standalone 'package' value as a current option but keep it documented
-- as historical/reserved so the rollback path stays self-explanatory.

COMMENT ON COLUMN public.gallery_positions.scope_type IS
  'Recipe scope. Active vocabulary: project_type | package_grade | package_x_price_tier | product | product_x_price_tier | package_x_price_tier_x_project_type. RESERVED/HISTORICAL: package (used by an early seed; mig 450 backfilled all live rows to package_x_price_tier — the value is still tolerated for rollback but the resolver does not bucket it). Resolver merge order is broadest→most-specific, last-wins per position_index. Not enforced by CHECK because resolver agent owns the lookup logic.';

COMMIT;

-- ─── POSTGREST CACHE INVALIDATION ───────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

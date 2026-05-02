-- ─────────────────────────────────────────────────────────────────────────
-- Mig 443 — Engine rebuild: gallery_positions (constraint-based recipes)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-W11.7.17 / Mig 443
-- Author: Joseph Saad (designed) / Stage-3 agent (executed)
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────
--
-- The named-slot enum (43 active slot_definitions, slot_id-keyed) is
-- fundamentally wrong as a recipe primitive:
--
--   * 33 of 43 slots have NEVER been referenced in production (zero overrides
--     ever proposed/selected them). Only 10 slot_ids are real.
--   * shortlisting_slot_suggestions has 0 rows despite the Stage-4 schema
--     declaring proposed_slots[] for 18+ months. The named-slot pathway
--     never activated end-to-end in the wild.
--   * Named slots can't compose: kitchen+wide+compressed+island would need
--     its own slot_id; combinatorial explosion for any rich constraint.
--   * Photo-centric: drone has 2 slots, video has 0, floorplan has 0.
--   * Eligibility is a hard gate, so any orphan composition becomes
--     unreachable — even if it's the best image in the project.
--
-- The new model: CONSTRAINT-BASED gallery_positions. Every position is a
-- partial constraint tuple (room_type / space_type / zone_focus / shot_scale
-- / perspective_compression / orientation / lens_class / image_type /
-- composition_type). NULL = engine wildcard. Operators author the CONSTRAINTS,
-- the engine matches eligible compositions, and an AI tiebreaker selects
-- the winner. The 43 slot_definitions become OPTIONAL templates — usable as
-- "starter" presets but not the source of truth.
--
-- Joseph confirmed (2026-05-02): "this is a completely new engine with barely
-- 2 projects test executed on it. purge and dump the old dogshit stuff."
--
-- ─── WHAT THIS MIGRATION DOES ────────────────────────────────────────────
--
-- TRACK A — Purge old slot data:
--   * Snapshot existing rows into _*_pre_443_backup tables (audit trail).
--   * TRUNCATE shortlisting_slot_allocations (130 rows, dead).
--   * TRUNCATE shortlisting_slot_position_preferences (0 rows, just hygiene).
--   * Deactivate the 33 unused slot_definitions; keep the 10 used ones as
--     bootstrap templates (is_active stays true for those).
--
-- TRACK B — Rename shortlisting_tiers → shortlisting_grades:
--   * "Tier" was overloaded with package PRICING tiers (Standard/Premium).
--   * Engine grades now have display_name: Volume / Refined / Editorial.
--   * Cascade rename:
--       - shortlisting_tiers → shortlisting_grades
--       - shortlisting_tier_configs → shortlisting_grade_configs
--                                     (column tier_id → grade_id)
--       - shortlisting_rounds.engine_tier_id → engine_grade_id
--       - package_engine_tier_mapping.engine_tier_id → engine_grade_id
--   * FKs auto-follow renames; constraint names also renamed for clarity.
--
-- TRACK C — Create gallery_positions:
--   * The new primary recipe entity. Each row is one position in a final
--     gallery sequence at some scope (project_type / package×grade /
--     package×price_tier / product / etc.).
--   * Constraint columns (room_type, space_type, zone_focus, shot_scale,
--     perspective_compression, orientation, lens_class, image_type,
--     composition_type) are all NULLABLE = wildcards.
--   * selection_mode = 'ai_decides' | 'curated' (operator can pin specific
--     compositions to a position via the curated mode in a later wave).
--   * ai_backfill_on_gap defaults true so the engine can fill positions
--     that have no human-authored constraint.
--   * template_slot_id back-links to a slot_definition row by slot_id text
--     (SOFT reference, no FK — slot_id is not unique on its own; it's
--     versioned via UNIQUE(slot_id, version)). UI affordance only.
--
-- TRACK D — Add engine_mode_override on packages + products:
--   * Per-row override: 'full_ai' | 'recipe_strict' | 'recipe_with_ai_backfill'
--   * NULL = inherit from default (recipe_with_ai_backfill).
--
-- TRACK E — gallery_positions scope_type vocabulary (DOCUMENTED, not
-- enforced by CHECK because resolver agent owns the lookup logic):
--
--   'project_type'                          → ref_id=project_type_id
--   'package_grade'                         → ref_id=package_id, ref_id_2=grade_id
--   'package_x_price_tier'                  → ref_id=package_id, ref_id_2=price_tier_id
--   'product'                               → ref_id=product_id (engine_role-keyed)
--   'product_x_price_tier'                  → ref_id=product_id, ref_id_2=price_tier_id
--   'package_x_price_tier_x_project_type'   → all 3 ref_ids set
--
-- Resolver merge order (broadest → most-specific, last-wins per
-- position_index, implemented by Stage-4 R2 agent in a later wave):
--   project_type
--     → package_grade
--     → package_x_price_tier
--     → product
--     → product_x_price_tier
--     → package_x_price_tier_x_project_type
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
-- If this migration needs to be reverted:
--
--   1. DROP TABLE public.gallery_positions CASCADE;
--   2. ALTER TABLE packages DROP COLUMN engine_mode_override;
--   3. ALTER TABLE products DROP COLUMN engine_mode_override;
--   4. ALTER TABLE shortlisting_grade_configs RENAME TO shortlisting_tier_configs;
--      ALTER TABLE shortlisting_tier_configs RENAME COLUMN grade_id TO tier_id;
--   5. ALTER TABLE shortlisting_grades RENAME TO shortlisting_tiers;
--   6. ALTER TABLE shortlisting_rounds RENAME COLUMN engine_grade_id TO engine_tier_id;
--   7. ALTER TABLE package_engine_tier_mapping RENAME COLUMN engine_grade_id TO engine_tier_id;
--   8. INSERT INTO shortlisting_slot_allocations
--        SELECT * FROM _shortlisting_slot_allocations_pre_443_backup;
--      INSERT INTO shortlisting_slot_position_preferences
--        SELECT * FROM _shortlisting_slot_position_preferences_pre_443_backup;
--   9. UPDATE shortlisting_slot_definitions SET is_active=true
--        WHERE slot_id IN (SELECT slot_id FROM _shortlisting_slot_definitions_pre_443_backup
--                          WHERE is_active=true);
--  10. NOTIFY pgrst, 'reload schema';
--
-- Backup tables intentionally retained for audit. Drop them in a later
-- cleanup wave once the new model is settled.
--
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK A — Purge old slot data (with audit backups)
-- ═════════════════════════════════════════════════════════════════════════

-- A.1 — Snapshot the three slot tables before destructive changes
CREATE TABLE IF NOT EXISTS _shortlisting_slot_allocations_pre_443_backup AS
  SELECT * FROM shortlisting_slot_allocations;

CREATE TABLE IF NOT EXISTS _shortlisting_slot_definitions_pre_443_backup AS
  SELECT * FROM shortlisting_slot_definitions;

CREATE TABLE IF NOT EXISTS _shortlisting_slot_position_preferences_pre_443_backup AS
  SELECT * FROM shortlisting_slot_position_preferences;

COMMENT ON TABLE _shortlisting_slot_allocations_pre_443_backup IS
  'Audit snapshot of shortlisting_slot_allocations taken by Mig 443 before TRUNCATE. Retain until v2 engine is settled.';
COMMENT ON TABLE _shortlisting_slot_definitions_pre_443_backup IS
  'Audit snapshot of shortlisting_slot_definitions taken by Mig 443. Retain until v2 engine is settled.';
COMMENT ON TABLE _shortlisting_slot_position_preferences_pre_443_backup IS
  'Audit snapshot of shortlisting_slot_position_preferences taken by Mig 443 before TRUNCATE. Retain until v2 engine is settled.';

-- A.2 — Truncate dead allocation + preference rows (no FK consumers besides
-- their own tables)
TRUNCATE TABLE shortlisting_slot_allocations;
TRUNCATE TABLE shortlisting_slot_position_preferences;

-- A.3 — Deactivate the 33 unused slot_definitions; keep the 10 production-used
-- ones as bootstrap templates. "Used" = ever appeared in shortlisting_overrides
-- as ai_proposed_slot_id or human_selected_slot_id.
UPDATE shortlisting_slot_definitions
   SET is_active = false,
       updated_at = now(),
       notes = COALESCE(notes,'') || ' [deactivated_by_mig_443: 0 production usage]'
 WHERE is_active = true
   AND slot_id NOT IN (
     SELECT DISTINCT ai_proposed_slot_id::text
       FROM shortlisting_overrides
      WHERE ai_proposed_slot_id IS NOT NULL
     UNION
     SELECT DISTINCT human_selected_slot_id::text
       FROM shortlisting_overrides
      WHERE human_selected_slot_id IS NOT NULL
   );

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK B — Rename shortlisting_tiers → shortlisting_grades
-- ═════════════════════════════════════════════════════════════════════════

-- B.1 — Rename the engine grade definitions table
ALTER TABLE shortlisting_tiers RENAME TO shortlisting_grades;

COMMENT ON TABLE shortlisting_grades IS
  'Engine grade definitions (Volume / Refined / Editorial). Renamed from shortlisting_tiers in Mig 443 to disambiguate from package pricing tiers.';

-- B.2 — Set the new operator-facing display names
UPDATE shortlisting_grades SET display_name = 'Volume',    updated_at = now() WHERE tier_code = 'S';
UPDATE shortlisting_grades SET display_name = 'Refined',   updated_at = now() WHERE tier_code = 'P';
UPDATE shortlisting_grades SET display_name = 'Editorial', updated_at = now() WHERE tier_code = 'A';

-- B.3 — Rename the per-grade config table + its FK column
ALTER TABLE shortlisting_tier_configs RENAME TO shortlisting_grade_configs;
ALTER TABLE shortlisting_grade_configs RENAME COLUMN tier_id TO grade_id;

COMMENT ON TABLE shortlisting_grade_configs IS
  'Versioned per-grade engine configuration (dimension_weights, signal_weights, hard_reject_thresholds). Renamed from shortlisting_tier_configs in Mig 443.';

-- B.4 — Rename FK columns in dependent tables (FKs themselves auto-follow
-- the parent rename; we only rename column names for clarity)
ALTER TABLE shortlisting_rounds RENAME COLUMN engine_tier_id TO engine_grade_id;
ALTER TABLE package_engine_tier_mapping RENAME COLUMN engine_tier_id TO engine_grade_id;

-- B.5 — Rename FK constraint names so pg_get_constraintdef output is
-- self-documenting (purely cosmetic but worth doing)
ALTER TABLE shortlisting_grade_configs
  RENAME CONSTRAINT shortlisting_tier_configs_tier_id_fkey
                 TO shortlisting_grade_configs_grade_id_fkey;

ALTER TABLE shortlisting_rounds
  RENAME CONSTRAINT shortlisting_rounds_engine_tier_id_fkey
                 TO shortlisting_rounds_engine_grade_id_fkey;

ALTER TABLE package_engine_tier_mapping
  RENAME CONSTRAINT package_engine_tier_mapping_engine_tier_id_fkey
                 TO package_engine_tier_mapping_engine_grade_id_fkey;

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK C — Create gallery_positions (the new primary recipe entity)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE public.gallery_positions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SCOPE — composite key for the n-axis intersection
  -- (project_type / package / price_tier / product / grade)
  scope_type                  text NOT NULL,
  scope_ref_id                uuid NOT NULL,
  scope_ref_id_2              uuid,
  scope_ref_id_3              uuid,

  -- POSITION + PHASE
  position_index              int  NOT NULL,
  phase                       text NOT NULL CHECK (phase IN ('mandatory','conditional','optional')),

  -- CONSTRAINT TUPLE — all nullable; NULL = engine wildcard.
  -- These mirror the composition_classifications observation axes.
  room_type                   text,
  space_type                  text,
  zone_focus                  text,
  shot_scale                  text CHECK (shot_scale IS NULL OR shot_scale IN ('wide','medium','tight','detail','vignette')),
  perspective_compression     text CHECK (perspective_compression IS NULL OR perspective_compression IN ('expanded','neutral','compressed')),
  orientation                 text CHECK (orientation IS NULL OR orientation IN ('landscape','portrait','square')),
  lens_class                  text,
  image_type                  text,
  composition_type            text,

  -- BEHAVIOR
  selection_mode              text NOT NULL DEFAULT 'ai_decides'
                              CHECK (selection_mode IN ('ai_decides','curated')),
  ai_backfill_on_gap          boolean NOT NULL DEFAULT true,
  notes                       text,

  -- Optional template back-link. SOFT reference (no FK) because
  -- shortlisting_slot_definitions.slot_id is not unique on its own — it's
  -- versioned via UNIQUE(slot_id, version). UI affordance only; not used
  -- for engine matching, so referential integrity isn't load-bearing.
  template_slot_id            text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  -- A scope+position_index pair must be unique: you can't have two
  -- position #3 in the same recipe scope.
  UNIQUE (scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3, position_index)
);

CREATE INDEX idx_gallery_positions_scope
  ON gallery_positions(scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3);

CREATE INDEX idx_gallery_positions_template
  ON gallery_positions(template_slot_id) WHERE template_slot_id IS NOT NULL;

COMMENT ON TABLE gallery_positions IS
  'Constraint-based gallery position recipes. Each row is one position at some scope (project_type / package×grade / package×price_tier / product / etc.). Constraint columns are nullable wildcards. See Mig 443 for the scope_type vocabulary and resolver merge order.';

COMMENT ON COLUMN gallery_positions.scope_type IS
  'Recipe scope. Vocabulary: project_type | package_grade | package_x_price_tier | product | product_x_price_tier | package_x_price_tier_x_project_type. Resolver merge order is broadest→most-specific, last-wins per position_index. Not enforced by CHECK because resolver agent owns the lookup logic.';

COMMENT ON COLUMN gallery_positions.selection_mode IS
  'ai_decides = engine picks the winning composition matching the constraints. curated = operator pins specific compositions (later wave).';

COMMENT ON COLUMN gallery_positions.ai_backfill_on_gap IS
  'When the matched-composition pool is empty for a position, allow the engine to backfill from the broader candidate pool. Default true.';

COMMENT ON COLUMN gallery_positions.template_slot_id IS
  'Optional soft reference to shortlisting_slot_definitions.slot_id when this position was authored from a starter template. No FK because slot_id is not unique on its own (versioned via UNIQUE(slot_id, version)). UI affordance only — not used for engine matching.';

-- RLS — read for master_admin/admin/manager; write for master_admin/admin
ALTER TABLE gallery_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY gallery_positions_read ON gallery_positions
  FOR SELECT TO authenticated
  USING ((SELECT get_user_role()) IN ('master_admin','admin','manager'));

CREATE POLICY gallery_positions_write ON gallery_positions
  FOR ALL TO authenticated
  USING ((SELECT get_user_role()) IN ('master_admin','admin'));

GRANT ALL ON gallery_positions TO service_role;
GRANT SELECT ON gallery_positions TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK D — Add engine_mode_override on packages + products
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE packages
  ADD COLUMN engine_mode_override text
    CHECK (engine_mode_override IS NULL
           OR engine_mode_override IN ('full_ai','recipe_strict','recipe_with_ai_backfill'));

ALTER TABLE products
  ADD COLUMN engine_mode_override text
    CHECK (engine_mode_override IS NULL
           OR engine_mode_override IN ('full_ai','recipe_strict','recipe_with_ai_backfill'));

COMMENT ON COLUMN packages.engine_mode_override IS
  'NULL inherits from default (recipe_with_ai_backfill). Set explicitly to override engine behavior at the package scope. Vocabulary: full_ai | recipe_strict | recipe_with_ai_backfill.';

COMMENT ON COLUMN products.engine_mode_override IS
  'NULL inherits from default (recipe_with_ai_backfill). Set explicitly to override engine behavior at the product scope. Vocabulary: full_ai | recipe_strict | recipe_with_ai_backfill.';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- POSTGREST CACHE INVALIDATION
-- ═════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 398 — Wave 11.7.17: Universal Vision Response Schema v2 cutover
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §5
--
-- Background — why this migration exists:
--   v1 of the universal vision response schema was authored before the W11.7
--   Shape D production cutover. v2 separates "the schema" from "the producer"
--   cleanly: this migration is the schema-side cutover that lets one Stage 1
--   caller emit a single contract regardless of which of the four source
--   contexts the input came from (internal_raw, internal_finals,
--   external_listing, floorplan_image).
--
--   v2 ships incrementally on the existing `composition_classifications`
--   table — the dominant read pattern is "give me Stage 1 output for this
--   image" which is one row per group with one JSONB blob. v1's sidecar
--   `composition_signal_scores` table is dropped in favour of a
--   `signal_scores` JSONB column (already added in mig 396 W11.2).
--
-- Joseph's binding decisions (signed off 2026-05-01, see W11.7.17 ticket):
--   Q4 — DROP `external_specific.delivery_quality_grade` letter scale.
--        External listings get `combined_score` numeric only. (Schema-side
--        change; this migration is index/column only — the JSONB stores
--        whatever the producer emits.)
--   Q5 — keep four nullable `*_specific` blocks; persist them as JSONB
--        columns enforced via prompt + persist-layer validation (see
--        shortlisting-shape-d/index.ts).
--   Q6 — HARD CUTOVER to v2.0. Existing v1 rows tagged with
--        `schema_version='v1.0'` and left immutable. New emissions are v2
--        from day one. NO 4-week dual-emit window.
--
-- Columns added (additive only — no breaking changes to existing rows):
--   source_type        — TEXT, CHECK constraint, NULL allowed for legacy.
--                        Backfilled to 'internal_raw' on existing rows.
--   image_type         — TEXT (no enum, model emits a string from the v2
--                        11-option taxonomy: is_day, is_dusk, is_drone,
--                        is_agent_headshot, is_test_shot, is_bts,
--                        is_floorplan, is_video_frame, is_detail_shot,
--                        is_facade_hero, is_other).
--   raw_specific       — JSONB. Populated when source_type='internal_raw'.
--                        Shape: { luminance_class, is_aeb_zero,
--                        bracket_recoverable }.
--   finals_specific    — JSONB. Populated when source_type='internal_finals'.
--                        Shape: { sky_replaced, digital_furniture_present,
--                        digital_dusk_applied, window_blowout_severity, ...}.
--   external_specific  — JSONB. Populated when source_type='external_listing'.
--                        Shape: { estimated_price_class, competitor_branding,
--                        package_signals }.
--   floorplan_specific — JSONB. Populated when source_type='floorplan_image'.
--                        Shape: { rooms_detected[], total_internal_sqm,
--                        bedrooms_count, ... }.
--   observed_objects   — JSONB. Wave 12 object registry feed. Each entry has
--                        bounding_box {x_pct, y_pct, w_pct, h_pct} populated
--                        by default (Q3 default ON).
--   observed_attributes— JSONB. Wave 12 attribute registry feed. Each entry
--                        has canonical_attribute_id + canonical_value_id.
--   schema_version     — TEXT. Defaults to 'v2.0' for new rows. Existing
--                        rows are backfilled to 'v1.0' (immutable historical
--                        marker).
--
-- Backfill logic:
--   Existing rows pre-W11.7.17 are stamped with `source_type='internal_raw'`
--   (the production RAW workflow that produced them) and
--   `schema_version='v1.0'`. The v1 → v2 cutover is HARD: new emissions
--   write `schema_version='v2.0'` from this migration onward; v1 rows stay
--   tagged 'v1.0' and untouched. Q6 binding decision: NO dual-emit window.
--
-- Index strategy:
--   - Partial btree on source_type / image_type — hot filters in the
--     swimlane and W15a/b/c dashboards.
--   - GIN on signal_scores — already in place from mig 396 W11.2.
--   - Expression index on finals_specific.sky_replaced — W15a finals QA
--     dashboard's primary filter.
--   - Expression index on external_specific.estimated_price_class —
--     W15b/c competitor analysis dashboards.
--   - Expression index on floorplan_specific.home_archetype — W13c
--     floorplan goldmine cross-listing analysis.
--
-- Coordination:
--   - This migration is purely additive on `composition_classifications`.
--     No DROP, no NOT NULL constraint changes, no data mutation beyond the
--     one-time backfill of existing rows.
--   - signal_scores JSONB column is unchanged from mig 396 (W11.2). v2
--     uses the same column with the same 22-key shape PLUS 4 new lighting
--     signals (light_quality, light_directionality,
--     color_temperature_appropriateness, light_falloff_quality) — the
--     persist layer accepts any superset of keys.
--
-- Rollback (manual; only if defects surface in production):
--   ALTER TABLE composition_classifications
--     DROP COLUMN source_type,
--     DROP COLUMN image_type,
--     DROP COLUMN raw_specific,
--     DROP COLUMN finals_specific,
--     DROP COLUMN external_specific,
--     DROP COLUMN floorplan_specific,
--     DROP COLUMN observed_objects,
--     DROP COLUMN observed_attributes,
--     DROP COLUMN schema_version;
--   (DROP INDEX statements implicit via column drop.)
--
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS source_type TEXT
    CHECK (source_type IS NULL OR source_type IN
      ('internal_raw','internal_finals','external_listing','floorplan_image')),
  ADD COLUMN IF NOT EXISTS image_type TEXT,
  ADD COLUMN IF NOT EXISTS raw_specific JSONB,
  ADD COLUMN IF NOT EXISTS finals_specific JSONB,
  ADD COLUMN IF NOT EXISTS external_specific JSONB,
  ADD COLUMN IF NOT EXISTS floorplan_specific JSONB,
  ADD COLUMN IF NOT EXISTS observed_objects JSONB,
  ADD COLUMN IF NOT EXISTS observed_attributes JSONB,
  ADD COLUMN IF NOT EXISTS schema_version TEXT DEFAULT 'v2.0';

-- ─── One-time backfill of existing rows ─────────────────────────────────────
-- Existing rows are pre-W11.7.17. They were emitted by the v1 producer
-- against the production RAW workflow, so their source_type is internal_raw.
-- They predate v2's `schema_version` discriminator, so we tag them 'v1.0' as
-- an immutable historical marker. New rows from this migration onward get
-- the column DEFAULT 'v2.0' applied automatically.

UPDATE composition_classifications
   SET source_type = 'internal_raw',
       schema_version = 'v1.0'
 WHERE source_type IS NULL;

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_classif_source_type
  ON composition_classifications(source_type)
  WHERE source_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_classif_image_type
  ON composition_classifications(image_type)
  WHERE image_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_classif_finals_sky_replaced
  ON composition_classifications((finals_specific->>'sky_replaced'))
  WHERE finals_specific IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_classif_external_price_class
  ON composition_classifications((external_specific->>'estimated_price_class'))
  WHERE external_specific IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_classif_floorplan_archetype
  ON composition_classifications((floorplan_specific->>'home_archetype'))
  WHERE floorplan_specific IS NOT NULL;

-- ─── Comments (operator-facing documentation) ──────────────────────────────

COMMENT ON COLUMN composition_classifications.source_type IS
  'Wave 11.7.17 (v2): which of the 4 source contexts produced this row. '
  'One of: internal_raw | internal_finals | external_listing | floorplan_image. '
  'Drives the prompt-side dimorphism (per-source field activity matrix in spec '
  '§2). Existing pre-v2 rows backfilled to internal_raw.';

COMMENT ON COLUMN composition_classifications.image_type IS
  'Wave 11.7.17 (v2): top-level image-type taxonomy. One of: is_day, is_dusk, '
  'is_drone, is_agent_headshot, is_test_shot, is_bts, is_floorplan, '
  'is_video_frame, is_detail_shot, is_facade_hero, is_other.';

COMMENT ON COLUMN composition_classifications.raw_specific IS
  'Wave 11.7.17 (v2): RAW-only signals. Shape: { luminance_class, is_aeb_zero, '
  'bracket_recoverable }. NULL when source_type != ''internal_raw''.';

COMMENT ON COLUMN composition_classifications.finals_specific IS
  'Wave 11.7.17 (v2): finals-only signals. Shape: { looks_post_processed, '
  'vertical_lines_corrected, color_grade_consistent_with_set, sky_replaced, '
  'sky_replacement_halo_severity, digital_furniture_present, '
  'digital_furniture_artefact_severity, digital_dusk_applied, '
  'digital_dusk_oversaturation_severity, window_blowout_severity, '
  'shadow_recovery_score, color_cast_score, hdr_halo_severity, '
  'retouch_artefact_severity }. NULL when source_type != ''internal_finals''.';

COMMENT ON COLUMN composition_classifications.external_specific IS
  'Wave 11.7.17 (v2): external listing observational signals. Shape: '
  '{ estimated_price_class, competitor_branding, package_signals }. '
  'NULL when source_type != ''external_listing''. Q4 binding: no '
  '`delivery_quality_grade` letter scale; combined_score numeric only.';

COMMENT ON COLUMN composition_classifications.floorplan_specific IS
  'Wave 11.7.17 (v2): floorplan OCR-style signals. Shape: { rooms_detected[], '
  'total_internal_sqm, bedrooms_count, bathrooms_count, car_spaces, '
  'home_archetype, north_arrow_orientation, levels_count, cross_check_flags[] }. '
  'NULL when source_type != ''floorplan_image''.';

COMMENT ON COLUMN composition_classifications.observed_objects IS
  'Wave 11.7.17 (v2): Wave 12 object registry feed. Array of '
  '{ raw_label, proposed_canonical_id, confidence, bounding_box: '
  '{ x_pct, y_pct, w_pct, h_pct }, attributes }. Q3 binding: bounding_box '
  'REQUIRED on every entry by default.';

COMMENT ON COLUMN composition_classifications.observed_attributes IS
  'Wave 11.7.17 (v2): Wave 12 attribute registry feed. Array of '
  '{ raw_label, canonical_attribute_id, canonical_value_id, confidence, '
  'object_anchor }.';

COMMENT ON COLUMN composition_classifications.schema_version IS
  'Wave 11.7.17 (v2): schema discriminator. ''v2.0'' for new emissions; '
  '''v1.0'' for rows backfilled at the W11.7.17 cutover. Q6 binding: hard '
  'cutover, no dual-emit window. v1.0 rows are immutable historical record.';

NOTIFY pgrst, 'reload schema';

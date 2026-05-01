-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 396 — Wave 11.2: composition_signal_scores per-signal granularity
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/WAVE_PLAN.md line 156 (W11.2)
-- Design ref: docs/design-specs/W11-universal-vision-response-schema.md (22
--   measurement prompts) — design v2 anchored 2026-04-30 keeps signal_scores
--   as a JSONB column on composition_classifications rather than a separate
--   composition_signal_scores table. Joseph approved option (B), 2026-05-01.
--
-- Background — why this migration exists:
--   Stage 1 today emits FOUR aggregate axis scores
--   (technical / lighting / composition / aesthetic) — each is a high-level
--   roll-up of multiple underlying signals. The W8 tier_configs admin UI
--   wants to weight per-signal but cannot, because the per-signal data isn't
--   captured. W11.2 closes that gap by adding signal_scores JSONB so Stage 1
--   can persist all 22 underlying signal scores. The 4 aggregate axis scores
--   remain authoritative; the JSONB is additional granularity.
--
-- 22 signal keys (0-10 scale, 10 = exemplary, 0 = catastrophic):
--   1.  exposure_balance
--   2.  color_cast
--   3.  sharpness_subject
--   4.  sharpness_corners
--   5.  depth_layering
--   6.  composition_geometry
--   7.  vantage_quality
--   8.  framing_quality
--   9.  leading_lines
--   10. negative_space
--   11. symmetry_quality
--   12. perspective_distortion
--   13. plumb_verticals
--   14. material_specificity
--   15. period_reading
--   16. styling_quality
--   17. distraction_freeness
--   18. retouch_debt
--   19. gallery_arc_position
--   20. social_crop_survival
--   21. brochure_print_survival
--   22. reading_grade_match
--
-- Index strategy:
--   - GIN on signal_scores: enables containment queries
--     (e.g. "rounds where exposure_balance < 6") via jsonb_path_ops semantics
--     consumed by the W8 tier-config tuning UI + W11.6 dashboard.
--   - Single-column DEFAULT '{}'::jsonb keeps existing rows backwards-
--     compatible — old classifications expose an empty object, new ones get
--     the full 22-key payload.
--
-- Coordination:
--   - W11.6.16 (in flight on a separate branch) adds 17 iter-5 enrichment
--     columns to this same table. W11.2 is one ADDITIONAL JSONB column —
--     no overlap.
--
-- Rollback (manual; only if defects surface):
--   DROP INDEX IF EXISTS idx_classif_signal_scores;
--   ALTER TABLE composition_classifications DROP COLUMN signal_scores;
--
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS signal_scores JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN composition_classifications.signal_scores IS
  'Wave 11.2: per-signal 0-10 scores from Stage 1. 22 keys: exposure_balance, '
  'color_cast, sharpness_subject, sharpness_corners, depth_layering, '
  'composition_geometry, vantage_quality, framing_quality, leading_lines, '
  'negative_space, symmetry_quality, perspective_distortion, plumb_verticals, '
  'material_specificity, period_reading, styling_quality, distraction_freeness, '
  'retouch_debt, gallery_arc_position, social_crop_survival, '
  'brochure_print_survival, reading_grade_match. The 4 aggregate axis scores '
  '(technical / lighting / composition / aesthetic) are weighted rollups of '
  'these — the JSONB is additional granularity, not a replacement.';

CREATE INDEX IF NOT EXISTS idx_classif_signal_scores
  ON composition_classifications USING gin (signal_scores);

NOTIFY pgrst, 'reload schema';

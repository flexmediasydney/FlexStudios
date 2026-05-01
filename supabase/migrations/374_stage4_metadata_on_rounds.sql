-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 374 — Wave 11.7: Stage 4 cross-image metadata on rounds
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md
--       (Stage 4 outputs section)
--
-- Adds the cross-image metadata columns Stage 4 emits per round:
--   * gallery_sequence — ordered stems for marketing gallery
--   * dedup_groups — visual dedup clusters
--   * missing_shot_recommendations — gaps the engine identified
--   * narrative_arc_score — gallery walkthrough coherence (0-10)
--   * property_archetype_consensus — master-level archetype label
--   * overall_property_score — single property-level Tier rating
--   * stage_4_completed_at — wall-clock stamp of Stage 4 success
--   * stage_1_total_cost_usd — sum of Stage 1 batch costs
--   * stage_4_cost_usd — Stage 4 single-call cost
--
-- DEPENDS ON: shortlisting_rounds table existing (mig 282). Pure additive.
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. JSONB vs typed columns split:
--      * gallery_sequence stored as JSONB (array of stems).
--      * dedup_groups stored as JSONB (array of {group_label, image_stems}).
--      * missing_shot_recommendations stored as TEXT[] (simpler shape; no
--        per-element metadata).
--      * narrative_arc_score, overall_property_score: NUMERIC (typed; queryable).
--      * property_archetype_consensus: TEXT (free-form label; W12 may later
--        canonicalise but at v1 the label is whatever Stage 4 emits).
--      * cost columns: NUMERIC(8,4) — sub-cent precision; high enough for
--        Anthropic-failover spikes (~$45/round worst case).
--      * stage_4_completed_at: TIMESTAMPTZ.
--
--    This split balances queryability (NUMERIC for the score columns lets
--    the W11.6 dashboard run COUNT/AVG aggregates without JSONB extraction)
--    against schema flexibility (JSONB for the array shapes that may grow
--    metadata fields later — e.g. dedup_groups gaining per-group confidence
--    scores in W11.7.7.x).
--
-- 2. All columns are nullable. The two-pass legacy engine doesn't emit any
--    of these; existing rows + ongoing two-pass rounds correctly read NULL.
--    The Shape D orchestrator populates them per Stage 4 success.
--
-- 3. No backfill. Existing rounds were two-pass; they don't have these
--    values. Reading code must handle NULL gracefully (it should — these
--    are net-new emissions).
--
-- 4. Index choices:
--      * narrative_arc_score, overall_property_score: indexed because the
--        W11.6 dashboard sorts/filters by them.
--      * stage_4_completed_at: indexed for "rounds completed in last 7 days"
--        time-window queries.
--      * gallery_sequence + dedup_groups: NO index. JSONB GIN indexes are
--        expensive and these are rarely queried — they're written once and
--        read on round-display only. If/when a query path emerges (e.g.
--        "find all rounds where IMG_X appears in gallery_sequence"), add a
--        GIN index in a follow-up migration.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Cross-image cluster columns (JSONB / TEXT[]) ─────────────────────────

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS gallery_sequence JSONB;

COMMENT ON COLUMN shortlisting_rounds.gallery_sequence IS
  'Wave 11.7 / Stage 4: ordered array of image stems for the marketing '
  'gallery. JSON array of strings. Emitted by Stage 4''s visual master '
  'synthesis based on cross-image narrative reasoning. NULL on two-pass '
  'rounds (legacy didn''t emit gallery sequencing).';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS dedup_groups JSONB;

COMMENT ON COLUMN shortlisting_rounds.dedup_groups IS
  'Wave 11.7 / Stage 4: visual near-dedup clusters. JSON array of '
  '{group_label, image_stems}. Used by the swimlane to surface near-duplicate '
  'rejections inline so operators see why X was preferred over Y. Emitted by '
  'Stage 4 only; NULL on two-pass rounds.';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS missing_shot_recommendations TEXT[];

COMMENT ON COLUMN shortlisting_rounds.missing_shot_recommendations IS
  'Wave 11.7 / Stage 4: gaps the engine identified in the gallery (e.g. "no '
  'master bedroom shot from a wider angle", "exterior_rear angle missing"). '
  'Array of TEXT — each element is a recommendation string for the next '
  'shoot. Emitted by Stage 4 only; NULL on two-pass rounds.';

-- ─── 2. Score columns (NUMERIC; queryable) ───────────────────────────────────

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS narrative_arc_score NUMERIC(4, 2);

COMMENT ON COLUMN shortlisting_rounds.narrative_arc_score IS
  'Wave 11.7 / Stage 4: 0.00-10.00 score for gallery walkthrough coherence — '
  'does the sequence read as a story? Emitted by Stage 4. NULL on two-pass '
  'rounds. W11.6 dashboard surfaces low-arc rounds for review.';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS property_archetype_consensus TEXT;

COMMENT ON COLUMN shortlisting_rounds.property_archetype_consensus IS
  'Wave 11.7 / Stage 4: master-level archetype label for the property '
  '(e.g. "post_war_renovated_suburban_family", "harbour_pavilion_architectural"). '
  'Free-form at v1; W12 may later canonicalise. NULL on two-pass rounds.';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS overall_property_score NUMERIC(4, 2);

COMMENT ON COLUMN shortlisting_rounds.overall_property_score IS
  'Wave 11.7 / Stage 4: 0.00-10.00 single property-level rating. Stage 4 '
  'aggregates across the full image set. Used as a tie-breaker in agent-'
  'facing reports + W11.6 quality monitoring. NULL on two-pass rounds.';

-- ─── 3. Cost + wall-clock attribution columns ────────────────────────────────

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS stage_4_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN shortlisting_rounds.stage_4_completed_at IS
  'Wave 11.7 / Stage 4: TIMESTAMPTZ when Stage 4 visual master synthesis '
  'completed successfully. NULL on two-pass rounds, on Shape D rounds where '
  'Stage 4 hasn''t fired yet, and on Stage-4-failed rounds.';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS stage_1_total_cost_usd NUMERIC(8, 4);

COMMENT ON COLUMN shortlisting_rounds.stage_1_total_cost_usd IS
  'Wave 11.7 / cost attribution: sum of all Stage 1 batch costs for this '
  'round in USD. Typically ~$2.64 for a 200-angle shoot (4 batches × $0.66). '
  'Anthropic failover scales ~12x. Sourced from vendor_shadow_runs / engine_'
  'run_audit usage_metrics. NULL on two-pass rounds.';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS stage_4_cost_usd NUMERIC(8, 4);

COMMENT ON COLUMN shortlisting_rounds.stage_4_cost_usd IS
  'Wave 11.7 / cost attribution: Stage 4 single-call cost in USD. Typically '
  '~$1.20 on Gemini, ~$14.40 on Anthropic failover. NULL on two-pass rounds '
  'and on Shape D rounds that haven''t reached Stage 4 yet.';

-- ─── 4. Indexes for queryable columns ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_arc_score
  ON shortlisting_rounds(narrative_arc_score)
  WHERE narrative_arc_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_overall_score
  ON shortlisting_rounds(overall_property_score)
  WHERE overall_property_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_stage4_completed
  ON shortlisting_rounds(stage_4_completed_at DESC)
  WHERE stage_4_completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_archetype
  ON shortlisting_rounds(property_archetype_consensus)
  WHERE property_archetype_consensus IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP INDEX IF EXISTS idx_shortlisting_rounds_archetype;
-- DROP INDEX IF EXISTS idx_shortlisting_rounds_stage4_completed;
-- DROP INDEX IF EXISTS idx_shortlisting_rounds_overall_score;
-- DROP INDEX IF EXISTS idx_shortlisting_rounds_arc_score;
--
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS stage_4_cost_usd;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS stage_1_total_cost_usd;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS stage_4_completed_at;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS overall_property_score;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS property_archetype_consensus;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS narrative_arc_score;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS missing_shot_recommendations;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS dedup_groups;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS gallery_sequence;
--
-- Note: column drops are data-lossy if any Shape D rounds have been written.
-- Pre-rollback dump pattern:
--   CREATE TABLE _rollback_rounds_stage4_meta AS
--     SELECT id, gallery_sequence, dedup_groups, missing_shot_recommendations,
--            narrative_arc_score, property_archetype_consensus,
--            overall_property_score, stage_4_completed_at,
--            stage_1_total_cost_usd, stage_4_cost_usd
--       FROM shortlisting_rounds
--      WHERE stage_4_completed_at IS NOT NULL
--         OR gallery_sequence IS NOT NULL
--         OR dedup_groups IS NOT NULL;

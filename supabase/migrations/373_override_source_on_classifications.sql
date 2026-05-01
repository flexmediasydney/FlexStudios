-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 373 — Wave 11.5/11.7: override_source on classification overrides
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-5-human-reclassification-capture.md
--
-- Adds `override_source` (TEXT, default 'stage1_correction') to
-- composition_classification_overrides. Captures which stage of the Shape D
-- engine produced the value the operator is correcting / confirming.
--
-- ─── ⚠ DEPENDENCY NOTE ───────────────────────────────────────────────────────
-- composition_classification_overrides does NOT exist in production today.
-- W11.5 has not shipped its table-creation migration. This draft therefore
-- includes a CREATE TABLE IF NOT EXISTS block that creates the table with the
-- new override_source column already in place. If W11.5 ships its own
-- creation migration FIRST, this draft becomes ALTER-only and the CREATE
-- block becomes a no-op (the IF NOT EXISTS guard).
--
-- Joseph: please decide before applying:
--    Option A (recommended): apply this draft as the ONLY creator of
--             composition_classification_overrides. W11.5 spec text remains
--             accurate; this migration absorbs W11.5's table-creation
--             responsibility into the W11.7-pre-flight set.
--    Option B: apply W11.5's table-creation first, then apply this draft.
--             The CREATE block here becomes a no-op, the ADD COLUMN block
--             takes effect.
-- Either path is idempotent; the resulting schema is identical.
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. CHECK values for override_source:
--      'stage1_correction'      — operator corrected a Stage 1 per-image
--                                 emission (room_type, composition_type,
--                                 vantage_point, score). This is the default
--                                 because it's the most common operator
--                                 action.
--      'stage4_visual_override' — operator confirmed (or further refined) a
--                                 Stage 4 cross-image correction. Stage 4
--                                 already overrode Stage 1 visually; the
--                                 operator is endorsing or tweaking that
--                                 correction.
--      'master_admin_correction'— master_admin reclassification that should
--                                 be weighted higher in W14 calibration.
--                                 (Tied to the W11.5 §"Q2 — score override
--                                 authority" recommendation: tag master_admin
--                                 reclassifications as authoritative.)
--
--    The W11.5 spec uses 'stage1' / 'stage4' shorthand; this migration uses
--    the more explicit 'stage1_correction' / 'stage4_visual_override' to
--    avoid ambiguity at the SQL layer (a future reader doesn't need to
--    cross-reference the spec to understand what 'stage4' means).
--
-- 2. UNIQUE constraint update.
--    The W11.5 spec defines:
--       UNIQUE (group_id, round_id, override_source)
--    This means a single (group, round) pair can have BOTH a stage1_correction
--    AND a stage4_visual_override row simultaneously — the operator can
--    reclassify against Stage 1 AND endorse Stage 4's separate correction on
--    the same image, and both are tracked. This is the W11.5 design intent
--    (§"Two override classes" in the architectural alignment section).
--
--    HOWEVER — Joseph flagged in spec review that this UNIQUE shape may not
--    be the right one. Alternative shapes considered:
--       (a) UNIQUE (group_id, round_id) — one row per (group, round) total,
--           override_source becomes a status flag rather than a partition
--           key. Simpler; loses the dual-override-class capture.
--       (b) UNIQUE (group_id, round_id, override_source) — spec default;
--           matches §"Two override classes" intent.
--       (c) No UNIQUE constraint — multiple override rows per (group, round,
--           source) allowed; adds complexity to the COALESCE-into-Stage-1
--           projection. Rejected.
--
--    THIS DRAFT IMPLEMENTS (b) per the W11.5 spec. If Joseph prefers (a),
--    the UNIQUE constraint clause below should be edited before apply.
--    Document the choice in the migration commit message.
--
-- 3. Backfill of existing rows: this migration sets override_source to
--    'stage1_correction' for any existing row. In Option A (table doesn't
--    exist), the backfill is a no-op (zero rows). In Option B (W11.5 already
--    shipped), all pre-existing override rows came from operators correcting
--    Stage 1 or Pass 1 emissions — they're correctly tagged 'stage1_correction'.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. CREATE TABLE composition_classification_overrides (if missing) ───────
-- See dependency note above. This block is a no-op when the table already
-- exists; it creates the table fresh per W11.5 §"Section 1" when not.
--
-- /* Idempotent table creation — W11.5 may ship its own migration first; this
--    draft is forward-compatible either way. The CREATE TABLE IF NOT EXISTS
--    guarantees no clobber, and the ALTER TABLE ADD COLUMN IF NOT EXISTS in
--    the next block adds override_source whether the table was created here
--    or pre-existed. Joseph (N2): W11.5 owns table-creation; this draft
--    absorbs the responsibility forward-compat. */

CREATE TABLE IF NOT EXISTS composition_classification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES composition_groups(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  -- Which stage emitted the value the operator is correcting / confirming.
  -- Default 'stage1_correction' (the most common operator action).
  override_source TEXT NOT NULL DEFAULT 'stage1_correction',
  -- Original AI values (denormalised so we can replay the override decision)
  ai_room_type TEXT,
  ai_composition_type TEXT,
  ai_vantage_point TEXT,
  ai_combined_score NUMERIC(4, 2),
  -- Human overrides (only the fields the operator actually corrected; null = accept AI)
  human_room_type TEXT,
  human_composition_type TEXT,
  human_vantage_point TEXT,
  human_combined_score NUMERIC(4, 2),
  human_combined_score_authoritative BOOLEAN NOT NULL DEFAULT FALSE,
  human_eligible_slot_ids TEXT[],
  override_reason TEXT,
  override_notes TEXT,
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE NO ACTION,
  actor_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE composition_classification_overrides IS
  'Wave 11.5: project-scoped operator reclassifications of Stage 1 / Stage 4 '
  'output. Feeds project_memory block in Stage 1 prompt assembly so the '
  'engine respects prior corrections on the same project. Cross-project '
  'memory is W12 (object_registry); cross-project few-shot examples are W14 '
  '(engine_fewshot_examples).';

-- ─── 2. ADD COLUMN override_source (when table pre-existed without it) ──────

ALTER TABLE composition_classification_overrides
  ADD COLUMN IF NOT EXISTS override_source TEXT;

-- Default applies for future inserts. Existing rows get backfilled below.
ALTER TABLE composition_classification_overrides
  ALTER COLUMN override_source SET DEFAULT 'stage1_correction';

COMMENT ON COLUMN composition_classification_overrides.override_source IS
  'Wave 11.5/11.7: which engine stage produced the value being corrected. '
  '"stage1_correction" — operator corrected a Stage 1 per-image emission '
  '(room_type/composition/vantage/score). "stage4_visual_override" — operator '
  'confirmed/refined a Stage 4 visual-cross-comparison correction (Stage 4 '
  'overrode Stage 1; operator endorses). "master_admin_correction" — '
  'master_admin reclassification weighted higher in W14 calibration. Default '
  '"stage1_correction" (most common path).';

-- ─── 3. BACKFILL existing rows to 'stage1_correction' ────────────────────────
-- For Option A (table just-created): zero rows, no-op.
-- For Option B (table pre-existed via W11.5's own migration): all prior
-- override rows came from operators correcting per-image Stage 1 / Pass 1
-- emissions — 'stage1_correction' is the correct legacy label.
-- Batched per MIGRATION_SAFETY.md §"Backfill in batches".

DO $$
DECLARE
  batch_size CONSTANT INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE composition_classification_overrides
       SET override_source = 'stage1_correction'
     WHERE id IN (
       SELECT id FROM composition_classification_overrides
        WHERE override_source IS NULL
        LIMIT batch_size
     );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- ─── 4. ADD CHECK CONSTRAINT (after backfill) ────────────────────────────────
-- NOT VALID + VALIDATE pattern so we don't hold a write lock while validating
-- existing rows.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'composition_classification_overrides_source_chk'
       AND conrelid = 'composition_classification_overrides'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE composition_classification_overrides
             ADD CONSTRAINT composition_classification_overrides_source_chk
             CHECK (override_source IN (
               ''stage1_correction'',
               ''stage4_visual_override'',
               ''master_admin_correction''
             ))
             NOT VALID';
    EXECUTE 'ALTER TABLE composition_classification_overrides
             VALIDATE CONSTRAINT composition_classification_overrides_source_chk';
  END IF;
END $$;

-- ─── 5. SET NOT NULL on override_source ──────────────────────────────────────
-- After backfill confirms zero NULLs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM composition_classification_overrides
     WHERE override_source IS NULL
  ) THEN
    ALTER TABLE composition_classification_overrides
      ALTER COLUMN override_source SET NOT NULL;
  END IF;
END $$;

-- ─── 6. UNIQUE constraint on (group_id, round_id, override_source) ───────────
-- Per W11.5 §"Section 1". Enables the dual-override-class capture: one row
-- per (group, round, source) means a single (group, round) can carry both a
-- stage1_correction AND a stage4_visual_override row.
--
-- For Option B: if W11.5 already shipped a UNIQUE (group_id, round_id) without
-- override_source, the orchestrator must drop the old constraint and replace
-- with this one in a coordinated step. The block below safely creates the
-- new constraint when no equivalent exists; manual cleanup of the legacy
-- 2-column UNIQUE may be needed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'composition_classification_overrides_grp_rnd_src_uniq'
       AND conrelid = 'composition_classification_overrides'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE composition_classification_overrides
             ADD CONSTRAINT composition_classification_overrides_grp_rnd_src_uniq
             UNIQUE (group_id, round_id, override_source)';
  END IF;
END $$;

-- ─── 7. INDEXES ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_class_overrides_round
  ON composition_classification_overrides(round_id);
CREATE INDEX IF NOT EXISTS idx_class_overrides_actor
  ON composition_classification_overrides(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_class_overrides_human_room_type
  ON composition_classification_overrides(human_room_type)
  WHERE human_room_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_class_overrides_source
  ON composition_classification_overrides(override_source);

-- ─── 8. RLS policies ─────────────────────────────────────────────────────────
-- Pattern mirrors mig 370 (vendor_*) + mig 339 (engine_settings):
--   * SELECT to master_admin + admin + manager
--     (manager included because reclassification is an operator action;
--      W11.5 §"Section 4" lists master_admin / admin / manager as authorised
--      to commit overrides).
--   * UPDATE to master_admin + admin (operators can amend their own; admin
--     reviews; master_admin handles edge cases).
--   * INSERT/DELETE service-role only (the reclassify-composition edge fn
--     uses service-role).

ALTER TABLE composition_classification_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "composition_classification_overrides_select"
  ON composition_classification_overrides;
CREATE POLICY "composition_classification_overrides_select"
  ON composition_classification_overrides
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin', 'manager')
  );

DROP POLICY IF EXISTS "composition_classification_overrides_update"
  ON composition_classification_overrides;
CREATE POLICY "composition_classification_overrides_update"
  ON composition_classification_overrides
  FOR UPDATE TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- ALTER TABLE composition_classification_overrides
--   DROP CONSTRAINT IF EXISTS composition_classification_overrides_grp_rnd_src_uniq;
-- ALTER TABLE composition_classification_overrides
--   DROP CONSTRAINT IF EXISTS composition_classification_overrides_source_chk;
-- ALTER TABLE composition_classification_overrides
--   ALTER COLUMN override_source DROP NOT NULL;
-- ALTER TABLE composition_classification_overrides
--   ALTER COLUMN override_source DROP DEFAULT;
-- ALTER TABLE composition_classification_overrides
--   DROP COLUMN IF EXISTS override_source;
--
-- DROP INDEX IF EXISTS idx_class_overrides_source;
--
-- The CREATE TABLE block is idempotent — drop it only if Option A (this
-- migration created the table fresh):
--   ALTER TABLE composition_classification_overrides DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS composition_classification_overrides;
--
-- Note: dropping the table is data-lossy. Pre-rollback dump:
--   CREATE TABLE _rollback_classification_overrides AS
--     SELECT * FROM composition_classification_overrides;

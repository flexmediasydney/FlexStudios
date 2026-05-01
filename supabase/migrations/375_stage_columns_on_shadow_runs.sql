-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 375 — Wave 11.7/11.6: stage attribution on vendor_shadow_runs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md (Stage 1
--       vs Stage 4 attribution)
--       docs/design-specs/W11-6-rejection-dashboard.md (cost-per-stage widget)
--
-- Adds Stage 1 vs Stage 4 attribution to vendor_shadow_runs (mig 370). Without
-- these columns, the audit harness can't tell whether a shadow run was
-- comparing the Stage 1 batched call or the Stage 4 master synthesis call —
-- they have different cost models, different prompt blocks, and surface in
-- different W11.6 dashboard widgets.
--
-- DEPENDS ON: vendor_shadow_runs table from mig 370.
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. CHECK values for `stage`:
--      'stage1'              — Shape D Stage 1 batched per-image enrichment
--      'stage4'              — Shape D Stage 4 visual master synthesis
--      'classification_legacy' — pre-Shape D Pass 1 / unified call (existing
--                                rows from W11.8 retro-comparison)
--
--    The W11.8 wave (mig 370) already has `pass_kind` on vendor_shadow_runs
--    with values 'unified' | 'description_backfill' | 'pass0_hardreject'.
--    THAT column captures the legacy two-pass routing; THIS new `stage`
--    column captures the Shape D routing. Both coexist:
--       * Two-pass row: stage='classification_legacy', pass_kind=<existing>
--       * Shape D Stage 1: stage='stage1', pass_kind=NEW value (set by the
--         orchestrator — recommend 'shape_d_stage1' but pass_kind is open
--         enum so no constraint needed)
--       * Shape D Stage 4: stage='stage4', pass_kind='shape_d_stage4'
--
--    This keeps the existing W11.8 audit data queryable on its own terms
--    while adding a clean axis for Shape D attribution. No backfill of
--    `pass_kind` is needed.
--
-- 2. parent_call_id: a self-FK letting Stage 4 rows reference the Stage 1
--    batch set they synthesised over. This enables "show me every Stage 1
--    call that fed into Stage 4 round X" queries which the W11.6 dashboard's
--    cost-per-stage widget needs.
--
--    The FK uses ON DELETE SET NULL so deleting a Stage 1 audit row doesn't
--    cascade-delete Stage 4 audit rows (which still need the per-call data
--    for cost reconciliation).
--
--    parent_call_id is nullable because:
--      (a) Stage 1 rows have no parent (they ARE the leaf)
--      (b) classification_legacy rows have no Stage 4 parent
--      (c) the sentinel "first" Stage 4 of a round will have NULL because
--          Stage 4 fans IN from many Stage 1 rows; if we wanted to capture
--          the full set we'd need a junction table. parent_call_id captures
--          the "primary" parent (first-batch Stage 1 row of the round) as a
--          best-effort pointer; engine_run_audit (mig 376) has the full
--          per-stage breakdown.
--
-- 3. Backfill: existing rows (created via W11.8 retroactive compare) get
--    stage='classification_legacy'. They were comparing the legacy unified
--    call which is the pre-Shape-D path.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD stage column ─────────────────────────────────────────────────────

ALTER TABLE vendor_shadow_runs
  ADD COLUMN IF NOT EXISTS stage TEXT;

COMMENT ON COLUMN vendor_shadow_runs.stage IS
  'Wave 11.7: Shape D engine stage that produced this shadow run. '
  '"stage1" — Shape D batched per-image enrichment. '
  '"stage4" — Shape D visual master synthesis. '
  '"classification_legacy" — pre-Shape D Pass 1 / unified call. '
  'Coexists with pass_kind (W11.8 column): pass_kind captures legacy '
  'routing labels; stage captures Shape D architectural axis.';

-- ─── 2. ADD parent_call_id column ────────────────────────────────────────────

ALTER TABLE vendor_shadow_runs
  ADD COLUMN IF NOT EXISTS parent_call_id UUID;

-- FK with ON DELETE SET NULL so audit graph integrity survives ad-hoc deletes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vendor_shadow_runs_parent_call_fk'
       AND conrelid = 'vendor_shadow_runs'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE vendor_shadow_runs
             ADD CONSTRAINT vendor_shadow_runs_parent_call_fk
             FOREIGN KEY (parent_call_id) REFERENCES vendor_shadow_runs(id)
             ON DELETE SET NULL';
  END IF;
END $$;

COMMENT ON COLUMN vendor_shadow_runs.parent_call_id IS
  'Wave 11.7: when stage="stage4", references the FIRST Stage 1 audit row of '
  'the round (best-effort pointer to the parent batch set). NULL for '
  'stage="stage1" leaf calls and "classification_legacy" rows. Full per-stage '
  'lineage lives in engine_run_audit (mig 376); this is a fast index for '
  '"show me the stage1 set behind this stage4 call" queries.';

-- ─── 3. BACKFILL existing rows to 'classification_legacy' ────────────────────
-- Existing rows came from the W11.8 retroactive comparison harness comparing
-- the legacy unified call. Tag them appropriately so the W11.6 dashboard can
-- segment Shape-D vs legacy data.
-- Batched per MIGRATION_SAFETY.md §"Backfill in batches".

DO $$
DECLARE
  batch_size CONSTANT INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE vendor_shadow_runs
       SET stage = 'classification_legacy'
     WHERE id IN (
       SELECT id FROM vendor_shadow_runs
        WHERE stage IS NULL
        LIMIT batch_size
     );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- ─── 4. ADD CHECK CONSTRAINT (after backfill) ────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vendor_shadow_runs_stage_chk'
       AND conrelid = 'vendor_shadow_runs'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE vendor_shadow_runs
             ADD CONSTRAINT vendor_shadow_runs_stage_chk
             CHECK (stage IS NULL OR stage IN (
               ''stage1'', ''stage4'', ''classification_legacy''
             ))
             NOT VALID';
    EXECUTE 'ALTER TABLE vendor_shadow_runs
             VALIDATE CONSTRAINT vendor_shadow_runs_stage_chk';
  END IF;
END $$;

-- ─── 5. SET NOT NULL on stage (after backfill confirms zero NULLs) ───────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vendor_shadow_runs WHERE stage IS NULL
  ) THEN
    ALTER TABLE vendor_shadow_runs
      ALTER COLUMN stage SET NOT NULL;
  END IF;
END $$;

-- ─── 6. INDEXES ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_shadow_runs_stage
  ON vendor_shadow_runs(stage);

CREATE INDEX IF NOT EXISTS idx_shadow_runs_round_stage
  ON vendor_shadow_runs(round_id, stage);

CREATE INDEX IF NOT EXISTS idx_shadow_runs_parent_call
  ON vendor_shadow_runs(parent_call_id)
  WHERE parent_call_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP INDEX IF EXISTS idx_shadow_runs_parent_call;
-- DROP INDEX IF EXISTS idx_shadow_runs_round_stage;
-- DROP INDEX IF EXISTS idx_shadow_runs_stage;
--
-- ALTER TABLE vendor_shadow_runs
--   DROP CONSTRAINT IF EXISTS vendor_shadow_runs_stage_chk;
-- ALTER TABLE vendor_shadow_runs
--   DROP CONSTRAINT IF EXISTS vendor_shadow_runs_parent_call_fk;
-- ALTER TABLE vendor_shadow_runs
--   ALTER COLUMN stage DROP NOT NULL;
-- ALTER TABLE vendor_shadow_runs DROP COLUMN IF EXISTS parent_call_id;
-- ALTER TABLE vendor_shadow_runs DROP COLUMN IF EXISTS stage;
--
-- Rollback is non-data-lossy on the stage column for legacy rows (they were
-- 'classification_legacy' which can be re-derived from pass_kind). Shape D
-- rows would lose their stage attribution; pre-rollback dump if those exist:
--   CREATE TABLE _rollback_shadow_runs_stage AS
--     SELECT id, stage, parent_call_id FROM vendor_shadow_runs
--      WHERE stage IN ('stage1', 'stage4');

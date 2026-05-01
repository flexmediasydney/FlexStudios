-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 384a — Wave 14: structured calibration runs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W14-structured-calibration.md
--
-- Two new tables capture the output of the `shortlisting-calibration-runner`
-- edge function:
--
--   1. engine_calibration_run_summaries — one row per calibration RUN
--   2. engine_calibration_runs          — one row per (run, project)
--
-- Numbering: 384a chains after 383_slot_id_canonicalisation. The trailing
-- letter avoids collision with anyone else holding 384/385 in flight.
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. Two-table split, not single-table:
--      * Per-run aggregates (median deltas, pass/fail, total cost) are queried
--        independently of per-project detail (the dashboard hits the summary
--        first, lazy-loads the detail).
--      * Future: holdout sets, per-tier filters, A/B-style "compare run X vs
--        run Y" all read summary-only. Per-project rows are heavy (jsonb
--        snapshots) — keeping them out of the summary keeps the index hot.
--
-- 2. `run_id` is a TEXT natural key (e.g. "calib-2026-05-01-rainbow-saladine"),
--    not a UUID. Operators eyeball it; UUID is unhelpful in logs. Uniqueness
--    enforced by UNIQUE constraint.
--
-- 3. Both tables have `summary_jsonb` columns even though many fields are
--    typed. Reason: the dashboard renders rich detail (per-axis distributions,
--    per-slot diffs, drift event lists) that isn't worth flattening to columns
--    — the typed columns power the index/sort/filter; the jsonb carries the
--    raw context.
--
-- 4. RLS:
--      * SELECT: master_admin + admin (the calibration is an internal QA
--        surface, not contractor-visible)
--      * INSERT/UPDATE: service-role only (the runner edge fn writes; humans
--        don't hand-edit calibration rows)
--      * DELETE: master_admin only (rare — cleanup of old runs)
--
-- 5. Indexes:
--      * summaries: started_at DESC for "recent runs" list; status for active-run filter
--      * runs: run_id for fan-out fetch; (run_id, project_id) UNIQUE so re-runs
--        of the same (run, project) UPSERT cleanly
--      * runs.project_id for cross-run "show me drift over time for project X"
--
-- 6. Cascade: ON DELETE CASCADE from runs → summaries via run_id text FK is
--    intentional. If admin deletes a run, the per-project rows go too.
--
-- 7. NULL-tolerance: many metric columns are nullable because partial runs
--    happen (a round times out, runner records what it has). The dashboard
--    treats NULL as "—" — never as zero.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. engine_calibration_run_summaries ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS engine_calibration_run_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL UNIQUE,                         -- e.g. 'calib-2026-05-01-smoke'
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,                             -- nullable until terminal
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','timeout')),

  -- Sampling provenance
  seed BIGINT,                                         -- NULL when operator-picked project_ids
  sample_mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (sample_mode IN ('manual','auto_sample')),
  n_projects_requested INT NOT NULL DEFAULT 0,
  n_projects_dispatched INT NOT NULL DEFAULT 0,
  n_projects_completed INT NOT NULL DEFAULT 0,
  n_projects_failed INT NOT NULL DEFAULT 0,

  -- Cost rollup
  total_cost_usd NUMERIC(8,4) DEFAULT 0,

  -- Median metrics across per-project rows
  median_score_delta NUMERIC(4,2),                     -- max-axis median
  median_slot_agreement NUMERIC(5,4),
  median_override_rate NUMERIC(5,4),
  median_regression_pct NUMERIC(5,4),
  master_listing_oob_rate NUMERIC(5,4),                -- % out-of-band
  voice_anchor_stability NUMERIC(5,4),                 -- 0..1, per-tier weighted

  -- Pass/fail evaluation
  acceptance_pass BOOLEAN,                             -- nullable until run completes
  failed_criteria TEXT[] NOT NULL DEFAULT '{}',        -- which criteria failed if !pass

  -- Triggered by
  triggered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Free-form structured detail for the dashboard
  summary_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE engine_calibration_run_summaries IS
  'Wave 14 (W14): one row per calibration run. Aggregates per-project metrics into a single '
  'pass/fail evaluation. Powers the CalibrationDashboard summary card. See '
  'docs/design-specs/W14-structured-calibration.md.';

COMMENT ON COLUMN engine_calibration_run_summaries.run_id IS
  'Natural ID, e.g. "calib-2026-05-01-smoke". Operator-readable; surfaces in logs and CSV exports.';

COMMENT ON COLUMN engine_calibration_run_summaries.seed IS
  'Sampling seed when sample_mode=auto_sample. NULL when operator hand-picked project_ids. Same '
  'seed reproduces the same project sample (md5(project_id::text || seed::text) determinism).';

COMMENT ON COLUMN engine_calibration_run_summaries.acceptance_pass IS
  'TRUE iff all 5 acceptance criteria met: median_score_delta < 0.3, median_slot_agreement >= 0.80, '
  'median_override_rate ∈ [0.02, 0.08], median_regression_pct < 0.02, master_listing_oob_rate <= 0.10. '
  'NULL until run terminates.';

CREATE INDEX IF NOT EXISTS idx_calibration_summaries_started_desc
  ON engine_calibration_run_summaries(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calibration_summaries_status
  ON engine_calibration_run_summaries(status) WHERE status = 'running';

-- ─── 2. engine_calibration_runs ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS engine_calibration_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL
    REFERENCES engine_calibration_run_summaries(run_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','timeout')),

  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,

  -- Score consistency (per-image deltas vs prior run)
  -- jsonb shape: { median: {tech, light, comp, aes}, p95: {...}, max: {...},
  --               drift_events: [{stem, axis, prior, now, delta}] }
  score_consistency_jsonb JSONB,

  -- Slot agreement
  slot_agreement_pct NUMERIC(5,4),
  slot_diff_jsonb JSONB,                               -- per-slot agree/disagree detail

  -- Override metrics
  override_count INT,
  override_rate NUMERIC(5,4),

  -- Regression metrics
  regression_count INT,
  regression_pct NUMERIC(5,4),
  regression_detail_jsonb JSONB,                       -- list of {stem, prior_severity, now_severity}

  -- Master listing
  master_listing_in_band BOOLEAN,
  word_count_now INT,
  reading_grade_level_now NUMERIC(4,2),
  tone_anchor_now TEXT,

  -- Cost
  cost_usd NUMERIC(8,4),

  -- Snapshots (debug + replay)
  pre_run_snapshot JSONB,
  post_run_snapshot JSONB,

  -- Error tracking
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT engine_calibration_runs_unique_per_run_project
    UNIQUE (run_id, project_id)
);

COMMENT ON TABLE engine_calibration_runs IS
  'Wave 14 (W14): one row per (calibration_run, project). Captures the per-project metrics + '
  'pre/post snapshots so a dashboard can render the diff inline without re-running anything.';

COMMENT ON COLUMN engine_calibration_runs.score_consistency_jsonb IS
  'Per-axis delta distribution vs the prior run for THIS round. Shape: '
  '{ median: {technical, lighting, composition, aesthetic}, p95: {...}, max: {...}, '
  '  drift_events: [{stem, axis, prior, now, delta}] }. Drift event when |delta| > 0.5 on any axis.';

COMMENT ON COLUMN engine_calibration_runs.slot_agreement_pct IS
  'Fraction of slots where this run picked the SAME winning stem as the prior run. NULL when '
  'there were no slots to compare (e.g. first-ever run).';

COMMENT ON COLUMN engine_calibration_runs.master_listing_in_band IS
  'Per-tier word_count band: premium 700-1000 / standard 500-750 / approachable 350-500. NULL '
  'when no master_listing was emitted (Stage 4 failure).';

CREATE INDEX IF NOT EXISTS idx_calibration_runs_run_id
  ON engine_calibration_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_calibration_runs_project_id
  ON engine_calibration_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calibration_runs_status
  ON engine_calibration_runs(status) WHERE status IN ('pending','running');

-- ─── 3. updated_at trigger ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION engine_calibration_runs_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS engine_calibration_run_summaries_updated_at_trg
  ON engine_calibration_run_summaries;
CREATE TRIGGER engine_calibration_run_summaries_updated_at_trg
  BEFORE UPDATE ON engine_calibration_run_summaries
  FOR EACH ROW EXECUTE FUNCTION engine_calibration_runs_set_updated_at();

DROP TRIGGER IF EXISTS engine_calibration_runs_updated_at_trg
  ON engine_calibration_runs;
CREATE TRIGGER engine_calibration_runs_updated_at_trg
  BEFORE UPDATE ON engine_calibration_runs
  FOR EACH ROW EXECUTE FUNCTION engine_calibration_runs_set_updated_at();

-- ─── 4. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE engine_calibration_run_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_calibration_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS engine_calib_summaries_select ON engine_calibration_run_summaries;
CREATE POLICY engine_calib_summaries_select
  ON engine_calibration_run_summaries
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS engine_calib_summaries_modify ON engine_calibration_run_summaries;
CREATE POLICY engine_calib_summaries_modify
  ON engine_calibration_run_summaries
  FOR ALL TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

DROP POLICY IF EXISTS engine_calib_runs_select ON engine_calibration_runs;
CREATE POLICY engine_calib_runs_select
  ON engine_calibration_runs
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS engine_calib_runs_modify ON engine_calibration_runs;
CREATE POLICY engine_calib_runs_modify
  ON engine_calibration_runs
  FOR ALL TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual) ───────────────────────────────────────────────────────
--
-- DROP TABLE IF EXISTS engine_calibration_runs;
-- DROP TABLE IF EXISTS engine_calibration_run_summaries;
-- DROP FUNCTION IF EXISTS engine_calibration_runs_set_updated_at();

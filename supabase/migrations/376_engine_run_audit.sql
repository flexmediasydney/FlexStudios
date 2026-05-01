-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 376 — Wave 11.6/11.7: per-round engine_run_audit rollup
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md (cost
--       model + replay reproducibility)
--       docs/design-specs/W11-6-rejection-dashboard.md (cost-per-stage widget)
--
-- ─── WHY THIS TABLE EXISTS ────────────────────────────────────────────────────
--
-- vendor_shadow_runs (mig 370 + 375) captures PER-CALL detail: every Stage 1
-- batch + Stage 4 call gets one row, with the full request payload + response
-- + usage metrics. This is the audit-replay substrate.
--
-- engine_run_audit captures PER-ROUND ROLLUP: one row per round summarising
-- which engine architecture ran, which vendor + model, which stages succeeded,
-- aggregate cost / wall-time / token usage, and any error summary. This is
-- the source-of-truth for the W11.6 dashboard's cost-per-stage widget and
-- the per-round replay/health page.
--
-- The two tables serve different consumers:
--   * vendor_shadow_runs: replay harness, raw payload archaeology, A/B vendor
--     comparison.
--   * engine_run_audit: dashboard rollups, cost reporting, ops alerts.
--
-- Without engine_run_audit, the dashboard would have to JOIN+aggregate across
-- vendor_shadow_runs on every page load — workable for tens of rounds, but
-- unworkable at the 50K-rounds/yr scale projected in W11.7 §"Cost model".
-- The rollup is built ONCE at round-completion and served fast thereafter.
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. One row per round. PRIMARY KEY on round_id (not a synthetic UUID + UNIQUE
--    constraint) because we want exactly one rollup per round, ever — a
--    re-run would update the existing row, not insert a new one. PK on the
--    natural key enforces this at the schema layer.
--
-- 2. Per-stage breakdown stored as INDIVIDUAL columns, not as a JSONB blob.
--    Rationale: the dashboard's primary query is
--       "SELECT AVG(stage_4_cost_usd), AVG(stage_4_wall_ms) FROM engine_run_audit
--        WHERE created_at > NOW() - INTERVAL '7 days' AND engine_mode = 'shape_d_full'"
--    which is fast on flat columns and slow against JSONB extraction.
--    The trade-off is schema growth: adding Stage 5 in a future architectural
--    revision means an ALTER TABLE. Acceptable — that's a major architectural
--    change anyway.
--
-- 3. stages_completed is a TEXT[] capturing the success/failure status of
--    each stage as ['stage1_b1', 'stage1_b2', 'stage1_b3', 'stage1_b4',
--    'stage4', 'persistence']. Allows fast "rounds where stage4 failed"
--    queries without parsing error_summary.
--
-- 4. error_summary is a single TEXT field (not JSONB). The expectation is one
--    primary error message per round; the per-call error detail lives on the
--    relevant vendor_shadow_runs row. error_summary is the human-readable
--    "what went wrong this round" line for the dashboard.
--
-- 5. Schema covers BOTH legacy two-pass AND Shape D rounds. Legacy rounds
--    populate the columns relevant to them (pass1_*, pass2_*); Shape D rounds
--    populate stage1_*, stage4_*. Both modes can coexist during the W11.7.4
--    Phase A coexistence period. legacy_pass1_cost_usd / legacy_pass2_cost_usd
--    are explicitly named to make the legacy bucket queryable as a separate
--    axis in dashboards.
--
-- 6. RLS: SELECT to master_admin + admin (read-only dashboard access).
--    INSERT/UPDATE/DELETE service-role only. Audit rows must not be hand-
--    edited; that breaks rollup integrity.
--
-- 7. The table is INDEPENDENT of vendor_shadow_runs — no FK. Reasons:
--      (a) vendor_shadow_runs is per-call; we'd need a junction table.
--      (b) engine_run_audit may be populated for legacy rounds before
--          shadow runs were enabled (no FK target).
--      (c) lookups across the two tables happen via round_id directly.
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. CREATE TABLE engine_run_audit ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS engine_run_audit (
  -- PK is round_id directly: enforces one row per round at the schema layer.
  round_id UUID PRIMARY KEY REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,

  -- Engine architecture stamp
  engine_mode TEXT NOT NULL,             -- 'two_pass' | 'shape_d_full' | 'shape_d_partial' | 'shape_d_textfallback' | 'unified_anthropic_failover'
  vendor_used TEXT NOT NULL,             -- 'google' | 'anthropic'
  model_used TEXT NOT NULL,              -- e.g. 'gemini-2.5-pro' | 'claude-opus-4-7'
  failover_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  failover_reason TEXT,                  -- e.g. 'gemini_5xx_after_3_retries' | 'gemini_rate_limit_60s'

  -- Stages completed (success/failure granularity)
  stages_completed TEXT[],               -- e.g. ['stage1_b1', 'stage1_b2', 'stage1_b3', 'stage4', 'persistence']
  stages_failed TEXT[],                  -- e.g. ['stage1_b3'] (paired with shape_d_partial mode)

  -- Stage 1 aggregate (Shape D)
  stage1_call_count INT,                 -- typically 1-4 (number of batches)
  stage1_total_cost_usd NUMERIC(8, 4),
  stage1_total_wall_ms INT,              -- max across parallel batches (Promise.all wall, not sum)
  stage1_total_input_tokens INT,
  stage1_total_output_tokens INT,
  stage1_total_thinking_tokens INT,

  -- Stage 4 (Shape D)
  stage4_call_count INT,                 -- 0 (failed) or 1 (succeeded) typically; 2 if retry happened
  stage4_total_cost_usd NUMERIC(8, 4),
  stage4_total_wall_ms INT,
  stage4_total_input_tokens INT,
  stage4_total_output_tokens INT,
  stage4_total_thinking_tokens INT,

  -- Pass 0 (Haiku hard-reject + bracket detection — runs in both modes)
  pass0_call_count INT,
  pass0_total_cost_usd NUMERIC(8, 4),
  pass0_total_wall_ms INT,

  -- Legacy two-pass attribution (engine_mode='two_pass')
  legacy_pass1_call_count INT,
  legacy_pass1_total_cost_usd NUMERIC(8, 4),
  legacy_pass1_total_wall_ms INT,
  legacy_pass2_call_count INT,
  legacy_pass2_total_cost_usd NUMERIC(8, 4),
  legacy_pass2_total_wall_ms INT,

  -- Round-level totals (sums of relevant per-stage columns)
  total_cost_usd NUMERIC(8, 4) NOT NULL DEFAULT 0,
  total_wall_ms INT NOT NULL DEFAULT 0,
  total_input_tokens INT,
  total_output_tokens INT,

  -- Error summary
  error_summary TEXT,                    -- short human-readable; per-call detail in vendor_shadow_runs
  retry_count INT NOT NULL DEFAULT 0,    -- total retries across all stages

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,              -- NULL = round is still running / pending; non-NULL = terminal state
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT engine_run_audit_engine_mode_chk
    CHECK (engine_mode IN (
      'two_pass',
      'shape_d_full',
      'shape_d_partial',
      'shape_d_textfallback',
      'unified_anthropic_failover'
    )),
  CONSTRAINT engine_run_audit_vendor_chk
    CHECK (vendor_used IN ('google', 'anthropic')),
  CONSTRAINT engine_run_audit_total_cost_nonneg
    CHECK (total_cost_usd >= 0),
  CONSTRAINT engine_run_audit_total_wall_nonneg
    CHECK (total_wall_ms >= 0)
);

COMMENT ON TABLE engine_run_audit IS
  'Wave 11.6/11.7: per-round engine execution rollup. One row per round '
  'summarising architecture, vendor, per-stage cost + wall + tokens, error '
  'summary. Source-of-truth for the W11.6 cost-per-stage dashboard widget '
  'and per-round replay page. Per-call detail lives in vendor_shadow_runs; '
  'this table is the rollup layer indexed for fast aggregate queries '
  '(AVG cost over last 7d, p95 wall time, etc).';

COMMENT ON COLUMN engine_run_audit.engine_mode IS
  'Architectural variant: two_pass (legacy) | shape_d_full (Shape D, all '
  'stages succeeded) | shape_d_partial (one Stage 1 batch failed; degraded) '
  '| shape_d_textfallback (Stage 4 failed, text-only fallback) | '
  'unified_anthropic_failover (vendor outage routed to Anthropic).';

COMMENT ON COLUMN engine_run_audit.stages_completed IS
  'TEXT[] of stages that completed successfully, e.g. '
  '[''pass0'', ''stage1_b1'', ''stage1_b2'', ''stage4'', ''persistence''].';

COMMENT ON COLUMN engine_run_audit.stages_failed IS
  'TEXT[] of stages that failed irrecoverably (after retries). Empty array on '
  'fully-successful rounds. Paired with shape_d_partial / shape_d_textfallback '
  'engine_modes.';

COMMENT ON COLUMN engine_run_audit.failover_triggered IS
  'TRUE when the round routed through the W11.8 multi-vendor adapter''s '
  'failover path (production_vendor unavailable → routed to failover_vendor). '
  'Drives the W11.6 alert: ">5%% Anthropic-routed in 24h".';

COMMENT ON COLUMN engine_run_audit.stage1_total_wall_ms IS
  'MAX wall time across parallel Stage 1 batches (Promise.all observed wall, '
  'NOT sum-of-individual). Reflects the actual wall-time impact of Stage 1 '
  'on the round.';

COMMENT ON COLUMN engine_run_audit.completed_at IS
  'NULL while the round is still running or in a non-terminal state. '
  'Non-NULL = terminal: success, failure, or marked-failed by the dispatcher. '
  'Set at the same moment shortlisting_rounds.status moves to a terminal '
  'value. Used by the dashboard to filter completed rounds for cost rollups.';

-- ─── 2. INDEXES ──────────────────────────────────────────────────────────────

-- Primary lookup paths for the dashboard:
--   * "rounds in last N days, by engine_mode" → (created_at, engine_mode)
--   * "average cost per stage, last 7d, shape_d_full" → engine_mode + created_at
--   * "alert: failover triggered in last 24h" → failover_triggered + created_at
--   * "rounds with errors" → error_summary IS NOT NULL

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_created_at
  ON engine_run_audit(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_engine_mode
  ON engine_run_audit(engine_mode);

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_engine_mode_created
  ON engine_run_audit(engine_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_vendor
  ON engine_run_audit(vendor_used);

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_failover
  ON engine_run_audit(failover_triggered, created_at DESC)
  WHERE failover_triggered = TRUE;

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_completed
  ON engine_run_audit(completed_at DESC)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_engine_run_audit_errors
  ON engine_run_audit(created_at DESC)
  WHERE error_summary IS NOT NULL;

-- ─── 3. updated_at trigger (auto-bump on UPDATE) ─────────────────────────────
-- Pattern matches existing tables that track row updates (e.g. shortlisting_
-- tier_configs in mig 344). The trigger ensures updated_at always reflects
-- the actual mutation time without callers needing to set it.

CREATE OR REPLACE FUNCTION engine_run_audit_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS engine_run_audit_updated_at_trigger ON engine_run_audit;
CREATE TRIGGER engine_run_audit_updated_at_trigger
  BEFORE UPDATE ON engine_run_audit
  FOR EACH ROW
  EXECUTE FUNCTION engine_run_audit_set_updated_at();

-- ─── 4. RLS policies ─────────────────────────────────────────────────────────
-- Pattern mirrors mig 370 (vendor_shadow_runs):
--   * SELECT to master_admin + admin (dashboard read access)
--   * UPDATE service-role only (rollups are computed by edge fns; no manual
--     edits — that breaks audit integrity)
--   * INSERT/DELETE service-role only

ALTER TABLE engine_run_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "engine_run_audit_select_admin" ON engine_run_audit;
CREATE POLICY "engine_run_audit_select_admin" ON engine_run_audit
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

-- No UPDATE policy on purpose — service-role bypasses RLS, hand-editing the
-- audit row would break rollup integrity. If a correction is genuinely
-- needed, master_admin must do it via SQL editor with service-role, leaving
-- a Postgres audit-log trail.

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP TRIGGER IF EXISTS engine_run_audit_updated_at_trigger ON engine_run_audit;
-- DROP FUNCTION IF EXISTS engine_run_audit_set_updated_at();
--
-- ALTER TABLE engine_run_audit DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS engine_run_audit;
--
-- Note: dropping the table is data-lossy (cost-per-round attribution data
-- can't be reconstructed without re-aggregating from vendor_shadow_runs +
-- per-edge-fn logs). Pre-rollback dump:
--   CREATE TABLE _rollback_engine_run_audit AS
--     SELECT * FROM engine_run_audit;
--
-- Reconstruction path post-rollback: re-derive per-round rollups by
-- aggregating vendor_shadow_runs grouped by (round_id, stage), join with
-- shortlisting_rounds.engine_mode + status. Approximate but recoverable.

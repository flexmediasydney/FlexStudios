-- Wave 6 P8 SHORTLIST: mig 295: benchmark results table + is_benchmark on rounds + analytics RPCs
--
-- Closes the Phase 8 learning loop:
--
--   1. ALTER shortlisting_rounds: add is_benchmark + confirmed_shortlist_group_ids
--      - is_benchmark: admin-toggled flag marking a locked round as part of the
--        50-project holdout set used for the quarterly accuracy benchmark.
--      - confirmed_shortlist_group_ids: snapshot of approved group_ids at lock
--        time (populated by shortlist-lock + the training extractor). Required
--        so the benchmark runner has a stable comparison target even if events
--        get edited after the round was locked.
--
--   2. CREATE shortlisting_benchmark_results: history table for quarterly
--      accuracy benchmarks. Each row captures one run's match_rate,
--      improvement_vs_baseline (0.78 from Goldmine 4), per-slot breakdown,
--      per-package breakdown, model versions, sample size, and trigger.
--      Spec §14.
--
--   3. CREATE FUNCTION get_override_analytics(): aggregates
--      shortlisting_overrides into 4 dimensions (slot / signal / action /
--      tier) for the override analytics admin page.
--
--   4. CREATE FUNCTION get_training_examples_summary(): paginated read of
--      shortlisting_training_examples for the curator UI, ranked by weight DESC
--      and filtered by variant_count / was_override / training_grade.
--
-- All RPCs are SECURITY INVOKER + STABLE with explicit search_path (matches
-- mig 279 hardening). They read from RLS-protected tables so callers must
-- already have the necessary role.

-- =============================================================================
-- 1. ALTER shortlisting_rounds — is_benchmark + confirmed_shortlist_group_ids
-- =============================================================================

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS is_benchmark BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confirmed_shortlist_group_ids UUID[] DEFAULT '{}'::UUID[];

COMMENT ON COLUMN shortlisting_rounds.is_benchmark IS
  'TRUE when admin marks the round as part of the 50-project holdout set for the quarterly accuracy benchmark. Toggled from the Calibration page UI. Spec §14.';
COMMENT ON COLUMN shortlisting_rounds.confirmed_shortlist_group_ids IS
  'Snapshot of approved composition_group ids at lock time. Populated by shortlist-lock so the benchmark runner has a stable target even if events are later edited. Spec §14.';

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_is_benchmark
  ON shortlisting_rounds(is_benchmark) WHERE is_benchmark = TRUE;

-- =============================================================================
-- 2. CREATE TABLE shortlisting_benchmark_results
-- =============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_benchmark_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ran_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual', 'quarterly_cron')),
  sample_size INT NOT NULL,
  total_matches INT NOT NULL,
  total_slots INT NOT NULL,
  match_rate NUMERIC(5,4) NOT NULL,
  baseline_match_rate NUMERIC(5,4) NOT NULL DEFAULT 0.78,
  improvement_vs_baseline NUMERIC(5,4) NOT NULL,
  per_slot_match_rates JSONB,        -- { slot_id: rate }
  per_package_match_rates JSONB,     -- { package_type: rate }
  engine_version TEXT,                -- e.g. "wave-6-p4"
  model_versions JSONB,               -- { pass1: 'claude-sonnet-4-6', pass2: 'claude-sonnet-4-6' }
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_benchmark_results_ran_at
  ON shortlisting_benchmark_results(ran_at DESC);

COMMENT ON TABLE shortlisting_benchmark_results IS
  'Quarterly accuracy benchmark history. One row per run. match_rate is the engine-vs-confirmed match across the holdout set; baseline_match_rate=0.78 is the Goldmine 4 zero-knowledge baseline. Spec §14.';

ALTER TABLE shortlisting_benchmark_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY brench_select_all ON shortlisting_benchmark_results
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
  );

CREATE POLICY brench_insert_admin ON shortlisting_benchmark_results
  FOR INSERT TO authenticated WITH CHECK (
    get_user_role() IN ('master_admin','admin')
  );

CREATE POLICY brench_delete_owner_only ON shortlisting_benchmark_results
  FOR DELETE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

-- =============================================================================
-- 3. RPC: get_override_analytics
-- =============================================================================
-- Returns aggregated counts per dimension (slot / signal / action / tier).
-- The frontend shows one ranked list per dimension. `total` (count over the
-- filter window) is the denominator for `rate`.

CREATE OR REPLACE FUNCTION get_override_analytics(
  p_since TIMESTAMPTZ DEFAULT (NOW() - INTERVAL '90 days'),
  p_package_type TEXT DEFAULT NULL,
  p_project_tier TEXT DEFAULT NULL
)
RETURNS TABLE (
  dimension TEXT,        -- 'slot' | 'signal' | 'tier' | 'action'
  bucket TEXT,           -- the value (slot_id, signal_key, tier name, action name)
  count BIGINT,
  rate NUMERIC(5,4)      -- count / total_overrides_in_filter
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total BIGINT;
BEGIN
  -- Compute total overrides in the filter window (denominator for rate).
  -- Apply the same project_tier filter; package_type filter is a join on
  -- shortlisting_rounds (kept simple — apply only when supplied).
  SELECT COUNT(*) INTO v_total
  FROM shortlisting_overrides o
  WHERE o.created_at >= p_since
    AND (p_project_tier IS NULL OR o.project_tier = p_project_tier)
    AND (
      p_package_type IS NULL
      OR EXISTS (
        SELECT 1 FROM shortlisting_rounds r
        WHERE r.id = o.round_id AND r.package_type = p_package_type
      )
    );

  IF v_total = 0 THEN RETURN; END IF;

  -- by slot (use slot_group_id, fall back to ai_proposed_slot_id, then '<unassigned>')
  RETURN QUERY
  SELECT 'slot'::TEXT,
         COALESCE(o.slot_group_id, o.ai_proposed_slot_id, '<unassigned>')::TEXT AS bucket,
         COUNT(*)::BIGINT AS count,
         ROUND((COUNT(*)::NUMERIC / v_total), 4) AS rate
  FROM shortlisting_overrides o
  WHERE o.created_at >= p_since
    AND (p_project_tier IS NULL OR o.project_tier = p_project_tier)
    AND (
      p_package_type IS NULL
      OR EXISTS (
        SELECT 1 FROM shortlisting_rounds r
        WHERE r.id = o.round_id AND r.package_type = p_package_type
      )
    )
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT 20;

  -- by signal
  RETURN QUERY
  SELECT 'signal'::TEXT,
         COALESCE(o.primary_signal_overridden, '<unspecified>')::TEXT AS bucket,
         COUNT(*)::BIGINT AS count,
         ROUND((COUNT(*)::NUMERIC / v_total), 4) AS rate
  FROM shortlisting_overrides o
  WHERE o.created_at >= p_since
    AND o.primary_signal_overridden IS NOT NULL
    AND (p_project_tier IS NULL OR o.project_tier = p_project_tier)
    AND (
      p_package_type IS NULL
      OR EXISTS (
        SELECT 1 FROM shortlisting_rounds r
        WHERE r.id = o.round_id AND r.package_type = p_package_type
      )
    )
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT 20;

  -- by action
  RETURN QUERY
  SELECT 'action'::TEXT,
         o.human_action::TEXT AS bucket,
         COUNT(*)::BIGINT AS count,
         ROUND((COUNT(*)::NUMERIC / v_total), 4) AS rate
  FROM shortlisting_overrides o
  WHERE o.created_at >= p_since
    AND (p_project_tier IS NULL OR o.project_tier = p_project_tier)
    AND (
      p_package_type IS NULL
      OR EXISTS (
        SELECT 1 FROM shortlisting_rounds r
        WHERE r.id = o.round_id AND r.package_type = p_package_type
      )
    )
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT 20;

  -- by tier
  RETURN QUERY
  SELECT 'tier'::TEXT,
         COALESCE(o.project_tier, 'unknown')::TEXT AS bucket,
         COUNT(*)::BIGINT AS count,
         ROUND((COUNT(*)::NUMERIC / v_total), 4) AS rate
  FROM shortlisting_overrides o
  WHERE o.created_at >= p_since
    AND (p_project_tier IS NULL OR o.project_tier = p_project_tier)
    AND (
      p_package_type IS NULL
      OR EXISTS (
        SELECT 1 FROM shortlisting_rounds r
        WHERE r.id = o.round_id AND r.package_type = p_package_type
      )
    )
  GROUP BY 1, 2
  ORDER BY 3 DESC
  LIMIT 20;
END;
$$;

COMMENT ON FUNCTION get_override_analytics IS
  'Aggregates shortlisting_overrides across slot/signal/action/tier dimensions. Returns one row per (dimension, bucket) with count and rate (= count / total_overrides_in_filter). Default window is last 90 days. Spec §14 — feeds the Override Analytics admin page.';

GRANT EXECUTE ON FUNCTION get_override_analytics(TIMESTAMPTZ, TEXT, TEXT)
  TO authenticated, service_role;

-- =============================================================================
-- 4. RPC: get_training_examples_summary
-- =============================================================================
-- Paginated read of shortlisting_training_examples for the curator UI.
-- Ranked by weight DESC, then created_at DESC. Filters: min variant_count,
-- was_override, exclude excluded rows.

CREATE OR REPLACE FUNCTION get_training_examples_summary(
  p_limit INT DEFAULT 100,
  p_min_variant_count INT DEFAULT 1,
  p_was_override BOOLEAN DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  composition_group_id UUID,
  delivery_reference_stem TEXT,
  variant_count INT,
  slot_id TEXT,
  package_type TEXT,
  project_tier TEXT,
  human_confirmed_score NUMERIC,
  ai_proposed_score NUMERIC,
  was_override BOOLEAN,
  weight NUMERIC,
  training_grade BOOLEAN,
  excluded BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    id,
    composition_group_id,
    delivery_reference_stem,
    variant_count,
    slot_id,
    package_type,
    project_tier,
    human_confirmed_score,
    ai_proposed_score,
    was_override,
    weight,
    training_grade,
    excluded,
    created_at
  FROM shortlisting_training_examples
  WHERE variant_count >= p_min_variant_count
    AND (p_was_override IS NULL OR was_override = p_was_override)
    AND excluded = FALSE
  ORDER BY weight DESC, created_at DESC
  LIMIT GREATEST(p_limit, 0);
$$;

COMMENT ON FUNCTION get_training_examples_summary IS
  'Paginated read of shortlisting_training_examples for the curator UI. Ranked by weight DESC, created_at DESC. Excludes rows where excluded=TRUE. Spec §14.';

GRANT EXECUTE ON FUNCTION get_training_examples_summary(INT, INT, BOOLEAN)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

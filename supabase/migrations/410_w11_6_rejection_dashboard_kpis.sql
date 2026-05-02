-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 410 — Wave 11.6: rejection-reasons dashboard KPI RPC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md
--
-- Adds a single read-only RPC `pulse_or_engine_admin_kpis_for_rejection_dashboard`
-- that powers the SettingsRejectionReasonsDashboard master_admin page. Returns
-- one JSONB blob holding all six dashboard widgets in a single round-trip,
-- mirroring the W15b.9 `pulse_command_center_kpis(int)` pattern.
--
-- Why one RPC, not six:
--   * Each widget aggregates over a different table but shares the same
--     time window (p_days). Single RPC keeps the page snappy and the
--     dashboard's state model trivial (one `useQuery`).
--   * Read-only — no DDL, no DML; safe to drop/replace at any time.
--   * SECURITY DEFINER so the page can call without granting SELECT on
--     every underlying engine table to the authenticated role. Mirrors
--     `pulse_command_center_kpis` (mig 402) exactly.
--
-- Widget contents:
--   1. human_override_heatmap — top 20 raw_label values from
--      raw_attribute_observations WHERE source_type='human_override' over the
--      window. Surfaces "what humans correct most".
--   2. stage4_self_corrections — counts + sample rows from
--      shortlisting_stage4_overrides over the window, grouped by `field`.
--      Surfaces cross-stage learning rate per field.
--   3. voice_tier_distribution — count by property_tier on
--      shortlisting_master_listings over the window. Surfaces voice-tier
--      drift against package mappings.
--   4. master_listing_metrics — avg word_count + avg reading_grade_level
--      over the window. Surfaces over-long copy / grade mismatches.
--   5. canonical_registry_coverage — % of observed_objects entries on
--      composition_classifications WHERE proposed_canonical_id IS NOT NULL.
--      Surfaces W12 registry coverage growth.
--   6. cost_per_stage — last 7 days from engine_run_audit: avg
--      stage1_total_cost_usd, avg stage4_total_cost_usd, avg total_cost_usd.
--      Independent of p_days because cost trend is short-window by design.
--
-- Implementation note:
--   We avoid `row_to_jsonb(t)` over derived subqueries because Postgres can
--   refuse to resolve the record type on certain subquery shapes (errored on
--   PG17 with "function row_to_jsonb(record) does not exist"). Using
--   `jsonb_build_object` with explicit columns is the portable form.
--
-- Defensive zero-state:
--   Every widget wraps its aggregation in COALESCE(..., default) and returns
--   sensible empty values (0, NULL, '[]') when the underlying table is empty.
--   Critical for fresh-deploy environments where no human overrides have
--   been captured yet (W11.5 just shipped 2026-05-01).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pulse_or_engine_admin_kpis_for_rejection_dashboard(
  p_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start timestamptz;
  v_human_override_heatmap jsonb;
  v_stage4_corrections jsonb;
  v_voice_tier_distribution jsonb;
  v_master_listing_metrics jsonb;
  v_canonical_coverage jsonb;
  v_cost_per_stage jsonb;
  v_total_overrides_count int;
  v_total_stage4_count int;
  v_total_master_listings int;
BEGIN
  -- Clamp p_days to a sane range.
  IF p_days IS NULL OR p_days < 1 THEN
    p_days := 30;
  ELSIF p_days > 365 THEN
    p_days := 365;
  END IF;

  v_window_start := now() - (p_days || ' days')::interval;

  -- ── 1. Human override heatmap ─────────────────────────────────────────────
  BEGIN
    SELECT COUNT(*)
      INTO v_total_overrides_count
      FROM raw_attribute_observations
     WHERE source_type = 'human_override'
       AND created_at >= v_window_start;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('raw_label', raw_label, 'count', cnt)
        ORDER BY cnt DESC
      ),
      '[]'::jsonb
    )
      INTO v_human_override_heatmap
      FROM (
        SELECT raw_label, COUNT(*) AS cnt
          FROM raw_attribute_observations
         WHERE source_type = 'human_override'
           AND created_at >= v_window_start
         GROUP BY raw_label
         ORDER BY cnt DESC
         LIMIT 20
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_total_overrides_count := 0;
    v_human_override_heatmap := '[]'::jsonb;
  END;

  -- ── 2. Stage 4 self-correction events ─────────────────────────────────────
  BEGIN
    SELECT COUNT(*)
      INTO v_total_stage4_count
      FROM shortlisting_stage4_overrides
     WHERE created_at >= v_window_start;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('field', field, 'count', cnt, 'samples', samples)
        ORDER BY cnt DESC
      ),
      '[]'::jsonb
    )
      INTO v_stage4_corrections
      FROM (
        SELECT
          field,
          COUNT(*) AS cnt,
          jsonb_agg(
            jsonb_build_object(
              'stem', stem,
              'stage_1_value', stage_1_value,
              'stage_4_value', stage_4_value,
              'reason', LEFT(COALESCE(reason, ''), 200),
              'created_at', created_at
            )
            ORDER BY created_at DESC
          ) AS samples
          FROM (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY field ORDER BY created_at DESC) AS rn
              FROM shortlisting_stage4_overrides
             WHERE created_at >= v_window_start
          ) ranked
         WHERE rn <= 5
         GROUP BY field
         ORDER BY cnt DESC
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_total_stage4_count := 0;
    v_stage4_corrections := '[]'::jsonb;
  END;

  -- ── 3. Voice tier distribution ────────────────────────────────────────────
  BEGIN
    SELECT COUNT(*)
      INTO v_total_master_listings
      FROM shortlisting_master_listings
     WHERE deleted_at IS NULL
       AND created_at >= v_window_start;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('tier', tier, 'count', cnt)
        ORDER BY cnt DESC
      ),
      '[]'::jsonb
    )
      INTO v_voice_tier_distribution
      FROM (
        SELECT
          COALESCE(property_tier, 'unspecified') AS tier,
          COUNT(*) AS cnt
          FROM shortlisting_master_listings
         WHERE deleted_at IS NULL
           AND created_at >= v_window_start
         GROUP BY COALESCE(property_tier, 'unspecified')
         ORDER BY cnt DESC
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_total_master_listings := 0;
    v_voice_tier_distribution := '[]'::jsonb;
  END;

  -- ── 4. Master listing copy metrics ────────────────────────────────────────
  BEGIN
    SELECT jsonb_build_object(
      'avg_word_count',
        COALESCE(AVG(COALESCE(word_count_computed, word_count)), 0),
      'avg_reading_grade_level',
        COALESCE(AVG(COALESCE(reading_grade_level_computed, reading_grade_level)), 0),
      'p50_word_count',
        COALESCE(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY COALESCE(word_count_computed, word_count)
        ), 0),
      'p95_word_count',
        COALESCE(percentile_cont(0.95) WITHIN GROUP (
          ORDER BY COALESCE(word_count_computed, word_count)
        ), 0),
      'p50_reading_grade',
        COALESCE(percentile_cont(0.5) WITHIN GROUP (
          ORDER BY COALESCE(reading_grade_level_computed, reading_grade_level)
        ), 0),
      'sample_size', COUNT(*)
    )
    INTO v_master_listing_metrics
    FROM shortlisting_master_listings
    WHERE deleted_at IS NULL
      AND created_at >= v_window_start
      AND COALESCE(word_count_computed, word_count) IS NOT NULL;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_master_listing_metrics := jsonb_build_object(
      'avg_word_count', 0, 'avg_reading_grade_level', 0,
      'p50_word_count', 0, 'p95_word_count', 0,
      'p50_reading_grade', 0, 'sample_size', 0
    );
  END;

  -- ── 5. Canonical registry coverage ────────────────────────────────────────
  BEGIN
    WITH sampled AS (
      SELECT observed_objects
        FROM composition_classifications
       WHERE created_at >= v_window_start
         AND observed_objects IS NOT NULL
         AND jsonb_typeof(observed_objects) = 'array'
       ORDER BY created_at DESC
       LIMIT 5000
    ),
    flattened AS (
      SELECT obj
        FROM sampled, jsonb_array_elements(observed_objects) AS obj
    )
    SELECT jsonb_build_object(
      'total_objects',
        COUNT(*),
      'resolved_count',
        COUNT(*) FILTER (
          WHERE obj ? 'proposed_canonical_id'
            AND obj->>'proposed_canonical_id' IS NOT NULL
            AND LENGTH(obj->>'proposed_canonical_id') > 0
        ),
      'resolved_pct',
        CASE WHEN COUNT(*) > 0
          THEN ROUND(
            100.0 * COUNT(*) FILTER (
              WHERE obj ? 'proposed_canonical_id'
                AND obj->>'proposed_canonical_id' IS NOT NULL
                AND LENGTH(obj->>'proposed_canonical_id') > 0
            ) / COUNT(*),
            1
          )
          ELSE 0
        END,
      'top_unresolved',
        (
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_object('raw_label', raw_label, 'count', cnt)
              ORDER BY cnt DESC
            ),
            '[]'::jsonb
          )
            FROM (
              SELECT
                obj->>'raw_label' AS raw_label,
                COUNT(*) AS cnt
                FROM flattened
               WHERE NOT (obj ? 'proposed_canonical_id')
                  OR obj->>'proposed_canonical_id' IS NULL
                  OR LENGTH(obj->>'proposed_canonical_id') = 0
               GROUP BY obj->>'raw_label'
               HAVING obj->>'raw_label' IS NOT NULL
               ORDER BY cnt DESC
               LIMIT 10
            ) u
        )
    )
    INTO v_canonical_coverage
    FROM flattened;

    IF v_canonical_coverage IS NULL THEN
      v_canonical_coverage := jsonb_build_object(
        'total_objects', 0,
        'resolved_count', 0,
        'resolved_pct', 0,
        'top_unresolved', '[]'::jsonb
      );
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_canonical_coverage := jsonb_build_object(
      'total_objects', 0,
      'resolved_count', 0,
      'resolved_pct', 0,
      'top_unresolved', '[]'::jsonb
    );
  END;

  -- ── 6. Cost per stage attribution (last 7 days, fixed window) ─────────────
  BEGIN
    SELECT jsonb_build_object(
      'window_days', 7,
      'sample_size', COUNT(*),
      'avg_stage1_cost_usd',
        COALESCE(AVG(stage1_total_cost_usd) FILTER (WHERE stage1_total_cost_usd IS NOT NULL), 0),
      'avg_stage4_cost_usd',
        COALESCE(AVG(stage4_total_cost_usd) FILTER (WHERE stage4_total_cost_usd IS NOT NULL), 0),
      'avg_total_cost_usd',
        COALESCE(AVG(total_cost_usd) FILTER (WHERE total_cost_usd IS NOT NULL), 0),
      'sum_total_cost_usd',
        COALESCE(SUM(total_cost_usd), 0),
      'rounds_completed',
        COUNT(*) FILTER (WHERE completed_at IS NOT NULL),
      'failover_rate_pct',
        CASE WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE failover_triggered) / COUNT(*), 1)
          ELSE 0
        END
    )
    INTO v_cost_per_stage
    FROM engine_run_audit
    WHERE created_at >= now() - interval '7 days';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_cost_per_stage := jsonb_build_object(
      'window_days', 7,
      'sample_size', 0,
      'avg_stage1_cost_usd', 0,
      'avg_stage4_cost_usd', 0,
      'avg_total_cost_usd', 0,
      'sum_total_cost_usd', 0,
      'rounds_completed', 0,
      'failover_rate_pct', 0
    );
  END;

  -- ── Final blob ────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'window_days', p_days,
    'computed_at', now(),
    'human_override_heatmap', jsonb_build_object(
      'total', COALESCE(v_total_overrides_count, 0),
      'top_labels', COALESCE(v_human_override_heatmap, '[]'::jsonb)
    ),
    'stage4_self_corrections', jsonb_build_object(
      'total', COALESCE(v_total_stage4_count, 0),
      'by_field', COALESCE(v_stage4_corrections, '[]'::jsonb)
    ),
    'voice_tier_distribution', jsonb_build_object(
      'total', COALESCE(v_total_master_listings, 0),
      'by_tier', COALESCE(v_voice_tier_distribution, '[]'::jsonb)
    ),
    'master_listing_metrics', COALESCE(v_master_listing_metrics, '{}'::jsonb),
    'canonical_registry_coverage', COALESCE(v_canonical_coverage, '{}'::jsonb),
    'cost_per_stage', COALESCE(v_cost_per_stage, '{}'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.pulse_or_engine_admin_kpis_for_rejection_dashboard(int) IS
  'Wave 11.6 — single-roundtrip aggregation for the SettingsRejectionReasonsDashboard. '
  'Returns six widgets in one JSONB blob: human override heatmap (top raw_labels '
  'from raw_attribute_observations WHERE source_type=human_override), Stage 4 '
  'self-correction event counts, voice tier distribution from master_listings, '
  'master listing copy metrics (word_count + reading_grade), canonical registry '
  'coverage % from composition_classifications.observed_objects, and cost-per-stage '
  'attribution from engine_run_audit. p_days controls the rolling window for the '
  'first five widgets (default 30); cost_per_stage is fixed-window 7d per spec.';

GRANT EXECUTE ON FUNCTION public.pulse_or_engine_admin_kpis_for_rejection_dashboard(int)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

-- 177_pulse_pipeline_health.sql
-- Adds pulse_get_pipeline_health_score() → jsonb, a single-call summary of the
-- Industry Pulse ingestion pipeline used by the Data Sources tab's health
-- ribbon. The UI scores four sub-components and blends them into an overall
-- A/B/C/D/F letter grade:
--
--   1. slo_pct   — % of enabled sources meeting the 95% coverage SLO in the
--                   rolling 24h window (from pulse_source_coverage).
--   2. success_pct — % of runs in the last 24h that completed successfully
--                   (pulse_sync_logs.status='completed' vs 'failed'). Running
--                   rows are excluded so a long-tail batch doesn't tank the
--                   score.
--   3. coverage_pct — weighted average coverage_pct_24h across enabled sources.
--   4. dead_letter_count — total pulse_fire_queue rows sitting in status='failed'
--                          with attempts >= max_attempts from the last 7d. 0 is
--                          healthy; any positive number weighs down the grade.
--
-- Returns a rich jsonb with per-component scores + breakdown arrays so the
-- ribbon can drill-click into each sub-badge.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_get_pipeline_health_score()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_slo_pct numeric;
  v_success_pct numeric;
  v_coverage_pct numeric;
  v_dead_letter int;
  v_sources_total int;
  v_sources_meeting_slo int;
  v_runs_total int;
  v_runs_succeeded int;
  v_runs_failed int;
  v_runs_running int;
  v_breakdown jsonb;
  v_dlq_by_source jsonb;
  v_grade text;
  v_overall numeric;
BEGIN
  -- ── 1. SLO: % of enabled sources with coverage >= 95% over 24h ────────
  SELECT
    count(*) FILTER (WHERE is_enabled = true),
    count(*) FILTER (WHERE is_enabled = true AND coverage_pct_24h >= 95)
  INTO v_sources_total, v_sources_meeting_slo
  FROM pulse_source_coverage;

  v_slo_pct := CASE WHEN v_sources_total > 0
    THEN ROUND(100.0 * v_sources_meeting_slo / v_sources_total, 1)
    ELSE 100 END;

  -- ── 2. Success: % of terminal runs in last 24h that completed ─────────
  SELECT
    count(*) FILTER (WHERE status IN ('completed','failed')),
    count(*) FILTER (WHERE status = 'completed'),
    count(*) FILTER (WHERE status = 'failed'),
    count(*) FILTER (WHERE status = 'running')
  INTO v_runs_total, v_runs_succeeded, v_runs_failed, v_runs_running
  FROM pulse_sync_logs
  WHERE started_at > now() - interval '24 hours';

  v_success_pct := CASE WHEN v_runs_total > 0
    THEN ROUND(100.0 * v_runs_succeeded / v_runs_total, 1)
    ELSE 100 END;

  -- ── 3. Coverage: weighted avg across enabled sources ──────────────────
  SELECT ROUND(AVG(coverage_pct_24h)::numeric, 1)
  INTO v_coverage_pct
  FROM pulse_source_coverage
  WHERE is_enabled = true AND coverage_pct_24h IS NOT NULL;
  v_coverage_pct := COALESCE(v_coverage_pct, 100);

  -- ── 4. Dead letter: failed queue rows in last 7d ──────────────────────
  SELECT count(*)
  INTO v_dead_letter
  FROM pulse_fire_queue
  WHERE status = 'failed'
    AND attempts >= max_attempts
    AND updated_at > now() - interval '7 days';

  -- ── Per-source breakdown for the ribbon drill ────────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'source_id',         c.source_id,
    'label',             c.label,
    'is_enabled',        c.is_enabled,
    'coverage_pct_24h',  c.coverage_pct_24h,
    'meets_slo',         COALESCE(c.coverage_pct_24h >= 95, false),
    'items_dead_lettered_24h', c.items_dead_lettered_24h,
    'items_pending',     c.items_pending,
    'items_running',     c.items_running,
    'circuit_state',     c.circuit_state,
    'last_completion_at', c.last_completion_at
  ) ORDER BY c.label), '[]'::jsonb)
  INTO v_breakdown
  FROM pulse_source_coverage c;

  -- ── Dead-letter by source (for the banner drill) ─────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'source_id', source_id,
    'count',     cnt,
    'last_dead_lettered_at', last_at
  ) ORDER BY cnt DESC), '[]'::jsonb)
  INTO v_dlq_by_source
  FROM (
    SELECT source_id, count(*) AS cnt, max(updated_at) AS last_at
    FROM pulse_fire_queue
    WHERE status = 'failed'
      AND attempts >= max_attempts
      AND updated_at > now() - interval '7 days'
    GROUP BY source_id
  ) x;

  -- ── Overall grade ─────────────────────────────────────────────────────
  -- Weighted blend: coverage 35%, success 25%, SLO 25%, DLQ penalty 15%.
  -- DLQ: 0 items → full 15 pts, 1-5 → 10, 6-20 → 5, >20 → 0.
  v_overall :=
    0.35 * v_coverage_pct
    + 0.25 * v_success_pct
    + 0.25 * v_slo_pct
    + 0.15 * CASE
        WHEN v_dead_letter = 0 THEN 100
        WHEN v_dead_letter <= 5 THEN 66
        WHEN v_dead_letter <= 20 THEN 33
        ELSE 0
      END;

  v_grade := CASE
    WHEN v_overall >= 95 THEN 'A'
    WHEN v_overall >= 85 THEN 'B'
    WHEN v_overall >= 70 THEN 'C'
    WHEN v_overall >= 55 THEN 'D'
    ELSE 'F'
  END;

  RETURN jsonb_build_object(
    'grade',                 v_grade,
    'overall_score',         ROUND(v_overall, 1),
    'slo_pct',               v_slo_pct,
    'sources_total',         v_sources_total,
    'sources_meeting_slo',   v_sources_meeting_slo,
    'success_pct',           v_success_pct,
    'runs_total_24h',        v_runs_total,
    'runs_succeeded_24h',    v_runs_succeeded,
    'runs_failed_24h',       v_runs_failed,
    'runs_running_24h',      v_runs_running,
    'coverage_pct',          v_coverage_pct,
    'dead_letter_count',     v_dead_letter,
    'breakdown',             v_breakdown,
    'dlq_by_source',         v_dlq_by_source,
    'snapshot_at',           now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_get_pipeline_health_score() TO authenticated, anon;

-- ── Helper: last N hours of runs across all sources for the swimlane ──
-- Returns one row per run with everything needed to render a colored block
-- on the timeline. Kept as a function (not a view) so the caller can bound
-- the time window and limit the row count.
CREATE OR REPLACE FUNCTION pulse_get_pipeline_swimlane(p_hours int DEFAULT 6, p_limit int DEFAULT 500)
RETURNS TABLE (
  id uuid,
  source_id text,
  status text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds numeric,
  records_fetched int,
  records_new int,
  error_message text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.id,
    l.source_id,
    l.status,
    l.started_at,
    l.completed_at,
    EXTRACT(EPOCH FROM (COALESCE(l.completed_at, now()) - l.started_at))::numeric AS duration_seconds,
    l.records_fetched,
    l.records_new,
    l.error_message
  FROM pulse_sync_logs l
  WHERE l.started_at > now() - (p_hours || ' hours')::interval
    AND l.source_id IS NOT NULL
  ORDER BY l.started_at DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION pulse_get_pipeline_swimlane(int, int) TO authenticated, anon;

-- ── Helper: aggregated errors for a source, last 7 days ───────────────
-- Groups pulse_sync_logs.error_message by a short signature (first 100 chars)
-- so the "Errors" drill-panel tab can show "12 occurrences of X" instead of
-- a scroll of near-identical rows.
CREATE OR REPLACE FUNCTION pulse_get_source_error_digest(p_source_id text, p_days int DEFAULT 7)
RETURNS TABLE (
  error_signature text,
  occurrences bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  example_sync_log_id uuid
)
LANGUAGE sql
STABLE
AS $$
  WITH sigs AS (
    SELECT
      l.id,
      l.started_at,
      LEFT(COALESCE(NULLIF(TRIM(l.error_message), ''), '—'), 120) AS sig,
      row_number() OVER (PARTITION BY LEFT(COALESCE(NULLIF(TRIM(l.error_message), ''), '—'), 120) ORDER BY l.started_at DESC) AS rn
    FROM pulse_sync_logs l
    WHERE l.source_id = p_source_id
      AND l.status = 'failed'
      AND l.started_at > now() - (p_days || ' days')::interval
  )
  SELECT
    sig,
    count(*)::bigint AS occurrences,
    min(started_at) AS first_seen,
    max(started_at) AS last_seen,
    (SELECT id FROM sigs s2 WHERE s2.sig = sigs.sig AND s2.rn = 1 LIMIT 1) AS example_sync_log_id
  FROM sigs
  GROUP BY sig
  ORDER BY count(*) DESC, max(started_at) DESC;
$$;

GRANT EXECUTE ON FUNCTION pulse_get_source_error_digest(text, int) TO authenticated, anon;

-- ── Helper: throughput (30-day items/run series) for a source ─────────
-- Used by the drill panel's "Throughput" tab chart. Returns one row per
-- completed run; the chart component sorts + axis-formats client-side.
CREATE OR REPLACE FUNCTION pulse_get_source_throughput(p_source_id text, p_days int DEFAULT 30)
RETURNS TABLE (
  sync_log_id uuid,
  started_at timestamptz,
  records_fetched int,
  records_new int,
  records_updated int,
  duration_seconds numeric,
  status text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.id,
    l.started_at,
    l.records_fetched,
    l.records_new,
    l.records_updated,
    EXTRACT(EPOCH FROM (COALESCE(l.completed_at, now()) - l.started_at))::numeric,
    l.status
  FROM pulse_sync_logs l
  WHERE l.source_id = p_source_id
    AND l.started_at > now() - (p_days || ' days')::interval
  ORDER BY l.started_at ASC;
$$;

GRANT EXECUTE ON FUNCTION pulse_get_source_throughput(text, int) TO authenticated, anon;

COMMIT;

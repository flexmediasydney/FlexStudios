-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 262: get_drone_dashboard_stats — include raw_preview_render cost
-- ───────────────────────────────────────────────────────────────────────────
-- QC8 D-06 / D-14:
-- The current cost formula in get_drone_dashboard_stats (mig 230) is:
--   sfm_today * 0.005 + render_today * 0.020 + poi_today * 0.032
-- It excludes successful raw_preview_render jobs. Today (2026-04-25) those
-- 13 successful previews represent ~$0.26 of untracked cost — and the
-- preview pipeline runs once per shoot per chain so the absolute number
-- climbs linearly with throughput.
--
-- Also: the `renders_today` tile only counted kind='render', masking 13
-- successful previews. Operators reading the dashboard saw zero work
-- happening when the pipeline was actually busy. We surface previews as a
-- separate output column (`previews_today`) AND fold them into
-- `renders_today` so the existing tile reflects the real throughput.
--
-- Cost weighting: previews use the same Modal render endpoint as production
-- renders (column_state='preview' is purely a downstream label) so the
-- per-call cost is identical (0.020).
-- ═══════════════════════════════════════════════════════════════════════════

-- Adding a new OUT column (previews_today) requires DROP-then-CREATE because
-- Postgres won't change the return-row signature via CREATE OR REPLACE.
DROP FUNCTION IF EXISTS public.get_drone_dashboard_stats();

CREATE FUNCTION public.get_drone_dashboard_stats()
RETURNS TABLE(
  shoots_today integer,
  jobs_pending integer,
  jobs_running integer,
  jobs_failed_24h integer,
  sfm_runs_30d integer,
  sfm_success_rate_30d numeric,
  sfm_residual_median_30d numeric,
  renders_today integer,
  previews_today integer,
  estimated_cost_today_usd numeric
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH
    today_start AS (
      SELECT (date_trunc('day', timezone('Australia/Sydney', now())) AT TIME ZONE 'Australia/Sydney') AS ts
    ),
    sfm_window AS (
      SELECT
        COUNT(*)::INT                                              AS total,
        COUNT(*) FILTER (WHERE status = 'succeeded')::INT          AS succeeded,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY residual_median_m)
          FILTER (WHERE status = 'succeeded' AND residual_median_m IS NOT NULL)
                                                                   AS median_residual
      FROM drone_sfm_runs
      WHERE started_at > NOW() - INTERVAL '30 days'
    ),
    today_counts AS (
      SELECT
        (SELECT COUNT(*) FROM drone_shoots
          WHERE created_at >= (SELECT ts FROM today_start))::INT   AS shoots_today,
        (SELECT COUNT(*) FROM drone_jobs WHERE status = 'pending')::INT
                                                                   AS jobs_pending,
        (SELECT COUNT(*) FROM drone_jobs WHERE status = 'running')::INT
                                                                   AS jobs_running,
        -- "Failed in last 24h" counts both terminal-failed (dead_letter) AND
        -- in-recovery jobs (pending but with attempt_count > 1, i.e. they've
        -- failed at least once and are scheduled for a backoff retry).
        (SELECT COUNT(*) FROM drone_jobs
          WHERE (
            status = 'dead_letter'
            OR (status = 'pending' AND attempt_count > 1)
          )
            AND COALESCE(finished_at, created_at) > NOW() - INTERVAL '24 hours')::INT
                                                                   AS jobs_failed_24h,
        (SELECT COUNT(*) FROM drone_jobs
          WHERE kind = 'sfm' AND status = 'succeeded'
            AND COALESCE(finished_at, created_at) >= (SELECT ts FROM today_start))::INT
                                                                   AS sfm_today_count,
        (SELECT COUNT(*) FROM drone_jobs
          WHERE kind = 'render' AND status = 'succeeded'
            AND COALESCE(finished_at, created_at) >= (SELECT ts FROM today_start))::INT
                                                                   AS render_today_count,
        (SELECT COUNT(*) FROM drone_jobs
          WHERE kind = 'raw_preview_render' AND status = 'succeeded'
            AND COALESCE(finished_at, created_at) >= (SELECT ts FROM today_start))::INT
                                                                   AS raw_preview_today_count,
        (SELECT COUNT(*) FROM drone_jobs
          WHERE kind = 'poi_fetch' AND status = 'succeeded'
            AND COALESCE(finished_at, created_at) >= (SELECT ts FROM today_start))::INT
                                                                   AS poi_today_count
    )
  SELECT
    tc.shoots_today                                                AS shoots_today,
    tc.jobs_pending                                                AS jobs_pending,
    tc.jobs_running                                                AS jobs_running,
    tc.jobs_failed_24h                                             AS jobs_failed_24h,
    sw.total                                                       AS sfm_runs_30d,
    CASE WHEN sw.total > 0
      THEN ROUND((sw.succeeded::NUMERIC / sw.total) * 100, 1)
      ELSE NULL
    END                                                            AS sfm_success_rate_30d,
    ROUND(sw.median_residual::NUMERIC, 2)                          AS sfm_residual_median_30d,
    -- renders_today now sums production renders + raw previews so the dashboard
    -- tile reflects total Modal-render activity (was: render-only, masking 13
    -- previews/day). previews_today is exposed separately so the UI can break
    -- the count down when needed (or keep showing the combined total).
    (tc.render_today_count + tc.raw_preview_today_count)           AS renders_today,
    tc.raw_preview_today_count                                     AS previews_today,
    -- Cost formula now includes raw_preview_render at the same per-call rate
    -- as production renders (both hit the same Modal endpoint).
    ROUND(
      (tc.sfm_today_count           * 0.005)
      + (tc.render_today_count      * 0.020)
      + (tc.raw_preview_today_count * 0.020)
      + (tc.poi_today_count         * 0.032)
    , 3)                                                           AS estimated_cost_today_usd
  FROM today_counts tc, sfm_window sw;
$function$;

NOTIFY pgrst, 'reload schema';

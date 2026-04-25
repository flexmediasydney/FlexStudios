-- ════════════════════════════════════════════════════════════════════════
-- Migration 249 — Dashboard RPCs read dead_letter (not 'failed')
--
-- The drone_jobs CHECK constraint allows the terminal-failure status to be
-- 'dead_letter', not 'failed' (see migration 232 + audit fix #32). The two
-- dashboard RPCs were still grepping for `status = 'failed'` (a holdover
-- from the original dispatcher draft), so:
--
--   - get_drone_dashboard_stats.jobs_failed_24h        → always 0
--   - get_drone_shoot_live_progress.jobs_failed_24h    → always 0
--
-- Result: Command Center shows "All clear" while jobs are silently dead-
-- lettered, and the per-shoot live-progress widget never warns the operator
-- that the next-step pipeline is wedged.
--
-- Fix: count `status = 'dead_letter'` AND surface in-recovery jobs (status
-- still 'pending' but having had at least one previous attempt → there's
-- backoff scheduled) so the operator sees jobs that ARE flapping but haven't
-- yet died. This matches the new behaviour the Alerts panel will rely on
-- once the frontend dead-letter query lands.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_drone_dashboard_stats()
RETURNS TABLE (
  shoots_today integer,
  jobs_pending integer,
  jobs_running integer,
  jobs_failed_24h integer,
  sfm_runs_30d integer,
  sfm_success_rate_30d numeric,
  sfm_residual_median_30d numeric,
  renders_today integer,
  estimated_cost_today_usd numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
        -- failed at least once and are scheduled for a backoff retry). The
        -- prior `status='failed'` predicate matched zero rows because the
        -- drone_jobs CHECK never allowed 'failed' as a value. (Dashboard /
        -- Live-progress alert visibility — bug fix.)
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
    tc.render_today_count                                          AS renders_today,
    ROUND(
      (tc.sfm_today_count    * 0.005)
      + (tc.render_today_count * 0.020)
      + (tc.poi_today_count    * 0.032)
    , 3)                                                           AS estimated_cost_today_usd
  FROM today_counts tc, sfm_window sw;
$function$;

CREATE OR REPLACE FUNCTION public.get_drone_shoot_live_progress(p_shoot_ids uuid[])
RETURNS TABLE (
  shoot_id uuid,
  shots_total integer,
  shots_with_pose integer,
  shots_rendered integer,
  jobs_pending integer,
  jobs_running integer,
  jobs_failed_24h integer,
  sfm_images_registered integer,
  sfm_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH
    inputs AS (
      SELECT DISTINCT unnest(p_shoot_ids) AS sid
    ),
    shot_counts AS (
      SELECT
        s.shoot_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE s.sfm_pose IS NOT NULL)::int AS with_pose
      FROM drone_shots s
      WHERE s.shoot_id = ANY(p_shoot_ids)
      GROUP BY s.shoot_id
    ),
    render_counts AS (
      SELECT
        s.shoot_id,
        COUNT(DISTINCT r.shot_id)::int AS rendered
      FROM drone_renders r
      JOIN drone_shots s ON s.id = r.shot_id
      WHERE s.shoot_id = ANY(p_shoot_ids)
        AND r.column_state IN ('proposed', 'adjustments', 'final')
      GROUP BY s.shoot_id
    ),
    job_counts AS (
      SELECT
        shoot_id,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        -- Same fix as get_drone_dashboard_stats: count dead_letter + in-
        -- recovery (pending with attempt_count > 1).
        COUNT(*) FILTER (
          WHERE (
            status = 'dead_letter'
            OR (status = 'pending' AND attempt_count > 1)
          )
            AND COALESCE(finished_at, created_at) > NOW() - INTERVAL '24 hours'
        )::int AS failed_24h
      FROM drone_jobs
      WHERE shoot_id = ANY(p_shoot_ids)
      GROUP BY shoot_id
    ),
    sfm_latest AS (
      SELECT DISTINCT ON (shoot_id)
        shoot_id, images_registered, status
      FROM drone_sfm_runs
      WHERE shoot_id = ANY(p_shoot_ids)
      ORDER BY shoot_id, started_at DESC NULLS LAST
    )
  SELECT
    i.sid                       AS shoot_id,
    COALESCE(sc.total, 0)       AS shots_total,
    COALESCE(sc.with_pose, 0)   AS shots_with_pose,
    COALESCE(rc.rendered, 0)    AS shots_rendered,
    COALESCE(jc.pending, 0)     AS jobs_pending,
    COALESCE(jc.running, 0)     AS jobs_running,
    COALESCE(jc.failed_24h, 0)  AS jobs_failed_24h,
    sl.images_registered        AS sfm_images_registered,
    sl.status                   AS sfm_status
  FROM inputs i
  LEFT JOIN shot_counts   sc ON sc.shoot_id = i.sid
  LEFT JOIN render_counts rc ON rc.shoot_id = i.sid
  LEFT JOIN job_counts    jc ON jc.shoot_id = i.sid
  LEFT JOIN sfm_latest    sl ON sl.shoot_id = i.sid;
$function$;

NOTIFY pgrst, 'reload schema';

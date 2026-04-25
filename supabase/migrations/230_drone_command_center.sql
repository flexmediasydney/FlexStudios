-- ═══════════════════════════════════════════════════════════════════════════
-- Drone Phase 7 Stream M: Drone Command Center backend
-- ───────────────────────────────────────────────────────────────────────────
-- Adds:
--   1. drone_events to the supabase_realtime publication (Stream K's
--      migration 229 wired drone_shoots / drone_shots / drone_renders /
--      drone_sfm_runs but NOT drone_events — the activity log on /drones
--      needs it).
--   2. RPC get_drone_dashboard_stats() — single round-trip for the hero
--      stats card row (today's shoots, queue depth, SfM 30d success rate,
--      median residual, estimated cost today).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. drone_events realtime ─────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_events;
  END IF;
END$$;

-- ─── 2. Dashboard stats RPC ───────────────────────────────────────────────
-- Cost approximation per cost model in IMPLEMENTATION_PLAN_V2.md §8:
--   ~ $0.005 per SfM run, ~$0.02 per render, ~$0.032 per POI fetch
-- (Approximated server-side rather than embedding in the UI so the
--  formula is auditable in one place.)
CREATE OR REPLACE FUNCTION get_drone_dashboard_stats()
RETURNS TABLE (
  shoots_today              INT,
  jobs_pending              INT,
  jobs_running              INT,
  jobs_failed_24h           INT,
  sfm_runs_30d              INT,
  sfm_success_rate_30d      NUMERIC,
  sfm_residual_median_30d   NUMERIC,
  renders_today             INT,
  estimated_cost_today_usd  NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
    today_start AS (
      -- Sydney-day boundary; matches pulse engine's tz convention.
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
        (SELECT COUNT(*) FROM drone_jobs
          WHERE status = 'failed'
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
$$;

GRANT EXECUTE ON FUNCTION get_drone_dashboard_stats() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- Drone Command Center: per-shoot live progress
-- ───────────────────────────────────────────────────────────────────────────
-- Adds RPC get_drone_shoot_live_progress(p_shoot_ids uuid[]) so the kanban
-- tiles can show "23/34 rendered · 2 running" instead of just "34 imgs".
--
-- The dashboard's existing get_drone_dashboard_stats() returns *global*
-- counters (queue depth across all shoots) — useful for the hero cards but
-- useless for spotting which shoot is actually progressing or stuck.
--
-- One round-trip, one row per requested shoot, COALESCEd to zero so the UI
-- doesn't have to handle missing keys. Shoots that don't exist still get a
-- row (zeros across the board) so the caller can render a placeholder
-- without a second lookup.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_drone_shoot_live_progress(p_shoot_ids uuid[])
RETURNS TABLE (
  shoot_id              uuid,
  shots_total           int,
  shots_with_pose       int,
  shots_rendered        int,
  jobs_pending          int,
  jobs_running          int,
  jobs_failed_24h       int,
  sfm_images_registered int,
  sfm_status            text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
    inputs AS (
      SELECT DISTINCT unnest(p_shoot_ids) AS sid
    ),
    shot_counts AS (
      SELECT
        s.shoot_id,
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (WHERE s.sfm_pose IS NOT NULL)::int    AS with_pose
      FROM drone_shots s
      WHERE s.shoot_id = ANY(p_shoot_ids)
      GROUP BY s.shoot_id
    ),
    render_counts AS (
      -- A shot is "rendered" if it has at least one render row in an active
      -- column state (proposed / adjustments / final). Archived rows don't
      -- count — the operator wouldn't see them in the swimlane.
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
        COUNT(*) FILTER (WHERE status = 'pending')::int                AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int                AS running,
        COUNT(*) FILTER (
          WHERE status = 'failed'
            AND COALESCE(finished_at, created_at) > NOW() - INTERVAL '24 hours'
        )::int                                                         AS failed_24h
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
    i.sid                                  AS shoot_id,
    COALESCE(sc.total, 0)                  AS shots_total,
    COALESCE(sc.with_pose, 0)              AS shots_with_pose,
    COALESCE(rc.rendered, 0)               AS shots_rendered,
    COALESCE(jc.pending, 0)                AS jobs_pending,
    COALESCE(jc.running, 0)                AS jobs_running,
    COALESCE(jc.failed_24h, 0)             AS jobs_failed_24h,
    sl.images_registered                   AS sfm_images_registered,
    sl.status                              AS sfm_status
  FROM inputs i
  LEFT JOIN shot_counts   sc ON sc.shoot_id = i.sid
  LEFT JOIN render_counts rc ON rc.shoot_id = i.sid
  LEFT JOIN job_counts    jc ON jc.shoot_id = i.sid
  LEFT JOIN sfm_latest    sl ON sl.shoot_id = i.sid;
$$;

GRANT EXECUTE ON FUNCTION get_drone_shoot_live_progress(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

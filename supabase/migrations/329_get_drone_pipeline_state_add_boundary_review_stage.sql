-- ============================================================================
-- Migration 329 — get_drone_pipeline_state: add boundary_review stage
-- Wave 14 Stream 1: operator visibility / unblock-the-pipeline
-- ============================================================================
--
-- Why
-- ----
-- The drone pipeline auto-fetches a cadastral polygon during the `cadastral`
-- stage but does NOT persist it into drone_property_boundary on its own. The
-- operator must open DroneBoundaryEditor and click Save to fire
-- drone-boundary-save and enqueue boundary_save_render_cascade — that single
-- act is what populates drone_property_boundary, which is the geographic
-- filter the renderer uses to decide which pins to draw.
--
-- Until today the boundary save was an invisible step buried inside the
-- DroneEditsSubtab — and you can't reach the edited pipeline without first
-- triaging raws, which themselves render meaningfully only after a boundary
-- exists. Chicken-and-egg.
--
-- Fix
-- ---
-- Make the boundary save a first-class pipeline stage so the operator can SEE
-- that it is the next blocking step. The new stage `boundary_review` is
-- inserted between `cadastral` (idx 3) and `operator_triage` (now idx 6,
-- bumped from 5). Visual indices for the rest of the pipeline shift by +1.
--
-- Stage status logic (server-authoritative):
--   • drone_property_boundary EXISTS for the project        → 'completed'
--   • cadastral stage status='completed' (no boundary saved) → 'ready'
--   • cadastral pending/running/failed/not started yet      → 'pending'
--
-- The unlock gate is also tightened: operator_actions_unlocked now requires
-- drone_property_boundary to exist. Without that row the renderer cannot
-- produce a property-scoped overlay, so unlocking the swimlane would just let
-- the operator lock-shortlist into a broken downstream.
--
-- Return type stays jsonb → CREATE OR REPLACE FUNCTION is safe (Postgres
-- forbids changing return type, but jsonb output is structural-only).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_drone_pipeline_state(p_project_id uuid, p_shoot_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role           text;
  v_is_service     boolean := false;
  v_shoot          record;
  v_active_jobs    jsonb;
  v_stages         jsonb;
  v_system         jsonb;
  v_avg            jsonb;
  v_unlocked       boolean := false;
  v_current_stage  text := NULL;
  v_dispatcher     record;
  v_health         text;
  v_secs_since     numeric;
  v_debounce_left  numeric := 0;
  v_blocked_count  integer := 0;
  v_shoots_summary jsonb;
  v_has_boundary   boolean := false;
BEGIN
  v_is_service := current_setting('request.jwt.claims', true) IS NULL
                  OR (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'service_role';

  IF NOT v_is_service THEN
    v_role := public.get_user_role();
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'forbidden: no role';
    END IF;

    IF v_role NOT IN ('master_admin','admin','manager','employee') THEN
      IF v_role = 'contractor' THEN
        IF NOT (p_project_id IN (SELECT public.my_project_ids())) THEN
          RAISE EXCEPTION 'forbidden: contractor lacks project access';
        END IF;
      ELSE
        RAISE EXCEPTION 'forbidden: role % not allowed', v_role;
      END IF;
    END IF;
  END IF;

  WITH avg_secs AS (
    SELECT
      kind,
      AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))::numeric AS secs
    FROM public.drone_jobs
    WHERE finished_at IS NOT NULL
      AND started_at  IS NOT NULL
      AND status = 'succeeded'
      AND created_at > NOW() - interval '24 hours'
    GROUP BY kind
  )
  SELECT jsonb_build_object(
    'ingest',             COALESCE((SELECT secs FROM avg_secs WHERE kind='ingest'),               60),
    'sfm',                COALESCE((SELECT secs FROM avg_secs WHERE kind='sfm'),                 180),
    'poi',                COALESCE((SELECT secs FROM avg_secs WHERE kind='poi_fetch'),            30),
    'cadastral',          COALESCE((SELECT secs FROM avg_secs WHERE kind='cadastral_fetch'),      15),
    'raw_preview_render', COALESCE((SELECT secs FROM avg_secs WHERE kind='raw_preview_render'),  120),
    'render_edited',      COALESCE((SELECT secs FROM avg_secs WHERE kind='render_edited'),        90),
    'render',             COALESCE((SELECT secs FROM avg_secs WHERE kind='render'),               90)
  ) INTO v_avg;

  SELECT jrd.end_time, jrd.status, jrd.return_message
    INTO v_dispatcher
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
   WHERE j.jobname = 'drone-job-dispatcher'
   ORDER BY jrd.end_time DESC NULLS LAST
   LIMIT 1;

  IF v_dispatcher.end_time IS NULL THEN
    v_health := 'down';
  ELSE
    v_secs_since := EXTRACT(EPOCH FROM (NOW() - v_dispatcher.end_time));
    IF v_secs_since <= 180 THEN
      v_health := 'ok';
    ELSIF v_secs_since <= 900 THEN
      v_health := 'stale';
    ELSE
      v_health := 'down';
    END IF;
  END IF;

  IF p_shoot_id IS NULL THEN
    WITH base_shoots AS (
      SELECT s.id, s.status, s.flight_started_at
        FROM public.drone_shoots s
       WHERE s.project_id = p_project_id
    ),
    shoot_active AS (
      SELECT
        bs.id AS shoot_id,
        bs.status,
        COUNT(j.id) FILTER (WHERE j.status IN ('pending','running')) AS active_count,
        COUNT(j.id) FILTER (WHERE j.status = 'dead_letter')          AS dead_count
      FROM base_shoots bs
      LEFT JOIN public.drone_jobs j
        ON j.shoot_id = bs.id
       AND j.created_at > NOW() - interval '24 hours'
      GROUP BY bs.id, bs.status
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'shoot_id',     sa.shoot_id,
          'shoot_status', sa.status,
          'active_count', sa.active_count,
          'dead_count',   sa.dead_count
        ) ORDER BY sa.active_count DESC, sa.shoot_id
      ),
      '[]'::jsonb
    ) INTO v_shoots_summary
    FROM shoot_active sa;

    SELECT jsonb_agg(
      jsonb_build_object(
        'job_id',        j.id,
        'kind',          j.kind,
        'status',        j.status,
        'shoot_id',      j.shoot_id,
        'scheduled_for', j.scheduled_for,
        'started_at',    j.started_at,
        'attempt_count', j.attempt_count,
        'error_message', j.error_message
      ) ORDER BY
        CASE j.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        j.scheduled_for
    ) INTO v_active_jobs
      FROM public.drone_jobs j
     WHERE j.project_id = p_project_id
       AND j.status IN ('pending','running')
     LIMIT 100;

    v_system := jsonb_build_object(
      'dispatcher_last_tick_at',         v_dispatcher.end_time,
      'dispatcher_health',               v_health,
      'debounce_window_remaining_sec',   0
    );

    RETURN jsonb_build_object(
      'project_id',                  p_project_id,
      'shoot_id',                    NULL,
      'shoot_status',                NULL,
      'operator_actions_unlocked',   FALSE,
      'current_stage',               NULL,
      'stages',                      '[]'::jsonb,
      'active_jobs',                 COALESCE(v_active_jobs, '[]'::jsonb),
      'shoots',                      COALESCE(v_shoots_summary, '[]'::jsonb),
      'system',                      v_system,
      'stage_avg_seconds',           v_avg,
      'generated_at',                NOW()
    );
  END IF;

  SELECT id, project_id, status, flight_started_at, flight_ended_at
    INTO v_shoot
    FROM public.drone_shoots
   WHERE id = p_shoot_id
     AND project_id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shoot % not found in project %', p_shoot_id, p_project_id;
  END IF;

  -- W14 S1: project-scoped boundary lookup. drone_property_boundary has no
  -- shoot_id column — boundary is one-per-project (cadastral parcel of the
  -- listing). Existence is the gate.
  SELECT EXISTS (
    SELECT 1 FROM public.drone_property_boundary
     WHERE project_id = p_project_id
  ) INTO v_has_boundary;

  SELECT jsonb_agg(
    jsonb_build_object(
      'job_id',        j.id,
      'kind',          j.kind,
      'status',        j.status,
      'pipeline',      j.pipeline,
      'scheduled_for', j.scheduled_for,
      'started_at',    j.started_at,
      'finished_at',   j.finished_at,
      'attempt_count', j.attempt_count,
      'error_message', j.error_message,
      'payload',       j.payload
    ) ORDER BY
      CASE j.status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'failed' THEN 2 WHEN 'dead_letter' THEN 3 ELSE 4 END,
      j.scheduled_for
  ) INTO v_active_jobs
    FROM public.drone_jobs j
   WHERE j.shoot_id = p_shoot_id
     AND j.created_at > NOW() - interval '24 hours'
   LIMIT 50;

  SELECT GREATEST(0, EXTRACT(EPOCH FROM (j.scheduled_for - NOW())))::numeric
    INTO v_debounce_left
    FROM public.drone_jobs j
   WHERE j.project_id = p_project_id
     AND j.kind = 'ingest'
     AND j.status = 'pending'
   ORDER BY j.scheduled_for DESC
   LIMIT 1;
  v_debounce_left := COALESCE(v_debounce_left, 0);

  WITH job_latest AS (
    SELECT DISTINCT ON (j.kind)
      j.id,
      j.kind,
      j.status,
      j.started_at,
      j.finished_at,
      j.scheduled_for,
      j.attempt_count,
      j.error_message,
      j.payload
    FROM public.drone_jobs j
    WHERE (j.shoot_id = p_shoot_id OR (j.shoot_id IS NULL AND j.project_id = p_project_id))
      AND j.kind IN ('ingest','sfm','poi_fetch','cadastral_fetch','raw_preview_render','render','render_edited','boundary_save_render_cascade')
    ORDER BY j.kind, j.created_at DESC
  ),
  edited_pick AS (
    SELECT * FROM job_latest WHERE kind IN ('render_edited','boundary_save_render_cascade')
    ORDER BY GREATEST(
      COALESCE(scheduled_for, '1970-01-01'::timestamptz),
      COALESCE(started_at,    '1970-01-01'::timestamptz),
      COALESCE(finished_at,   '1970-01-01'::timestamptz)
    ) DESC
    LIMIT 1
  ),
  stage_rows AS (
    SELECT 0 AS idx, 'ingest' AS stage_key, 'drone-ingest' AS function_name,
           (SELECT id FROM job_latest WHERE kind='ingest') AS job_id,
           (SELECT status FROM job_latest WHERE kind='ingest') AS job_status,
           (SELECT started_at FROM job_latest WHERE kind='ingest') AS started_at,
           (SELECT finished_at FROM job_latest WHERE kind='ingest') AS finished_at,
           (SELECT scheduled_for FROM job_latest WHERE kind='ingest') AS scheduled_for,
           (SELECT attempt_count FROM job_latest WHERE kind='ingest') AS attempt_count,
           (SELECT error_message FROM job_latest WHERE kind='ingest') AS error_message,
           (SELECT payload FROM job_latest WHERE kind='ingest') AS payload,
           ((v_avg ->> 'ingest')::numeric) AS avg_secs
    UNION ALL
    SELECT 1, 'sfm', 'drone-sfm',
           (SELECT id FROM job_latest WHERE kind='sfm'),
           (SELECT status FROM job_latest WHERE kind='sfm'),
           (SELECT started_at FROM job_latest WHERE kind='sfm'),
           (SELECT finished_at FROM job_latest WHERE kind='sfm'),
           (SELECT scheduled_for FROM job_latest WHERE kind='sfm'),
           (SELECT attempt_count FROM job_latest WHERE kind='sfm'),
           (SELECT error_message FROM job_latest WHERE kind='sfm'),
           (SELECT payload FROM job_latest WHERE kind='sfm'),
           ((v_avg ->> 'sfm')::numeric)
    UNION ALL
    SELECT 2, 'poi', 'drone-pois',
           (SELECT id FROM job_latest WHERE kind='poi_fetch'),
           (SELECT status FROM job_latest WHERE kind='poi_fetch'),
           (SELECT started_at FROM job_latest WHERE kind='poi_fetch'),
           (SELECT finished_at FROM job_latest WHERE kind='poi_fetch'),
           (SELECT scheduled_for FROM job_latest WHERE kind='poi_fetch'),
           (SELECT attempt_count FROM job_latest WHERE kind='poi_fetch'),
           (SELECT error_message FROM job_latest WHERE kind='poi_fetch'),
           (SELECT payload FROM job_latest WHERE kind='poi_fetch'),
           ((v_avg ->> 'poi')::numeric)
    UNION ALL
    SELECT 3, 'cadastral', 'drone-cadastral',
           (SELECT id FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT status FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT started_at FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT finished_at FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT scheduled_for FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT attempt_count FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT error_message FROM job_latest WHERE kind='cadastral_fetch'),
           (SELECT payload FROM job_latest WHERE kind='cadastral_fetch'),
           ((v_avg ->> 'cadastral')::numeric)
    UNION ALL
    SELECT 4, 'raw_render', 'drone-raw-preview',
           (SELECT id FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT status FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT started_at FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT finished_at FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT scheduled_for FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT attempt_count FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT error_message FROM job_latest WHERE kind='raw_preview_render'),
           (SELECT payload FROM job_latest WHERE kind='raw_preview_render'),
           ((v_avg ->> 'raw_preview_render')::numeric)
    UNION ALL
    -- W14 S1 NEW: boundary_review at idx 5. No backing drone_jobs row — the
    -- "job" here is the operator's act of saving the boundary in
    -- DroneBoundaryEditor (which then enqueues boundary_save_render_cascade,
    -- which surfaces in the edited_render row downstream). function_name is
    -- NULL because no Edge Function executes this stage automatically.
    SELECT 5, 'boundary_review', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0::numeric
    UNION ALL
    SELECT 6, 'operator_triage', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0::numeric
    UNION ALL
    SELECT 7, 'editor_handoff', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0::numeric
    UNION ALL
    SELECT 8, 'edited_render', 'drone-render-edited',
           (SELECT id FROM edited_pick),
           (SELECT status FROM edited_pick),
           (SELECT started_at FROM edited_pick),
           (SELECT finished_at FROM edited_pick),
           (SELECT scheduled_for FROM edited_pick),
           (SELECT attempt_count FROM edited_pick),
           (SELECT error_message FROM edited_pick),
           (SELECT payload FROM edited_pick),
           ((v_avg ->> 'render_edited')::numeric)
    UNION ALL
    SELECT 9, 'edited_curate', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0::numeric
    UNION ALL
    SELECT 10, 'final', 'drone-render',
           (SELECT id FROM job_latest WHERE kind='render'),
           (SELECT status FROM job_latest WHERE kind='render'),
           (SELECT started_at FROM job_latest WHERE kind='render'),
           (SELECT finished_at FROM job_latest WHERE kind='render'),
           (SELECT scheduled_for FROM job_latest WHERE kind='render'),
           (SELECT attempt_count FROM job_latest WHERE kind='render'),
           (SELECT error_message FROM job_latest WHERE kind='render'),
           (SELECT payload FROM job_latest WHERE kind='render'),
           ((v_avg ->> 'render')::numeric)
    UNION ALL
    SELECT 11, 'delivered', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0::numeric
  ),
  -- W14 S1: precompute the cadastral row's resolved status (mirrors the
  -- generic job-status cascade below) so boundary_review can use it without
  -- duplicating the logic.
  cadastral_status AS (
    SELECT CASE
             WHEN (SELECT job_status FROM stage_rows WHERE stage_key='cadastral') IS NULL THEN 'pending'
             WHEN (SELECT job_status FROM stage_rows WHERE stage_key='cadastral') = 'succeeded' THEN 'completed'
             ELSE (SELECT job_status FROM stage_rows WHERE stage_key='cadastral')
           END AS status
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'index',                  sr.idx,
      'stage_key',              sr.stage_key,
      'function_name',          sr.function_name,
      'status',                 CASE
                                  WHEN sr.stage_key = 'boundary_review' THEN
                                    CASE
                                      WHEN v_has_boundary THEN 'completed'
                                      WHEN (SELECT status FROM cadastral_status) = 'completed' THEN 'ready'
                                      ELSE 'pending'
                                    END
                                  WHEN sr.stage_key = 'operator_triage' THEN
                                    CASE
                                      WHEN v_shoot.status = 'proposed_ready'    THEN 'ready'
                                      WHEN v_shoot.status IN ('adjustments_ready','final_ready','delivered') THEN 'completed'
                                      ELSE 'pending'
                                    END
                                  WHEN sr.stage_key = 'editor_handoff' THEN
                                    CASE
                                      WHEN v_shoot.status IN ('adjustments_ready','final_ready','delivered') THEN 'completed'
                                      WHEN v_shoot.status = 'proposed_ready' THEN 'ready'
                                      ELSE 'pending'
                                    END
                                  WHEN sr.stage_key = 'edited_curate' THEN
                                    CASE
                                      WHEN v_shoot.status IN ('final_ready','delivered') THEN 'completed'
                                      WHEN v_shoot.status = 'adjustments_ready' THEN 'ready'
                                      ELSE 'pending'
                                    END
                                  WHEN sr.stage_key = 'delivered' THEN
                                    CASE WHEN v_shoot.status = 'delivered' THEN 'completed' ELSE 'pending' END
                                  WHEN sr.job_status IS NULL THEN 'pending'
                                  WHEN sr.job_status = 'succeeded' THEN 'completed'
                                  WHEN sr.job_status = 'running'   THEN 'running'
                                  WHEN sr.job_status = 'pending'   THEN
                                    CASE WHEN sr.scheduled_for > NOW() THEN 'debouncing' ELSE 'queued' END
                                  WHEN sr.job_status = 'failed'    THEN 'failed'
                                  WHEN sr.job_status = 'dead_letter' THEN 'dead_letter'
                                  ELSE sr.job_status
                                END,
      'started_at',             sr.started_at,
      'completed_at',           sr.finished_at,
      'eta_seconds_remaining',  CASE
                                  WHEN sr.job_status = 'running' AND sr.started_at IS NOT NULL AND sr.avg_secs > 0
                                    THEN GREATEST(0, sr.avg_secs - EXTRACT(EPOCH FROM (NOW() - sr.started_at)))
                                  WHEN sr.job_status = 'pending' AND sr.scheduled_for IS NOT NULL AND sr.scheduled_for > NOW()
                                    THEN EXTRACT(EPOCH FROM (sr.scheduled_for - NOW()))
                                  ELSE NULL
                                END,
      'active_job_id',          sr.job_id,
      'active_job_payload',     sr.payload,
      'error_message',          sr.error_message,
      'attempt_count',          sr.attempt_count,
      'scheduled_for',          sr.scheduled_for,
      'debounced_until',        CASE WHEN sr.scheduled_for > NOW() THEN sr.scheduled_for ELSE NULL END
    ) ORDER BY sr.idx
  )
  INTO v_stages
  FROM stage_rows sr;

  SELECT s ->> 'stage_key' INTO v_current_stage
    FROM jsonb_array_elements(v_stages) s
   WHERE s ->> 'status' IN ('running','queued','debouncing','failed','dead_letter','ready')
   ORDER BY (s ->> 'index')::int
   LIMIT 1;

  IF v_current_stage IS NULL THEN
    SELECT s ->> 'stage_key' INTO v_current_stage
      FROM jsonb_array_elements(v_stages) s
     WHERE s ->> 'status' = 'completed'
     ORDER BY (s ->> 'index')::int DESC
     LIMIT 1;
  END IF;

  SELECT COUNT(*) INTO v_blocked_count
    FROM public.drone_jobs
   WHERE shoot_id = p_shoot_id
     AND status IN ('pending','running')
     AND kind IN ('ingest','sfm','poi_fetch','cadastral_fetch','raw_preview_render');

  -- W14 S1: tighten the gate. Without drone_property_boundary the renderer
  -- has no geographic filter, so unlocking operator actions would let the
  -- swimlane lock-shortlist into a downstream that produces empty pin
  -- overlays. Require the boundary row to exist before unlocking.
  v_unlocked := v_shoot.status IN ('proposed_ready','adjustments_ready','final_ready','delivered')
                AND v_blocked_count = 0
                AND v_has_boundary;

  v_system := jsonb_build_object(
    'dispatcher_last_tick_at',       v_dispatcher.end_time,
    'dispatcher_health',             v_health,
    'dispatcher_secs_since_tick',    v_secs_since,
    'dispatcher_last_status',        v_dispatcher.status,
    'debounce_window_remaining_sec', v_debounce_left
  );

  RETURN jsonb_build_object(
    'project_id',                p_project_id,
    'shoot_id',                  p_shoot_id,
    'shoot_status',              v_shoot.status,
    'operator_actions_unlocked', v_unlocked,
    'current_stage',             v_current_stage,
    'stages',                    COALESCE(v_stages, '[]'::jsonb),
    'active_jobs',               COALESCE(v_active_jobs, '[]'::jsonb),
    'system',                    v_system,
    'stage_avg_seconds',         v_avg,
    'generated_at',              NOW()
  );
END;
$function$;

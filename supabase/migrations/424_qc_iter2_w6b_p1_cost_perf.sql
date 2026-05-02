-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 424 — QC iter 2 Wave 6b: P1 cost + perf cleanup
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three findings landed here:
--
--   F-E-008: pulse_command_center_kpis + shortlisting_command_center_kpis
--            were each ~111ms / 8265 buffer hits per call, polled every 30s
--            from the frontend. With a single user open: 2,880 RPC calls/day
--            per dashboard ≈ 320 sec/day Postgres CPU per dashboard. Replace
--            the hot path with materialised views refreshed every 5 min via
--            pg_cron — the frontend reads the MV via a thin scalar fetch
--            (~1-5ms) instead of recomputing the full 7-day aggregate every
--            poll. Original RPCs remain callable for ad-hoc / one-off calls.
--
--   F-E-003: shortlisting-job-dispatcher cron drops from `* * * * *`
--            (every minute) to `*/2 * * * *`. 8,455 invocations / 7d only
--            yielded 55 dispatched jobs (99.3% empty cycles). Halving the
--            cadence cuts pg_cron + edge-fn invocations and the empty
--            stale-claim sweeps that come with them. Worst-case P95 latency
--            for a freshly-enqueued job ticks up from ~60s to ~120s — well
--            inside any user-visible threshold for the shortlisting pipeline.
--
-- F-E-009 (pulseDetailEnrich BATCH_SIZE 12 → 6) is an edge-function code
-- change in the same wave; no SQL needed here.
--
-- Migration is idempotent: each MV / RPC / cron block uses CREATE OR REPLACE
-- or DROP-IF-EXISTS sequences so re-applying is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- F-E-008 PART 1 — pulse_command_center_kpis materialised view
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The MV is a single row with two columns: computed_at + kpis. The unique
-- index on `(true)` is the canonical single-row pin pattern — required so
-- REFRESH MATERIALIZED VIEW CONCURRENTLY can run without blocking readers.
--
-- Drop-and-recreate (rather than CREATE IF NOT EXISTS) so the SELECT picks up
-- the latest function shape on every migration apply.

DROP MATERIALIZED VIEW IF EXISTS public.pulse_command_center_kpis_mv;

CREATE MATERIALIZED VIEW public.pulse_command_center_kpis_mv AS
  SELECT
    now()                              AS computed_at,
    public.pulse_command_center_kpis(7) AS kpis;

CREATE UNIQUE INDEX idx_pulse_kpis_mv_pin
  ON public.pulse_command_center_kpis_mv ((true));

GRANT SELECT ON public.pulse_command_center_kpis_mv TO authenticated;

COMMENT ON MATERIALIZED VIEW public.pulse_command_center_kpis_mv IS
  'QC-iter2 W6b (F-E-008): cached snapshot of pulse_command_center_kpis(7). '
  'Refreshed every 5 min via pg_cron job pulse_kpis_mv_refresh. Read via '
  'pulse_command_center_kpis_cached() for ~1-5ms fetches instead of recomputing '
  'the full 7-day aggregate (~111ms / 8265 buffer hits) on every 30s poll.';

-- ═══════════════════════════════════════════════════════════════════════════
-- F-E-008 PART 2 — shortlisting_command_center_kpis materialised view
-- ═══════════════════════════════════════════════════════════════════════════

DROP MATERIALIZED VIEW IF EXISTS public.shortlisting_command_center_kpis_mv;

CREATE MATERIALIZED VIEW public.shortlisting_command_center_kpis_mv AS
  SELECT
    now()                                        AS computed_at,
    public.shortlisting_command_center_kpis(7)   AS kpis;

CREATE UNIQUE INDEX idx_shortlisting_kpis_mv_pin
  ON public.shortlisting_command_center_kpis_mv ((true));

GRANT SELECT ON public.shortlisting_command_center_kpis_mv TO authenticated;

COMMENT ON MATERIALIZED VIEW public.shortlisting_command_center_kpis_mv IS
  'QC-iter2 W6b (F-E-008): cached snapshot of shortlisting_command_center_kpis(7). '
  'Refreshed every 5 min via pg_cron job shortlisting_kpis_mv_refresh. Read via '
  'shortlisting_command_center_kpis_cached() for ~1-5ms fetches instead of '
  'recomputing on every 60s OverviewTab poll.';

-- ═══════════════════════════════════════════════════════════════════════════
-- F-E-008 PART 3 — Cached-read RPCs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The frontend switches from the heavy RPCs to these thin reads. The original
-- RPCs remain callable for ad-hoc / refresh / first-render-after-cold-deploy
-- scenarios.

CREATE OR REPLACE FUNCTION public.pulse_command_center_kpis_cached()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT kpis FROM public.pulse_command_center_kpis_mv LIMIT 1;
$$;

COMMENT ON FUNCTION public.pulse_command_center_kpis_cached() IS
  'QC-iter2 W6b (F-E-008): thin read of pulse_command_center_kpis_mv. '
  'Returns the most recent 5-min snapshot of the Pulse Missed-Opportunity '
  'Command Center KPIs. Use this for polled reads; call '
  'pulse_command_center_kpis(int) directly only for ad-hoc / on-demand needs.';

GRANT EXECUTE ON FUNCTION public.pulse_command_center_kpis_cached()
  TO authenticated;

CREATE OR REPLACE FUNCTION public.shortlisting_command_center_kpis_cached()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT kpis FROM public.shortlisting_command_center_kpis_mv LIMIT 1;
$$;

COMMENT ON FUNCTION public.shortlisting_command_center_kpis_cached() IS
  'QC-iter2 W6b (F-E-008): thin read of shortlisting_command_center_kpis_mv. '
  'Returns the most recent 5-min snapshot of the Shortlisting Command Center '
  'KPIs. Use this for polled reads; call shortlisting_command_center_kpis(int) '
  'directly only for ad-hoc / on-demand needs.';

GRANT EXECUTE ON FUNCTION public.shortlisting_command_center_kpis_cached()
  TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- F-E-008 PART 4 — pg_cron MV refresh schedules (every 5 min)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CONCURRENTLY requires a UNIQUE INDEX (created above). Without it the
-- REFRESH would block readers for the duration of the rebuild. With a
-- one-row MV the rebuild is sub-second, but CONCURRENTLY still wins because
-- it never holds an ACCESS EXCLUSIVE lock that would queue all readers.
--
-- The `WHERE EXISTS` guard makes cron.unschedule idempotent — first apply
-- has nothing to drop; re-apply drops the prior schedule cleanly.

DO $$
BEGIN
  PERFORM cron.unschedule('pulse_kpis_mv_refresh')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse_kpis_mv_refresh');

  PERFORM cron.schedule(
    'pulse_kpis_mv_refresh',
    '*/5 * * * *',
    $job$REFRESH MATERIALIZED VIEW CONCURRENTLY public.pulse_command_center_kpis_mv$job$
  );
END$$;

DO $$
BEGIN
  PERFORM cron.unschedule('shortlisting_kpis_mv_refresh')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_kpis_mv_refresh'
    );

  PERFORM cron.schedule(
    'shortlisting_kpis_mv_refresh',
    '*/5 * * * *',
    $job$REFRESH MATERIALIZED VIEW CONCURRENTLY public.shortlisting_command_center_kpis_mv$job$
  );
END$$;

-- Initial population — without this, the first 5 min after migration apply
-- have an empty MV and the cached RPC returns NULL. Synchronous so the
-- migration only completes once readers have valid data.
REFRESH MATERIALIZED VIEW public.pulse_command_center_kpis_mv;
REFRESH MATERIALIZED VIEW public.shortlisting_command_center_kpis_mv;

-- ═══════════════════════════════════════════════════════════════════════════
-- F-E-003 — Drop dispatcher cron from `* * * * *` to `*/2 * * * *`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Telemetry: 8,455 invocations / 7d, only 55 dispatched jobs (99.3% empty).
-- Halving the cadence keeps the same effective P95 latency budget for a
-- freshly-enqueued job (~120s vs ~60s previously) while cutting cron +
-- empty stale-claim-sweep overhead in half. Mirrors the mig 292 pattern —
-- vault SELECT lives inside the cron command body so JWT rotations are
-- picked up at every tick (no migration needed when the secret rotates).

DO $$
BEGIN
  -- Sanity: vault must hold the JWT (matches mig 292 pattern).
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt'
  ) THEN
    RAISE EXCEPTION 'pulse_cron_jwt missing from vault — required for shortlisting-job-dispatcher cron';
  END IF;

  -- Idempotent unschedule.
  PERFORM cron.unschedule('shortlisting-job-dispatcher')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'shortlisting-job-dispatcher'
    );

  -- Re-schedule at */2 cadence. Body is unchanged from mig 292.
  PERFORM cron.schedule(
    'shortlisting-job-dispatcher',
    '*/2 * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/shortlisting-job-dispatcher',
        headers := jsonb_build_object(
          'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
          'Content-Type',     'application/json',
          'x-caller-context', 'cron:shortlisting-job-dispatcher'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 145000
      );
    $job$
  );
END$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

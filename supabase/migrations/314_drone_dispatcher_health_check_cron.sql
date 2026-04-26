-- ═══════════════════════════════════════════════════════════════════════════
-- Wave 11 S3 (Cluster E): mig 314 — Dispatcher health watchdog
-- ───────────────────────────────────────────────────────────────────────────
-- Cron job runs every 5 min, checks cron.job_run_details for the dispatcher's
-- last successful tick. If >5 min ago, raises an alert through the
-- notifications system (master_admin recipient).
--
-- Pieces:
--   1. drone_dispatcher_health_alerts — outbox table, one row per unhealthy stretch
--   2. check_drone_dispatcher_health() — RPC that inspects cron.job_run_details
--      and inserts an outbox row when health <> 'ok' (deduped per stretch).
--   3. cron schedule 'drone-dispatcher-watchdog' (*/5 * * * *) — calls the
--      drone-dispatcher-watchdog Edge Fn which runs the RPC + drains outbox.
--   4. notification_routing_rules seed for 'drone_dispatcher_unhealthy' →
--      master_admin.
--
-- Health states:
--   ok            — last successful tick ≤ 5 min ago
--   stale         — last successful tick 5–15 min ago
--   down          — last successful tick > 15 min ago
--   never_succeeded — no successful tick ever recorded
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Outbox table
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS drone_dispatcher_health_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  health_state TEXT NOT NULL,
  secs_since_last_tick NUMERIC,
  last_tick_at TIMESTAMPTZ,
  last_tick_status TEXT,
  last_tick_msg TEXT,
  processed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

COMMENT ON TABLE drone_dispatcher_health_alerts IS
  'Wave 11 S3: outbox of unhealthy dispatcher stretches. check_drone_dispatcher_health() inserts a row when the cron has missed >5min ticks. drone-dispatcher-watchdog Edge Fn drains, fans out via fireNotif, marks processed=true.';

CREATE INDEX IF NOT EXISTS idx_dispatcher_health_alerts_unprocessed
  ON drone_dispatcher_health_alerts(created_at) WHERE processed = false;

-- RLS: master_admin / admin read; only the SECDEF RPC writes.
ALTER TABLE drone_dispatcher_health_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "drone_dispatcher_health_alerts_select_admin" ON drone_dispatcher_health_alerts;
CREATE POLICY "drone_dispatcher_health_alerts_select_admin"
  ON drone_dispatcher_health_alerts FOR SELECT
  USING (get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text]));

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Health check RPC
-- ───────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.check_drone_dispatcher_health()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp, cron
AS $$
DECLARE
  v_last_success cron.job_run_details%ROWTYPE;
  v_secs_since   numeric;
  v_alerted      boolean := false;
  v_health       text;
BEGIN
  SELECT jrd.* INTO v_last_success
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
   WHERE j.jobname = 'drone-job-dispatcher'
     AND jrd.status = 'succeeded'
   ORDER BY jrd.end_time DESC NULLS LAST
   LIMIT 1;

  IF v_last_success.end_time IS NULL THEN
    v_secs_since := NULL;
    v_health := 'never_succeeded';
  ELSE
    v_secs_since := EXTRACT(EPOCH FROM (NOW() - v_last_success.end_time));
    v_health := CASE
      WHEN v_secs_since <= 300 THEN 'ok'
      WHEN v_secs_since <= 900 THEN 'stale'
      ELSE 'down'
    END;
  END IF;

  IF v_health <> 'ok' THEN
    -- Dedup: only alert once per stretch of unhealthy state.
    -- A "stretch" is bounded by the more recent of (last successful tick) and
    -- (1 hour ago) — so we re-alert at most once per hour even during a
    -- prolonged outage with no successful ticks at all.
    IF NOT EXISTS (
      SELECT 1 FROM drone_dispatcher_health_alerts
       WHERE created_at > GREATEST(
                NOW() - interval '1 hour',
                COALESCE(v_last_success.end_time, '-infinity'::timestamptz)
              )
    ) THEN
      INSERT INTO drone_dispatcher_health_alerts (
        health_state, secs_since_last_tick, last_tick_at,
        last_tick_status, last_tick_msg
      ) VALUES (
        v_health, v_secs_since, v_last_success.end_time,
        v_last_success.status, v_last_success.return_message
      );
      v_alerted := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'health',                 v_health,
    'secs_since_last_tick',   v_secs_since,
    'last_tick_at',           v_last_success.end_time,
    'last_tick_status',       v_last_success.status,
    'alerted',                v_alerted,
    'checked_at',             NOW()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_drone_dispatcher_health() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_drone_dispatcher_health() TO service_role;

COMMENT ON FUNCTION public.check_drone_dispatcher_health() IS
  'Wave 11 S3: inspects cron.job_run_details for drone-job-dispatcher last successful tick. Returns health (ok|stale|down|never_succeeded). Inserts a drone_dispatcher_health_alerts row (deduped per stretch) when not ok. Called every 5 min by drone-dispatcher-watchdog Edge Fn.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Cron schedule — every 5 min, calls drone-dispatcher-watchdog Edge Fn.
--    JWT resolved from vault (rotation-safe, mirrors mig 251 pattern).
-- ───────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  job_token TEXT;
BEGIN
  SELECT decrypted_secret INTO job_token
    FROM vault.decrypted_secrets
   WHERE name = 'pulse_cron_jwt'
   LIMIT 1;

  IF job_token IS NULL THEN
    RAISE EXCEPTION 'pulse_cron_jwt not found in vault — required for drone-dispatcher-watchdog cron';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drone-dispatcher-watchdog') THEN
    PERFORM cron.unschedule('drone-dispatcher-watchdog');
  END IF;

  PERFORM cron.schedule(
    'drone-dispatcher-watchdog',
    '*/5 * * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/drone-dispatcher-watchdog',
        headers := jsonb_build_object(
          'Authorization', 'Bearer %s',
          'Content-Type', 'application/json',
          'x-caller-context', 'cron:drone-dispatcher-watchdog'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$, job_token)
  );
END
$$;

COMMENT ON EXTENSION pg_cron IS
  'Wave 11 S3: drone-dispatcher-watchdog runs */5 * * * * — calls Edge Fn which runs check_drone_dispatcher_health() RPC and drains the alerts outbox.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Notification routing rule seed
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO notification_routing_rules (
  notification_type,
  recipient_roles,
  recipient_user_ids,
  notes,
  is_active,
  version
)
VALUES (
  'drone_dispatcher_unhealthy',
  ARRAY['master_admin']::TEXT[],
  ARRAY[]::UUID[],
  'Wave 11 S3 seed: dispatcher cron watchdog. Fires when drone-job-dispatcher has not ticked successfully in >5 min.',
  TRUE,
  1
)
ON CONFLICT (notification_type, version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

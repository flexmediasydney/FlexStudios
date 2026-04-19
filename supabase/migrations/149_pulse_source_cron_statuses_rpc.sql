-- 149_pulse_source_cron_statuses_rpc.sql
--
-- Long-term fix for schedule drift:
-- `pulse_source_configs.schedule_cron` was a manually-maintained cache of
-- `cron.job.schedule`. Writers update both via `pulse_update_source_cron`,
-- but any direct ALTER on cron.job (e.g. migration 113 bumped detail-enrich
-- from daily → */15min but only touched cron.job, not the cache) left the
-- cache stale. UI then shows a lie.
--
-- Fix: RPC that joins `pulse_source_configs` with the live `cron.job` state.
-- UI reads from this instead of the cached column → drift becomes impossible
-- by construction. Cached column stays for backward-compat + for the edit
-- path (which still updates it alongside `cron.alter_job`), but it's no
-- longer the source of truth for display.

CREATE OR REPLACE FUNCTION pulse_get_source_cron_statuses()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, cron
AS $$
  SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.source_id), '[]'::jsonb)
  FROM (
    SELECT
      psc.source_id,
      psc.cron_job_name,
      cj.jobid AS cron_job_id,
      cj.schedule AS cron_schedule,        -- live cron.job.schedule (authoritative)
      cj.active AS cron_active,            -- live cron.job.active
      psc.schedule_cron AS cached_schedule_cron,  -- kept for debugging drift
      (psc.schedule_cron IS DISTINCT FROM cj.schedule) AS schedule_drifted,
      (
        SELECT start_time::text
        FROM cron.job_run_details jrd
        WHERE jrd.jobid = cj.jobid
        ORDER BY start_time DESC
        LIMIT 1
      ) AS last_run_start,
      (
        SELECT status
        FROM cron.job_run_details jrd
        WHERE jrd.jobid = cj.jobid
        ORDER BY start_time DESC
        LIMIT 1
      ) AS last_run_status
    FROM pulse_source_configs psc
    LEFT JOIN cron.job cj ON cj.jobname = psc.cron_job_name
  ) r;
$$;

GRANT EXECUTE ON FUNCTION pulse_get_source_cron_statuses() TO authenticated, service_role;

-- One-shot: reconcile the cache for every row so the drift column reads
-- false everywhere at migration time. Future drifts will still show up via
-- the `schedule_drifted` boolean in the RPC response.
UPDATE pulse_source_configs psc
   SET schedule_cron = cj.schedule,
       updated_at = now()
  FROM cron.job cj
 WHERE cj.jobname = psc.cron_job_name
   AND (psc.schedule_cron IS DISTINCT FROM cj.schedule);

-- For configs whose cron_job_name doesn't resolve to a real cron.job
-- (e.g. websift/rea_agents is currently unscheduled), null out the cache
-- so the UI doesn't show a stale historical schedule.
UPDATE pulse_source_configs psc
   SET schedule_cron = NULL,
       updated_at = now()
 WHERE psc.cron_job_name IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM cron.job cj WHERE cj.jobname = psc.cron_job_name)
   AND psc.schedule_cron IS NOT NULL;

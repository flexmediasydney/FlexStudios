-- 125_pulse_update_source_cron.sql
-- DS02: make the Edit Cron dialog in PulseDataSources actually alter
-- the pg_cron schedule, not just the pulse_source_configs row.
--
-- Before this migration:
--   - Editing schedule_cron updated pulse_source_configs only.
--   - The actual cron.job entry retained its old schedule, so the
--     change had no runtime effect until someone manually called
--     cron.alter_job from psql. UI warned users about this with an
--     italic caption, but that's bad UX.
--
-- After:
--   - pulse_source_configs has a new `cron_job_name` column mapping the
--     source_id to the pg_cron jobname (e.g. 'rea_agents' →
--     'pulse-rea-agents'). Existing jobnames are seeded here; future
--     sources must populate this column when added.
--   - New RPC `pulse_update_source_cron(p_source_id, p_schedule_cron)`
--     does both things in one SECURITY DEFINER transaction:
--       1. UPDATE pulse_source_configs SET schedule_cron = ...
--       2. SELECT cron.alter_job(jobid, schedule := ...) if the
--          cron_job_name column is populated AND the row exists in
--          cron.job. Returns a JSON blob the UI uses to toast either
--          "cron.job updated" or "jobname not mapped / not found".
--
-- Why SECURITY DEFINER:
--   pg_cron schema is owned by postgres and not accessible to the
--   anon/authenticated roles. The RPC runs as the migration owner so
--   the app's authenticated user can trigger it via RPC. We guard
--   with an auth.uid() check — anonymous calls are rejected.

BEGIN;

-- ═══ 1. Column + seed ═════════════════════════════════════════════════
ALTER TABLE pulse_source_configs
  ADD COLUMN IF NOT EXISTS cron_job_name TEXT;

COMMENT ON COLUMN pulse_source_configs.cron_job_name IS
  'pg_cron jobname mapped to this source. Used by pulse_update_source_cron '
  'RPC to keep cron.job.schedule in sync with schedule_cron. When NULL, '
  'editing schedule_cron updates the config row only (UI warns).';

-- Seed known mappings. Source migrations 062, 081, 109.
UPDATE pulse_source_configs SET cron_job_name = 'pulse-rea-agents'
 WHERE source_id = 'rea_agents' AND cron_job_name IS NULL;
UPDATE pulse_source_configs SET cron_job_name = 'pulse-rea-sales-bb'
 WHERE source_id = 'rea_listings_bb_buy' AND cron_job_name IS NULL;
UPDATE pulse_source_configs SET cron_job_name = 'pulse-rea-rentals-bb'
 WHERE source_id = 'rea_listings_bb_rent' AND cron_job_name IS NULL;
UPDATE pulse_source_configs SET cron_job_name = 'pulse-rea-sold-bb'
 WHERE source_id = 'rea_listings_bb_sold' AND cron_job_name IS NULL;
UPDATE pulse_source_configs SET cron_job_name = 'pulse-detail-enrich'
 WHERE source_id = 'rea_detail_enrich' AND cron_job_name IS NULL;

-- ═══ 2. RPC ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pulse_update_source_cron(
  p_source_id TEXT,
  p_schedule_cron TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jobname TEXT;
  v_jobid BIGINT;
  v_cron_updated BOOLEAN := FALSE;
BEGIN
  -- Require an authenticated caller. Anonymous = reject.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'pulse_update_source_cron requires authenticated caller';
  END IF;

  -- 1. Update the config row first. If source_id doesn't exist we raise.
  UPDATE pulse_source_configs
     SET schedule_cron = p_schedule_cron,
         updated_at = now()
   WHERE source_id = p_source_id
  RETURNING cron_job_name INTO v_jobname;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pulse_source_configs row not found for source_id=%', p_source_id;
  END IF;

  -- 2. If the source has a jobname mapped AND the cron.job row exists,
  --    call cron.alter_job. NULL schedule_cron means "detach from cron"
  --    — in that case we unschedule the job. Otherwise alter it in place.
  IF v_jobname IS NOT NULL THEN
    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = v_jobname LIMIT 1;
    IF v_jobid IS NOT NULL THEN
      IF p_schedule_cron IS NULL THEN
        -- Cron gone from the config — unschedule to stop firing.
        PERFORM cron.unschedule(v_jobname);
      ELSE
        PERFORM cron.alter_job(
          job_id := v_jobid,
          schedule := p_schedule_cron
        );
      END IF;
      v_cron_updated := TRUE;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'source_id', p_source_id,
    'schedule_cron', p_schedule_cron,
    'cron_job_name', v_jobname,
    'cron_updated', v_cron_updated
  );
END;
$$;

-- Only authenticated roles can invoke. anon is explicitly revoked.
REVOKE ALL ON FUNCTION pulse_update_source_cron(TEXT, TEXT) FROM public;
REVOKE ALL ON FUNCTION pulse_update_source_cron(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION pulse_update_source_cron(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION pulse_update_source_cron(TEXT, TEXT) IS
  'DS02: atomically update pulse_source_configs.schedule_cron AND the linked '
  'pg_cron job schedule. Used by PulseDataSources Edit dialog when the cron '
  'string changes. Returns { source_id, schedule_cron, cron_job_name, '
  'cron_updated } so the UI can distinguish a real cron alter from a '
  'config-only update (no jobname mapped or cron.job row missing).';

COMMIT;

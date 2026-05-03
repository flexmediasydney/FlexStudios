-- 457_fire_pending_ingest_now_rpc.sql
--
-- Operator affordance: skip the 2h Dropbox-touch debounce on a pending
-- shortlisting_jobs ingest row by setting scheduled_for = now(). Surfaced
-- on the PendingIngestsWidget as a "Fire now" button — useful when the
-- photographer has signalled they're done uploading and the operator
-- doesn't want to wait out the rest of the debounce window.
--
-- Hardened against misuse:
--   - master_admin only (matches the existing settings-page gate);
--   - target row must be kind='ingest' AND status='pending' (no fast-tracking
--     other kinds, no clobbering running/succeeded/failed jobs);
--   - SECURITY DEFINER + locked search_path so callers can't smuggle in
--     a different `now()` resolver.
--
-- Returns the updated row's id + new scheduled_for so the UI can refresh
-- without a follow-up SELECT.

CREATE OR REPLACE FUNCTION public.shortlisting_fire_pending_ingest_now(
  p_job_id uuid
)
RETURNS TABLE (
  id uuid,
  scheduled_for timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
BEGIN
  v_role := get_user_role();
  IF v_role IS NULL OR v_role <> 'master_admin' THEN
    RAISE EXCEPTION
      'shortlisting_fire_pending_ingest_now: unauthorized (role=%)',
      COALESCE(v_role, '<null>');
  END IF;

  RETURN QUERY
  UPDATE shortlisting_jobs sj
     SET scheduled_for = now(),
         updated_at    = now()
   WHERE sj.id     = p_job_id
     AND sj.kind   = 'ingest'
     AND sj.status = 'pending'
  RETURNING sj.id, sj.scheduled_for;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'shortlisting_fire_pending_ingest_now: no pending ingest job found for id=%',
      p_job_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.shortlisting_fire_pending_ingest_now(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.shortlisting_fire_pending_ingest_now(uuid) IS
  'master_admin operator action: skip the 2h Dropbox-debounce on a pending '
  'ingest job by setting scheduled_for=now(). Dispatcher will claim within '
  'the next */2-min cron tick. Used by PendingIngestsWidget Fire-Now button.';

-- ════════════════════════════════════════════════════════════════════════
-- Migration 296 — Wave 6 Security: drone-related SECURITY DEFINER lockdown
--
-- Stream: W6-Security
-- Closes: QC3-1 #1+#2+#3, QC3-7 D2+D12+D13+D20, QC3-8 E2E2+E2E15
--
-- 1) REVOKE EXECUTE on advisory-lock wrappers + drone-system RPCs from
--    PUBLIC/anon/authenticated. These functions are intended for SERVICE_ROLE
--    callers only (dispatcher, drone-pois Edge Function, admin tooling).
--    Granting `authenticated` was a default-permissive footgun that let any
--    signed-in user DoS the dispatcher, drain the queue, or hold POI locks.
--
-- 2) Wrap get_drone_dead_letter_jobs in a master_admin/admin role gate
--    (still SECURITY DEFINER, still callable from the admin UI under an
--    authenticated JWT, but RAISE EXCEPTION for non-admin roles). anon is
--    revoked outright — there's never a use case to read dead-letter
--    payloads anonymously.
--
-- 3) Pin search_path on fn_sync_user_role_to_auth (SECURITY DEFINER,
--    cross-schema writer) and bump_drone_theme_version (advisor flagged
--    role-mutable search_path). Default-secure: matches the pattern set
--    by 279_secdef_search_path_hardening.
--
-- 4) Tighten drone_renders_update RLS — currently any employee/manager can
--    UPDATE any render row regardless of project assignment (E2E2). Add
--    my_project_ids() scoping for non-admin roles to match drone_shots.
--
-- 5) Block direct lifecycle_state mutations on drone_shots from non-
--    service_role callers via a BEFORE UPDATE trigger. Frontend bypassing
--    the drone-shot-lifecycle Edge Function (E2E15) silently corrupts
--    swimlane bookkeeping. service_role callers (the Edge Function itself)
--    are exempt so the canonical path still works.
--
-- 6) Defensive sweep: REVOKE PUBLIC on every other drone-related SECURITY
--    DEFINER function in the codebase. Default-secure baseline.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1) Advisory-lock wrappers (override mig 293's authenticated grant) ───
REVOKE EXECUTE ON FUNCTION public.pg_try_advisory_lock(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pg_advisory_unlock(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pg_try_advisory_lock(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.pg_advisory_unlock(bigint) TO service_role;
COMMENT ON FUNCTION public.pg_try_advisory_lock(bigint)
  IS 'Service-role only — used by drone-job-dispatcher single-flight enforcement.';
COMMENT ON FUNCTION public.pg_advisory_unlock(bigint)
  IS 'Service-role only — paired with pg_try_advisory_lock wrapper.';

-- ─── 1) drone_pois lock RPCs (used by drone-pois Edge Function only) ─────
REVOKE EXECUTE ON FUNCTION public.drone_pois_acquire_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.drone_pois_release_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.drone_pois_supersede_stale(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drone_pois_acquire_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.drone_pois_release_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.drone_pois_supersede_stale(uuid, text[]) TO service_role;

-- ─── 1) claim_drone_jobs (dispatcher-only — anyone with EXECUTE drains queue) ─
REVOKE EXECUTE ON FUNCTION public.claim_drone_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_drone_jobs(integer) TO service_role;
COMMENT ON FUNCTION public.claim_drone_jobs(integer)
  IS 'Service-role only — drone-job-dispatcher claim path. Authenticated callers MUST NOT have EXECUTE; this RPC mutates drone_jobs.status to "running" and would let any signed-in user drain the queue.';

-- ─── 2) get_drone_dead_letter_jobs — add admin gate, revoke anon ─────────
REVOKE EXECUTE ON FUNCTION public.get_drone_dead_letter_jobs(integer) FROM PUBLIC, anon;
-- Keep authenticated grant intact for admin UI; role check is INSIDE the
-- function so non-admin roles can't read dead-letter payloads.
CREATE OR REPLACE FUNCTION public.get_drone_dead_letter_jobs(p_limit integer DEFAULT 50)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  shoot_id uuid,
  kind text,
  attempt_count integer,
  error_message text,
  scheduled_for timestamp with time zone,
  finished_at timestamp with time zone,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Service role bypasses role gate (Edge Functions / cron).
  IF current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role' THEN
    NULL; -- allowed
  ELSIF get_user_role() NOT IN ('master_admin','admin') THEN
    RAISE EXCEPTION 'Only master_admin or admin can read dead-letter jobs';
  END IF;

  RETURN QUERY
  SELECT
    dj.id,
    dj.project_id,
    dj.shoot_id,
    dj.kind,
    dj.attempt_count,
    dj.error_message,
    dj.scheduled_for,
    dj.finished_at,
    dj.payload
  FROM drone_jobs dj
  WHERE dj.status = 'dead_letter'
  ORDER BY dj.finished_at DESC NULLS LAST, dj.scheduled_for DESC
  LIMIT p_limit;
END;
$$;
COMMENT ON FUNCTION public.get_drone_dead_letter_jobs(integer)
  IS 'Reads dead-letter drone jobs. Internal role gate: master_admin/admin or service_role only.';

-- ─── 3) Pin search_path on missed SECURITY DEFINER functions ─────────────
ALTER FUNCTION public.fn_sync_user_role_to_auth() SET search_path = public, auth, pg_temp;
ALTER FUNCTION public.bump_drone_theme_version() SET search_path = public, pg_temp;

-- ─── 4) Tighten drone_renders_update RLS — add my_project_ids scoping ────
DROP POLICY IF EXISTS drone_renders_update ON public.drone_renders;
CREATE POLICY drone_renders_update ON public.drone_renders
FOR UPDATE
USING (
  get_user_role() IN ('master_admin', 'admin')
  OR (
    get_user_role() IN ('manager', 'employee', 'contractor')
    AND shot_id IN (
      SELECT s.id FROM drone_shots s
      WHERE s.shoot_id IN (
        SELECT sh.id FROM drone_shoots sh
        WHERE sh.project_id IN (SELECT my_project_ids())
      )
    )
  )
)
WITH CHECK (
  get_user_role() IN ('master_admin', 'admin')
  OR (
    get_user_role() IN ('manager', 'employee', 'contractor')
    AND shot_id IN (
      SELECT s.id FROM drone_shots s
      WHERE s.shoot_id IN (
        SELECT sh.id FROM drone_shoots sh
        WHERE sh.project_id IN (SELECT my_project_ids())
      )
    )
  )
);

-- ─── 5) Block direct lifecycle_state mutations on drone_shots ────────────
-- Frontend MUST go through drone-shot-lifecycle Edge Function (which uses
-- service_role and is exempt). Direct PostgREST .update({lifecycle_state})
-- corrupts the swimlane state machine (E2E15).
CREATE OR REPLACE FUNCTION public.drone_shots_block_direct_lifecycle_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- service_role callers (Edge Function dispatcher path) are exempt.
  IF current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    RAISE EXCEPTION 'lifecycle_state changes must go through drone-shot-lifecycle Edge Function (caller role: %)',
      COALESCE(current_setting('request.jwt.claims', true)::jsonb->>'role', 'anon');
  END IF;

  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.drone_shots_block_direct_lifecycle_update()
  IS 'BEFORE UPDATE trigger — rejects lifecycle_state changes from non-service_role callers. Forces all transitions through drone-shot-lifecycle Edge Function so swimlane bookkeeping stays consistent.';

DROP TRIGGER IF EXISTS trg_drone_shots_block_direct_lifecycle ON public.drone_shots;
CREATE TRIGGER trg_drone_shots_block_direct_lifecycle
  BEFORE UPDATE ON public.drone_shots
  FOR EACH ROW
  EXECUTE FUNCTION public.drone_shots_block_direct_lifecycle_update();

-- ─── 6) Defensive sweep — REVOKE PUBLIC on remaining drone SECURITY DEFINER fns ─
-- Triggers — internal use only.
REVOKE EXECUTE ON FUNCTION public.drone_custom_pins_bump_version() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.drone_custom_pins_touch_updated_at() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.drone_pois_cache_block_writes() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.drone_property_boundary_touch() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.drone_renders_stale_against_theme(uuid) FROM PUBLIC, anon;

-- Dispatcher attempt-decrement RPC — service-role only.
REVOKE EXECUTE ON FUNCTION public.drone_jobs_decrement_attempts(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drone_jobs_decrement_attempts(uuid[]) TO service_role;
COMMENT ON FUNCTION public.drone_jobs_decrement_attempts(uuid[])
  IS 'Service-role only — dispatcher stale-claim attempt refund.';

-- Theme impact analysis — used by admin tooling.
REVOKE EXECUTE ON FUNCTION public.drone_theme_impacted_projects(uuid) FROM PUBLIC, anon;

-- Ingest enqueue RPC — internal use only.
REVOKE EXECUTE ON FUNCTION public.enqueue_drone_ingest_job(uuid, integer) FROM PUBLIC, anon;

-- Dashboard stats / live progress — admin UI reads.
REVOKE EXECUTE ON FUNCTION public.get_drone_dashboard_stats() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_drone_shoot_live_progress(uuid[]) FROM PUBLIC, anon;

-- Resurrect dead-letter — admin only.
REVOKE EXECUTE ON FUNCTION public.resurrect_drone_dead_letter_job(uuid) FROM PUBLIC, anon;

NOTIFY pgrst, 'reload schema';

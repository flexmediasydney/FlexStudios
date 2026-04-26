-- ════════════════════════════════════════════════════════════════════════
-- Migration 293 — Wave 5 P3 (QC2-6 #12): expose pg_try_advisory_lock /
-- pg_advisory_unlock to PostgREST via SECURITY DEFINER wrappers in public.
--
-- Why: the dispatcher (FIX 6) needs single-flight enforcement so two
-- overlapping cron invocations (cron `* * * * *` + 145s wall-clock cap)
-- can't both dispatch a separate SfM to Modal back-to-back (doubles spend
-- during overlap). pg_try_advisory_lock is a builtin but lives in
-- pg_catalog, which PostgREST won't expose. supabase-js's .rpc() can only
-- target functions in the public schema.
--
-- These wrappers are intentionally minimal (no auth gate inside) — callers
-- using the service-role key already bypass RLS, and there's no RLS on a
-- function call. The lock keys are namespaced by the caller (hashtext of a
-- per-fn string in TS), so two different Edge Functions don't collide.
--
-- Note: advisory locks are session-scoped. PostgREST acquires a fresh
-- connection per request via the connection pool, so each Edge Function
-- HTTP call shares the lock with concurrent requests on the SAME pool
-- session. In practice this is rare (sessions rotate fast), so a function
-- that crashes mid-tick MAY leak the lock until the session is recycled.
-- The dispatcher mitigates this by always wrapping the body in try/finally
-- and explicitly unlocking.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pg_try_advisory_lock(lock_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.pg_try_advisory_lock(lock_id);
$$;

CREATE OR REPLACE FUNCTION public.pg_advisory_unlock(lock_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.pg_advisory_unlock(lock_id);
$$;

-- Restrict to authenticated + service_role; anon shouldn't be able to
-- enumerate or grab the dispatcher's lock to DoS the queue.
REVOKE ALL ON FUNCTION public.pg_try_advisory_lock(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pg_advisory_unlock(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pg_try_advisory_lock(BIGINT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pg_advisory_unlock(BIGINT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Wave 6 P-burst-21 (VV1): revoke claim_shortlisting_jobs from authenticated
--
-- claim_shortlisting_jobs is SECURITY DEFINER with no in-body role check.
-- Mig 288 granted EXECUTE to `authenticated` for symmetry with the drone
-- claim function, but the only legitimate caller is the dispatcher
-- (service_role) — no UI path exists, no manual debug pattern uses it.
--
-- Granting to `authenticated` lets ANY logged-in user mark all pending jobs
-- 'running' and walk away. The stale-claim sweep eventually recovers (20-
-- minute window per job), but in that window the dispatcher cannot drain
-- the queue and the engine effectively halts.
--
-- Mitigation: revoke from authenticated. service_role retains EXECUTE.
-- Mirrors mig 328's treatment of enqueue_shortlisting_ingest_job.
--
-- NOTE: resurrect_shortlisting_dead_letter_job is also granted to
-- authenticated and lacks an in-body role check, but the Command Center UI
-- depends on this grant. Revoking it here would break the master-admin
-- resurrect button. Tracked separately — proper fix is a service-role
-- wrapper edge function with explicit role gating (mirror the
-- shortlisting-ingest pattern).

REVOKE EXECUTE ON FUNCTION claim_shortlisting_jobs(INT)
  FROM authenticated;

COMMENT ON FUNCTION claim_shortlisting_jobs IS
  'Wave 6 P-burst-21 #VV1: EXECUTE revoked from authenticated. Service_role only — only the dispatcher claims jobs. Atomically claim up to p_limit pending shortlisting_jobs whose scheduled_for is past. Flips status to running, increments attempt_count, sets started_at. Hard cap on attempt_count < 5 (DB backstop). Returns project_id for dispatcher chain logic.';

NOTIFY pgrst, 'reload schema';

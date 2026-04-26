-- Wave 6 P-audit-fix-2 Class B: mig 328: revoke enqueue_shortlisting_ingest_job from authenticated
--
-- Audit defect #51 (P0): mig 288 granted EXECUTE to `authenticated` so the
-- "Re-run shortlisting" UI button could enqueue without round-tripping the
-- service-role JWT. The function is SECURITY DEFINER and has no project_id
-- ownership check inside the body, so any authenticated user could enqueue
-- ingests for ANY project_id — a privilege escalation.
--
-- Mitigation: the manual UI button now calls the shortlisting-ingest edge
-- function directly (which already has its own auth + role check at
-- master_admin/admin/manager). The dispatcher and webhook continue to call
-- this RPC via service_role, which retains EXECUTE.
--
-- Granting strategy after this migration:
--   service_role  — yes (cron, webhook, dispatcher)
--   authenticated — NO (UI button must go through edge fn)

REVOKE EXECUTE ON FUNCTION enqueue_shortlisting_ingest_job(UUID, INT)
  FROM authenticated;

COMMENT ON FUNCTION enqueue_shortlisting_ingest_job IS
  'Wave 6 P-audit-fix-2 #51: EXECUTE revoked from authenticated. Now service_role only. The UI Manual Run button calls shortlisting-ingest directly (which has master_admin/admin/manager role gating). Debounced upsert of a pending kind=ingest shortlisting_jobs row for a project. The unique partial index uniq_shortlisting_jobs_pending_ingest_per_project enforces at-most-one pending ingest per project.';

NOTIFY pgrst, 'reload schema';

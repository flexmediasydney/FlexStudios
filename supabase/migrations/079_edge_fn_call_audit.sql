-- 079_edge_fn_call_audit.sql
--
-- Problem: Every edge function call is fire-and-forget — on failure, errors
-- are swallowed by `.catch(err => console.warn(...))`. On 2026-04-16 a Supabase
-- platform auth-key migration silently broke 23 edge functions for 18+ hours
-- because nothing logged the failures.
--
-- Fix: durable audit trail for every edge function invocation via the
-- `serveWithAudit()` wrapper in supabase/functions/_shared/supabase.ts.
-- Insert is fire-and-forget in the wrapper's `finally` so audit-table failure
-- never breaks the function itself.
--
-- Retention: 30 days via pg_cron (daily 03:00 UTC).

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS edge_fn_call_audit (
  id            BIGSERIAL PRIMARY KEY,
  fn_name       TEXT NOT NULL,
  caller        TEXT,                        -- 'frontend' | 'cross_fn:{source_fn}' | 'cron' | 'webhook' | 'unknown'
  status        TEXT NOT NULL,               -- 'success' | 'error' | 'timeout'
  http_status   INT,
  duration_ms   INT,
  error_message TEXT,
  request_id    TEXT,                        -- from CF-Ray or similar if available
  user_id       UUID,                        -- if authenticated user triggered it
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE edge_fn_call_audit IS 'Every edge-function invocation outcome. 30-day retention via pg_cron.';

-- ─── Indexes ─────────────────────────────────────────────────────────────────

-- Per-function + recent-first lookups (health-dashboard queries, 24h window).
CREATE INDEX IF NOT EXISTS idx_edge_fn_audit_name_time
  ON edge_fn_call_audit(fn_name, created_at DESC);

-- Error-digging / outage detection.
CREATE INDEX IF NOT EXISTS idx_edge_fn_audit_errors
  ON edge_fn_call_audit(fn_name, created_at DESC)
  WHERE status != 'success';

-- ─── Row Level Security ──────────────────────────────────────────────────────

ALTER TABLE edge_fn_call_audit ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT. Service-role bypasses RLS so edge functions can always
-- read; regular users get nothing unless they have admin/master_admin role.
-- This mirrors the RLS patterns used elsewhere in this schema.
DROP POLICY IF EXISTS "admins can read edge audit" ON edge_fn_call_audit;
CREATE POLICY "admins can read edge audit"
  ON edge_fn_call_audit
  FOR SELECT
  USING (
    (auth.jwt() ->> 'role') = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.email = (auth.jwt() ->> 'email')
        AND u.role IN ('admin', 'master_admin')
    )
  );

-- Permissive INSERT: frontend fallback logging needs to be able to write telemetry
-- rows even when no admin auth is present. These records are non-sensitive
-- (no PII beyond fn_name / status / error_message / optional user_id).
DROP POLICY IF EXISTS "anyone can insert audit rows" ON edge_fn_call_audit;
CREATE POLICY "anyone can insert audit rows"
  ON edge_fn_call_audit
  FOR INSERT
  WITH CHECK (true);

-- ─── Retention: 30-day rolling delete via pg_cron ────────────────────────────

-- pg_cron is already enabled (see 018_tonomo_cron.sql). Schedule a daily
-- cleanup at 03:00 UTC. Unschedule first for idempotency on re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'edge-fn-audit-retention') THEN
      PERFORM cron.unschedule('edge-fn-audit-retention');
    END IF;
    PERFORM cron.schedule(
      'edge-fn-audit-retention',
      '0 3 * * *',
      $cron$DELETE FROM edge_fn_call_audit WHERE created_at < NOW() - INTERVAL '30 days'$cron$
    );
  END IF;
END $$;

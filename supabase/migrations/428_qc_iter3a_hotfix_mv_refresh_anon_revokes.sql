-- 428_qc_iter3a_hotfix_mv_refresh_anon_revokes.sql
--
-- QC iter 3 agent A hotfix bundle (3 findings):
--
-- F-3A-001 (CRITICAL): MV refresh CONCURRENTLY needs unique index on actual
--   column, not constant expression ((true)). The W6b mig 424 created
--   `idx_pulse_kpis_mv_pin` and `idx_shortlisting_kpis_mv_pin` as
--   `UNIQUE INDEX ... ((true))`. Postgres requires REFRESH ... CONCURRENTLY
--   to use a unique index ON ACTUAL COLUMN(S). Result: every cron tick
--   since W6b deploy was failing with "cannot refresh concurrently — Create
--   a unique index with no WHERE clause on one or more columns of the
--   materialized view." KPI dashboards have been frozen at W6b deploy time.
--
-- F-3A-002 (HIGH): MVs were created with default GRANTs that included
--   anon + authenticated full access via PostgREST. Anyone with the
--   publishable Supabase key could query the KPI snapshot directly,
--   bypassing the master_admin/admin gate that the *_cached() RPCs enforce.
--
-- F-3A-005 (HIGH): pulse_compute_quote_failures log table (created in mig
--   419 W5) had default GRANTs giving anon DML privileges. RLS policy
--   blocks reads but the GRANT INSERT was unnecessary attack surface.

BEGIN;

-- ════ F-3A-001: Replace constant-expression unique indexes ════
DROP INDEX IF EXISTS idx_pulse_kpis_mv_pin;
DROP INDEX IF EXISTS idx_shortlisting_kpis_mv_pin;

CREATE UNIQUE INDEX idx_pulse_kpis_mv_computed_at
  ON pulse_command_center_kpis_mv (computed_at);

CREATE UNIQUE INDEX idx_shortlisting_kpis_mv_computed_at
  ON shortlisting_command_center_kpis_mv (computed_at);

-- Initial sync refresh + CONCURRENTLY smoke test
REFRESH MATERIALIZED VIEW pulse_command_center_kpis_mv;
REFRESH MATERIALIZED VIEW shortlisting_command_center_kpis_mv;
REFRESH MATERIALIZED VIEW CONCURRENTLY pulse_command_center_kpis_mv;
REFRESH MATERIALIZED VIEW CONCURRENTLY shortlisting_command_center_kpis_mv;

-- ════ F-3A-002: Revoke anon/authenticated direct table access ════
REVOKE ALL ON pulse_command_center_kpis_mv FROM anon, authenticated, public;
REVOKE ALL ON shortlisting_command_center_kpis_mv FROM anon, authenticated, public;

GRANT SELECT ON pulse_command_center_kpis_mv TO service_role;
GRANT SELECT ON shortlisting_command_center_kpis_mv TO service_role;

-- The *_cached() RPCs from mig 424 are SECURITY DEFINER → frontend keeps
-- working. Direct PostgREST table access is now blocked.

-- ════ F-3A-005: Revoke anon DML on pulse_compute_quote_failures ════
REVOKE ALL ON pulse_compute_quote_failures FROM anon, authenticated, public;

-- master_admin SELECT preserved via existing RLS policy pcqf_admin_read.
-- service_role full access via existing pcqf_service_all policy.

-- ════ Observability log ═════════════════════════════════════════════════
DO $$
DECLARE
  v_pulse_acl text;
  v_short_acl text;
BEGIN
  SELECT relacl::text INTO v_pulse_acl FROM pg_class WHERE relname='pulse_command_center_kpis_mv';
  SELECT relacl::text INTO v_short_acl FROM pg_class WHERE relname='shortlisting_command_center_kpis_mv';

  RAISE NOTICE 'Mig 428 (QC iter 3 agent A hotfix): MV pin indexes replaced + anon revoked';
  RAISE NOTICE '  pulse_kpis_mv ACL: %', v_pulse_acl;
  RAISE NOTICE '  shortlisting_kpis_mv ACL: %', v_short_acl;
END $$;

COMMIT;

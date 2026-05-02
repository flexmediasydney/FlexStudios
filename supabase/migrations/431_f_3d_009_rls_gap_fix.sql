-- 431_f_3d_009_rls_gap_fix.sql
-- ============================================================================
-- QC iter 3 finding F-3D-009 — close the RLS gap on 21 public-schema tables
-- that shipped with `rowsecurity=false` and the default Supabase ACL granting
-- anon + authenticated full DML. On a multi-tenant CRM (FlexStudios — Sydney
-- real estate photography) this is a security gap: anyone with the
-- publishable Supabase key could read or mutate these tables directly,
-- bypassing the get_user_role() gates the rest of the app enforces.
--
-- Mirror of the pattern from mig 415 (F-A-004) which closed the same gap on
-- engine_settings / shortlisting_lock_progress / shortlisting_tiers.
--
-- Source: pg_tables WHERE schemaname='public' AND rowsecurity=false on
-- prod (rjzdznwkxnzfekgcdkei) at 2026-05-02. 21 tables identified.
--
-- ─── Policy classes ─────────────────────────────────────────────────────────
-- Each table gets ALTER TABLE ... ENABLE ROW LEVEL SECURITY plus at least one
-- policy. RLS-on-no-policy = zero rows visible to anyone, which would break
-- the app — every table below has both.
--
-- Class A: backup / snapshot tables (master_admin SELECT only)
--   _saladine_two_pass_snapshot, _w11_7_null_classifications_backup,
--   w15b7_smoke_50_baseline
--
-- Class B: internal infra / log payloads (master_admin SELECT only,
--          service_role full)
--   dispatcher_locks, notification_email_queue, pricing_audit_log,
--   pulse_entity_sync_history, pulse_sync_log_payloads,
--   tonomo_webhook_log_payloads, properties
--
-- Class C: ops dashboards (master_admin/admin SELECT, service_role full)
--   legacy_import_batches, pulse_fire_queue, pulse_fire_batches,
--   pulse_middleman_domains, price_matrix_versions
--
-- Class D: ops dashboards w/ manager visibility
--          (master_admin/admin/manager SELECT, service_role full)
--   legacy_projects, pulse_agent_stats_history, pulse_timeline_event_types
--
-- Class E: admin-editable tables (master_admin/admin SELECT + DML,
--          service_role full)
--   package_engine_tier_mapping (UI: SettingsPackageTierMapping)
--   pulse_linkage_issues (UI: PulseMappings)
--   pulse_source_circuit_breakers (UI: PulseDataSources)
--
-- All auth.role() / auth.uid() calls are wrapped in (SELECT ...) for
-- query-planner hoisting (per F-A-013 / mig 425 lesson). get_user_role() is
-- already SECURITY DEFINER and stable, so wrapping is also applied for
-- consistency with the rest of the codebase.
--
-- Notes on writes:
--   * The 5 UI-read pulse/legacy tables are read via postgres-owned views
--     (legacy_import_batches_with_progress, legacy_projects_with_crm,
--     properties_health_v, property_full_v). Views run as their owner and
--     bypass RLS on the underlying base tables, so adding RLS here does NOT
--     break those reads.
--   * All writes to queue / log tables go through edge functions using the
--     service_role admin client.
--
-- Verify after apply:
--   SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity=true;
--   -- should increase by exactly 21
-- ============================================================================

BEGIN;

-- ════ Class A: backup / snapshot tables ════════════════════════════════════
ALTER TABLE public._saladine_two_pass_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._saladine_two_pass_snapshot FROM anon, authenticated;

DROP POLICY IF EXISTS saladine_snapshot_master_admin_select
  ON public._saladine_two_pass_snapshot;
CREATE POLICY saladine_snapshot_master_admin_select
  ON public._saladine_two_pass_snapshot
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS saladine_snapshot_service_all
  ON public._saladine_two_pass_snapshot;
CREATE POLICY saladine_snapshot_service_all
  ON public._saladine_two_pass_snapshot
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public._w11_7_null_classifications_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._w11_7_null_classifications_backup FROM anon, authenticated;

DROP POLICY IF EXISTS w11_7_null_backup_master_admin_select
  ON public._w11_7_null_classifications_backup;
CREATE POLICY w11_7_null_backup_master_admin_select
  ON public._w11_7_null_classifications_backup
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS w11_7_null_backup_service_all
  ON public._w11_7_null_classifications_backup;
CREATE POLICY w11_7_null_backup_service_all
  ON public._w11_7_null_classifications_backup
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.w15b7_smoke_50_baseline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.w15b7_smoke_50_baseline FROM anon, authenticated;

DROP POLICY IF EXISTS w15b7_smoke_baseline_master_admin_select
  ON public.w15b7_smoke_50_baseline;
CREATE POLICY w15b7_smoke_baseline_master_admin_select
  ON public.w15b7_smoke_50_baseline
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS w15b7_smoke_baseline_service_all
  ON public.w15b7_smoke_50_baseline;
CREATE POLICY w15b7_smoke_baseline_service_all
  ON public.w15b7_smoke_50_baseline
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ════ Class B: internal infra / log payloads (master_admin SELECT only) ════
ALTER TABLE public.dispatcher_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatcher_locks FROM anon, authenticated;

DROP POLICY IF EXISTS dispatcher_locks_master_admin_select
  ON public.dispatcher_locks;
CREATE POLICY dispatcher_locks_master_admin_select
  ON public.dispatcher_locks
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS dispatcher_locks_service_all ON public.dispatcher_locks;
CREATE POLICY dispatcher_locks_service_all
  ON public.dispatcher_locks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.notification_email_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_email_queue FROM anon, authenticated;

DROP POLICY IF EXISTS notification_email_queue_master_admin_select
  ON public.notification_email_queue;
CREATE POLICY notification_email_queue_master_admin_select
  ON public.notification_email_queue
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS notification_email_queue_service_all
  ON public.notification_email_queue;
CREATE POLICY notification_email_queue_service_all
  ON public.notification_email_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pricing_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pricing_audit_log FROM anon, authenticated;

DROP POLICY IF EXISTS pricing_audit_log_master_admin_select
  ON public.pricing_audit_log;
CREATE POLICY pricing_audit_log_master_admin_select
  ON public.pricing_audit_log
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS pricing_audit_log_service_all ON public.pricing_audit_log;
CREATE POLICY pricing_audit_log_service_all
  ON public.pricing_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_entity_sync_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_entity_sync_history FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_entity_sync_history_master_admin_select
  ON public.pulse_entity_sync_history;
CREATE POLICY pulse_entity_sync_history_master_admin_select
  ON public.pulse_entity_sync_history
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS pulse_entity_sync_history_service_all
  ON public.pulse_entity_sync_history;
CREATE POLICY pulse_entity_sync_history_service_all
  ON public.pulse_entity_sync_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_sync_log_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_sync_log_payloads FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_sync_log_payloads_master_admin_select
  ON public.pulse_sync_log_payloads;
CREATE POLICY pulse_sync_log_payloads_master_admin_select
  ON public.pulse_sync_log_payloads
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS pulse_sync_log_payloads_service_all
  ON public.pulse_sync_log_payloads;
CREATE POLICY pulse_sync_log_payloads_service_all
  ON public.pulse_sync_log_payloads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.tonomo_webhook_log_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tonomo_webhook_log_payloads FROM anon, authenticated;

DROP POLICY IF EXISTS tonomo_webhook_log_payloads_master_admin_select
  ON public.tonomo_webhook_log_payloads;
CREATE POLICY tonomo_webhook_log_payloads_master_admin_select
  ON public.tonomo_webhook_log_payloads
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS tonomo_webhook_log_payloads_service_all
  ON public.tonomo_webhook_log_payloads;
CREATE POLICY tonomo_webhook_log_payloads_service_all
  ON public.tonomo_webhook_log_payloads
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.properties FROM anon, authenticated;

DROP POLICY IF EXISTS properties_master_admin_select ON public.properties;
CREATE POLICY properties_master_admin_select
  ON public.properties
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = 'master_admin');

DROP POLICY IF EXISTS properties_service_all ON public.properties;
CREATE POLICY properties_service_all
  ON public.properties
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ════ Class C: ops dashboards (master_admin/admin SELECT) ══════════════════
ALTER TABLE public.legacy_import_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_import_batches FROM anon, authenticated;

DROP POLICY IF EXISTS legacy_import_batches_admin_select
  ON public.legacy_import_batches;
CREATE POLICY legacy_import_batches_admin_select
  ON public.legacy_import_batches
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS legacy_import_batches_service_all
  ON public.legacy_import_batches;
CREATE POLICY legacy_import_batches_service_all
  ON public.legacy_import_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_fire_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_fire_queue FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_fire_queue_admin_select ON public.pulse_fire_queue;
CREATE POLICY pulse_fire_queue_admin_select
  ON public.pulse_fire_queue
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS pulse_fire_queue_service_all ON public.pulse_fire_queue;
CREATE POLICY pulse_fire_queue_service_all
  ON public.pulse_fire_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_fire_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_fire_batches FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_fire_batches_admin_select ON public.pulse_fire_batches;
CREATE POLICY pulse_fire_batches_admin_select
  ON public.pulse_fire_batches
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS pulse_fire_batches_service_all ON public.pulse_fire_batches;
CREATE POLICY pulse_fire_batches_service_all
  ON public.pulse_fire_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_middleman_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_middleman_domains FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_middleman_domains_admin_select
  ON public.pulse_middleman_domains;
CREATE POLICY pulse_middleman_domains_admin_select
  ON public.pulse_middleman_domains
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS pulse_middleman_domains_service_all
  ON public.pulse_middleman_domains;
CREATE POLICY pulse_middleman_domains_service_all
  ON public.pulse_middleman_domains
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.price_matrix_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_matrix_versions FROM anon, authenticated;

DROP POLICY IF EXISTS price_matrix_versions_admin_select
  ON public.price_matrix_versions;
CREATE POLICY price_matrix_versions_admin_select
  ON public.price_matrix_versions
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS price_matrix_versions_service_all
  ON public.price_matrix_versions;
CREATE POLICY price_matrix_versions_service_all
  ON public.price_matrix_versions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ════ Class D: ops dashboards w/ manager visibility ════════════════════════
ALTER TABLE public.legacy_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.legacy_projects FROM anon, authenticated;

DROP POLICY IF EXISTS legacy_projects_authenticated_select ON public.legacy_projects;
CREATE POLICY legacy_projects_authenticated_select
  ON public.legacy_projects
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text,'manager'::text]));

DROP POLICY IF EXISTS legacy_projects_service_all ON public.legacy_projects;
CREATE POLICY legacy_projects_service_all
  ON public.legacy_projects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_agent_stats_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_agent_stats_history FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_agent_stats_history_authenticated_select
  ON public.pulse_agent_stats_history;
CREATE POLICY pulse_agent_stats_history_authenticated_select
  ON public.pulse_agent_stats_history
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text,'manager'::text]));

DROP POLICY IF EXISTS pulse_agent_stats_history_service_all
  ON public.pulse_agent_stats_history;
CREATE POLICY pulse_agent_stats_history_service_all
  ON public.pulse_agent_stats_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.pulse_timeline_event_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_timeline_event_types FROM anon, authenticated;

DROP POLICY IF EXISTS pulse_timeline_event_types_authenticated_select
  ON public.pulse_timeline_event_types;
CREATE POLICY pulse_timeline_event_types_authenticated_select
  ON public.pulse_timeline_event_types
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text,'manager'::text]));

DROP POLICY IF EXISTS pulse_timeline_event_types_service_all
  ON public.pulse_timeline_event_types;
CREATE POLICY pulse_timeline_event_types_service_all
  ON public.pulse_timeline_event_types
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ════ Class E: admin-editable tables (frontend writes) ═════════════════════
-- package_engine_tier_mapping is read+upserted from SettingsPackageTierMapping.
ALTER TABLE public.package_engine_tier_mapping ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.package_engine_tier_mapping FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.package_engine_tier_mapping TO authenticated;

DROP POLICY IF EXISTS package_engine_tier_mapping_admin_select
  ON public.package_engine_tier_mapping;
CREATE POLICY package_engine_tier_mapping_admin_select
  ON public.package_engine_tier_mapping
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS package_engine_tier_mapping_admin_insert
  ON public.package_engine_tier_mapping;
CREATE POLICY package_engine_tier_mapping_admin_insert
  ON public.package_engine_tier_mapping
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS package_engine_tier_mapping_admin_update
  ON public.package_engine_tier_mapping;
CREATE POLICY package_engine_tier_mapping_admin_update
  ON public.package_engine_tier_mapping
  FOR UPDATE TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]))
  WITH CHECK ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS package_engine_tier_mapping_service_all
  ON public.package_engine_tier_mapping;
CREATE POLICY package_engine_tier_mapping_service_all
  ON public.package_engine_tier_mapping
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- pulse_linkage_issues is read+updated from PulseMappings (resolve issues UI).
ALTER TABLE public.pulse_linkage_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_linkage_issues FROM anon;
GRANT SELECT, UPDATE ON public.pulse_linkage_issues TO authenticated;

DROP POLICY IF EXISTS pulse_linkage_issues_admin_select
  ON public.pulse_linkage_issues;
CREATE POLICY pulse_linkage_issues_admin_select
  ON public.pulse_linkage_issues
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text,'manager'::text]));

DROP POLICY IF EXISTS pulse_linkage_issues_admin_update
  ON public.pulse_linkage_issues;
CREATE POLICY pulse_linkage_issues_admin_update
  ON public.pulse_linkage_issues
  FOR UPDATE TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]))
  WITH CHECK ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS pulse_linkage_issues_service_all
  ON public.pulse_linkage_issues;
CREATE POLICY pulse_linkage_issues_service_all
  ON public.pulse_linkage_issues
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- pulse_source_circuit_breakers is read+updated from PulseDataSources
-- (manual circuit-reset UI).
ALTER TABLE public.pulse_source_circuit_breakers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pulse_source_circuit_breakers FROM anon;
GRANT SELECT, UPDATE ON public.pulse_source_circuit_breakers TO authenticated;

DROP POLICY IF EXISTS pulse_source_circuit_breakers_admin_select
  ON public.pulse_source_circuit_breakers;
CREATE POLICY pulse_source_circuit_breakers_admin_select
  ON public.pulse_source_circuit_breakers
  FOR SELECT TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text,'manager'::text]));

DROP POLICY IF EXISTS pulse_source_circuit_breakers_admin_update
  ON public.pulse_source_circuit_breakers;
CREATE POLICY pulse_source_circuit_breakers_admin_update
  ON public.pulse_source_circuit_breakers
  FOR UPDATE TO authenticated
  USING ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]))
  WITH CHECK ((SELECT public.get_user_role()) = ANY (ARRAY['master_admin'::text,'admin'::text]));

DROP POLICY IF EXISTS pulse_source_circuit_breakers_service_all
  ON public.pulse_source_circuit_breakers;
CREATE POLICY pulse_source_circuit_breakers_service_all
  ON public.pulse_source_circuit_breakers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ════ Observability log ════════════════════════════════════════════════════
DO $$
DECLARE
  v_rls_count int;
  v_policy_count int;
BEGIN
  SELECT COUNT(*) INTO v_rls_count
    FROM pg_tables WHERE schemaname='public' AND rowsecurity=true;
  SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies WHERE schemaname='public' AND tablename IN (
      '_saladine_two_pass_snapshot','_w11_7_null_classifications_backup',
      'dispatcher_locks','legacy_import_batches','legacy_projects',
      'notification_email_queue','package_engine_tier_mapping',
      'price_matrix_versions','pricing_audit_log','properties',
      'pulse_agent_stats_history','pulse_entity_sync_history',
      'pulse_fire_batches','pulse_fire_queue','pulse_linkage_issues',
      'pulse_middleman_domains','pulse_source_circuit_breakers',
      'pulse_sync_log_payloads','pulse_timeline_event_types',
      'tonomo_webhook_log_payloads','w15b7_smoke_50_baseline'
    );
  RAISE NOTICE
    'Mig 431 (F-3D-009 RLS gap fix): public_rls_enabled_tables=%, policies_on_21_tables=%',
    v_rls_count, v_policy_count;

  IF v_policy_count < 30 THEN
    RAISE WARNING 'Expected >=30 policies across 21 tables, got %; investigate', v_policy_count;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Rollback (run manually if this migration breaks production):
--
-- BEGIN;
-- ALTER TABLE public._saladine_two_pass_snapshot DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public._w11_7_null_classifications_backup DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.w15b7_smoke_50_baseline DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.dispatcher_locks DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.notification_email_queue DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pricing_audit_log DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_entity_sync_history DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_sync_log_payloads DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.tonomo_webhook_log_payloads DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.properties DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.legacy_import_batches DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_fire_queue DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_fire_batches DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_middleman_domains DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.price_matrix_versions DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.legacy_projects DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_agent_stats_history DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_timeline_event_types DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.package_engine_tier_mapping DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_linkage_issues DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.pulse_source_circuit_breakers DISABLE ROW LEVEL SECURITY;
--
-- -- Restore the previous (loose) anon/authenticated grants. NOTE: restoring
-- -- these grants reopens the security gap — only do this if the post-mig
-- -- state is breaking the app worse than the gap itself, and revisit
-- -- immediately.
-- GRANT SELECT, INSERT, UPDATE, DELETE ON
--   public._saladine_two_pass_snapshot,
--   public._w11_7_null_classifications_backup,
--   public.w15b7_smoke_50_baseline,
--   public.dispatcher_locks,
--   public.notification_email_queue,
--   public.pricing_audit_log,
--   public.pulse_entity_sync_history,
--   public.pulse_sync_log_payloads,
--   public.tonomo_webhook_log_payloads,
--   public.properties,
--   public.legacy_import_batches,
--   public.pulse_fire_queue,
--   public.pulse_fire_batches,
--   public.pulse_middleman_domains,
--   public.price_matrix_versions,
--   public.legacy_projects,
--   public.pulse_agent_stats_history,
--   public.pulse_timeline_event_types,
--   public.package_engine_tier_mapping,
--   public.pulse_linkage_issues,
--   public.pulse_source_circuit_breakers
-- TO anon, authenticated;
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
--
-- Note: rollback drops all 21x ENABLE ROW LEVEL SECURITY but leaves the
-- newly-created policies in place (they're inert when RLS is disabled and
-- can be cleaned up via DROP POLICY at leisure).

-- 043_fix_remaining_ae_all.sql
-- Replace all remaining legacy ae_all policies (master_admin + employee only)
-- with admin_employee_manager_all (master_admin + admin + manager + employee).
-- 44 tables still had the old policy after migration 042.

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'agencies',
    'agents',
    'audit_logs',
    'automation_rule_logs',
    'calendar_events',
    'clients',
    'delivery_settings',
    'email_link_clicks',
    'employee_roles',
    'external_listings',
    'interaction_logs',
    'internal_teams',
    'package_audit_logs',
    'package_snapshots',
    'packages',
    'photographer_availabilities',
    'price_matrices',
    'price_matrix_audit_logs',
    'price_matrix_snapshots',
    'product_audit_logs',
    'product_categories',
    'product_snapshots',
    'products',
    'project_activities',
    'project_automation_rules',
    'project_efforts',
    'project_media',
    'project_notes',
    'project_presences',
    'project_revisions',
    'project_stage_timers',
    'project_tasks',
    'project_types',
    'projects',
    'scheduled_emails',
    'task_chats',
    'task_time_logs',
    'tonomo_booking_flow_tiers',
    'tonomo_integration_settings',
    'tonomo_mapping_tables',
    'tonomo_processing_queue',
    'tonomo_project_type_mappings',
    'tonomo_role_defaults',
    'tonomo_webhook_logs'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "ae_all" ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "admin_employee_manager_all" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "admin_employee_manager_all" ON %I FOR ALL USING (get_user_role() IN (''master_admin'', ''admin'', ''manager'', ''employee''))',
      tbl
    );
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

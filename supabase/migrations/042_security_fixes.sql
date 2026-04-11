-- 042_security_fixes.sql
-- Fix critical security findings: privilege escalation + legacy policies

-- Fix 1: Remove overly permissive policy from entity_access_rules
-- The admin_employee_manager_all policy lets ANY employee modify access rules at DB level.
-- The ear_modify (master_admin only) + authenticated_read policies are sufficient.
DROP POLICY IF EXISTS "admin_employee_manager_all" ON entity_access_rules;

-- Fix 2: Add manager/admin to 14 tables stuck on legacy ae_all policy
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'email_accounts', 'email_activities', 'email_blocked_addresses',
    'email_labels', 'email_messages', 'email_templates',
    'note_tags', 'org_notes', 'revision_templates',
    'role_category_mappings', 'team_activity_feeds', 'teams',
    'tonomo_audit_logs', 'tonomo_integrations'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "ae_all" ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY "admin_employee_manager_all" ON %I FOR ALL USING (get_user_role() IN (''master_admin'', ''admin'', ''manager'', ''employee''))',
      tbl
    );
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

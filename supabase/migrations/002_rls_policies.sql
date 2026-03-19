-- ============================================================================
-- FlexStudios RLS Policies
--
-- Role hierarchy:
--   master_admin → full read/write on everything
--   employee     → read/write on most tables, no user mgmt or permissions
--   contractor   → read/write only on assigned projects and own data
--
-- The user's role is stored in public.users.role
-- Auth identity comes from auth.uid() matching public.users.id
-- ============================================================================

-- ─── Helper function: get current user's role ────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM public.users WHERE id = auth.uid()
$$;

-- ─── Helper function: check if contractor is assigned to a project ───────────
CREATE OR REPLACE FUNCTION public.is_assigned_to_project(project_row projects)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT (
    project_row.project_owner_id = auth.uid() OR
    project_row.photographer_id = auth.uid() OR
    project_row.videographer_id = auth.uid() OR
    project_row.image_editor_id = auth.uid() OR
    project_row.video_editor_id = auth.uid() OR
    project_row.floorplan_editor_id = auth.uid() OR
    project_row.drone_editor_id = auth.uid() OR
    project_row.onsite_staff_1_id = auth.uid() OR
    project_row.onsite_staff_2_id = auth.uid() OR
    auth.uid()::text = ANY(
      CASE
        WHEN project_row.assigned_users IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(project_row.assigned_users))
        ELSE ARRAY[]::text[]
      END
    )
  )
$$;

-- ─── Helper: get project IDs this user is assigned to ────────────────────────
CREATE OR REPLACE FUNCTION public.my_project_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM public.projects
  WHERE
    project_owner_id = auth.uid() OR
    photographer_id = auth.uid() OR
    videographer_id = auth.uid() OR
    image_editor_id = auth.uid() OR
    video_editor_id = auth.uid() OR
    floorplan_editor_id = auth.uid() OR
    drone_editor_id = auth.uid() OR
    onsite_staff_1_id = auth.uid() OR
    onsite_staff_2_id = auth.uid() OR
    auth.uid()::text = ANY(
      CASE
        WHEN assigned_users IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(assigned_users))
        ELSE ARRAY[]::text[]
      END
    )
$$;

-- ============================================================================
-- ENABLE RLS ON ALL TABLES
-- ============================================================================

ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rule_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_blocked_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_link_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_utilization ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE photographer_availabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_matrices ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_matrix_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_matrix_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_efforts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_presences ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_stage_timers ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE revision_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_category_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_activity_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_booking_flow_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_integration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_mapping_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_processing_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_project_type_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_role_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE tonomo_webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_signatures ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- TIER 1: ADMIN-ONLY TABLES (master_admin full access, no one else)
-- ============================================================================
-- Tables: users, user_permissions, permissions, permission_audit_logs, roles,
--         approval_workflows, employee_utilization

-- users
CREATE POLICY "admin_full_access" ON users FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "users_read_self" ON users FOR SELECT
  USING (id = auth.uid());
CREATE POLICY "employee_read_users" ON users FOR SELECT
  USING (get_user_role() = 'employee');

-- user_permissions
CREATE POLICY "admin_full_access" ON user_permissions FOR ALL
  USING (get_user_role() = 'master_admin');

-- permissions
CREATE POLICY "admin_full_access" ON permissions FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "authenticated_read" ON permissions FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- permission_audit_logs
CREATE POLICY "admin_full_access" ON permission_audit_logs FOR ALL
  USING (get_user_role() = 'master_admin');

-- roles
CREATE POLICY "admin_full_access" ON roles FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "authenticated_read" ON roles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- approval_workflows
CREATE POLICY "admin_full_access" ON approval_workflows FOR ALL
  USING (get_user_role() = 'master_admin');

-- employee_utilization
CREATE POLICY "admin_full_access" ON employee_utilization FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "employee_read_own" ON employee_utilization FOR SELECT
  USING (get_user_role() = 'employee' AND user_id = auth.uid());


-- ============================================================================
-- TIER 2: ADMIN + EMPLOYEE TABLES (full access for both, no contractor)
-- ============================================================================

-- Macro: create admin+employee full access policies
-- CRM tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'agencies', 'agents', 'teams', 'clients',
    'external_listings', 'interaction_logs',
    'audit_logs', 'org_activity_logs', 'org_notes', 'note_tags',
    'email_accounts', 'email_messages', 'email_activities',
    'email_blocked_addresses', 'email_labels', 'email_link_clicks',
    'email_templates',
    'products', 'product_audit_logs', 'product_categories', 'product_snapshots',
    'packages', 'package_audit_logs', 'package_snapshots',
    'price_matrices', 'price_matrix_audit_logs', 'price_matrix_snapshots',
    'project_types', 'revision_templates',
    'delivery_settings',
    'project_automation_rules', 'automation_rule_logs',
    'role_category_mappings', 'employee_roles',
    'internal_teams',
    'tonomo_audit_logs', 'tonomo_booking_flow_tiers', 'tonomo_integrations',
    'tonomo_integration_settings', 'tonomo_mapping_tables',
    'tonomo_processing_queue', 'tonomo_project_type_mappings',
    'tonomo_role_defaults', 'tonomo_webhook_logs',
    'team_activity_feeds'
  ])
  LOOP
    EXECUTE format(
      'CREATE POLICY "admin_employee_all" ON %I FOR ALL USING (get_user_role() IN (''master_admin'', ''employee''))',
      tbl
    );
  END LOOP;
END;
$$;


-- ============================================================================
-- TIER 3: PROJECT-SCOPED TABLES (admin+employee full, contractor sees assigned)
-- ============================================================================

-- projects
CREATE POLICY "admin_employee_all" ON projects FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON projects FOR SELECT
  USING (get_user_role() = 'contractor' AND id IN (SELECT my_project_ids()));
CREATE POLICY "contractor_update_assigned" ON projects FOR UPDATE
  USING (get_user_role() = 'contractor' AND id IN (SELECT my_project_ids()));

-- project_tasks
CREATE POLICY "admin_employee_all" ON project_tasks FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_tasks FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));
CREATE POLICY "contractor_update_assigned" ON project_tasks FOR UPDATE
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_activities
CREATE POLICY "admin_employee_all" ON project_activities FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_activities FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_efforts
CREATE POLICY "admin_employee_all" ON project_efforts FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_efforts FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_media
CREATE POLICY "admin_employee_all" ON project_media FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_media FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_notes
CREATE POLICY "admin_employee_all" ON project_notes FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_notes FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_revisions
CREATE POLICY "admin_employee_all" ON project_revisions FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_revisions FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_stage_timers
CREATE POLICY "admin_employee_all" ON project_stage_timers FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON project_stage_timers FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));

-- project_presences
CREATE POLICY "admin_employee_all" ON project_presences FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_own" ON project_presences FOR ALL
  USING (get_user_role() = 'contractor' AND user_id = auth.uid());

-- task_chats
CREATE POLICY "admin_employee_all" ON task_chats FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON task_chats FOR SELECT
  USING (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));
CREATE POLICY "contractor_insert_assigned" ON task_chats FOR INSERT
  WITH CHECK (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()));


-- ============================================================================
-- TIER 4: USER-SCOPED TABLES (own data only for non-admins)
-- ============================================================================

-- task_time_logs: admin+employee full, contractor own only
CREATE POLICY "admin_employee_all" ON task_time_logs FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_own" ON task_time_logs FOR ALL
  USING (get_user_role() = 'contractor' AND user_id = auth.uid());

-- notifications: everyone sees own
CREATE POLICY "admin_full_access" ON notifications FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "own_notifications" ON notifications FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "update_own_notifications" ON notifications FOR UPDATE
  USING (user_id = auth.uid());
CREATE POLICY "employee_insert" ON notifications FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin', 'employee'));

-- notification_preferences: own only
CREATE POLICY "admin_full_access" ON notification_preferences FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "own_prefs" ON notification_preferences FOR ALL
  USING (user_id = auth.uid());

-- notification_digest_settings: own only
CREATE POLICY "admin_full_access" ON notification_digest_settings FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "own_settings" ON notification_digest_settings FOR ALL
  USING (user_id = auth.uid());

-- user_signatures: own only + admin
CREATE POLICY "admin_full_access" ON user_signatures FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "own_signatures" ON user_signatures FOR ALL
  USING (user_id = auth.uid());
CREATE POLICY "employee_read_all" ON user_signatures FOR SELECT
  USING (get_user_role() = 'employee');

-- photographer_availabilities: own + admin/employee read
CREATE POLICY "admin_employee_all" ON photographer_availabilities FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_own" ON photographer_availabilities FOR ALL
  USING (get_user_role() = 'contractor' AND user_id = auth.uid());

-- calendar_connections: own + admin read all
CREATE POLICY "admin_full_access" ON calendar_connections FOR ALL
  USING (get_user_role() = 'master_admin');
CREATE POLICY "employee_own" ON calendar_connections FOR ALL
  USING (get_user_role() = 'employee' AND created_by = (SELECT email FROM users WHERE id = auth.uid()));
CREATE POLICY "employee_read_all" ON calendar_connections FOR SELECT
  USING (get_user_role() = 'employee');

-- calendar_events: admin+employee full, contractor sees assigned project events
CREATE POLICY "admin_employee_all" ON calendar_events FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));
CREATE POLICY "contractor_read_assigned" ON calendar_events FOR SELECT
  USING (get_user_role() = 'contractor' AND (
    owner_user_id = auth.uid() OR
    project_id IN (SELECT my_project_ids())
  ));
CREATE POLICY "contractor_own_events" ON calendar_events FOR ALL
  USING (get_user_role() = 'contractor' AND created_by_user_id = auth.uid());


-- ============================================================================
-- GRANT SERVICE ROLE BYPASS
-- Edge Functions use service_role key which bypasses RLS automatically.
-- No additional grants needed.
-- ============================================================================

-- ============================================================================
-- VERIFY: Count policies created
-- ============================================================================
-- SELECT schemaname, tablename, policyname
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;

-- CRITICAL FIX: Remove conflicting permissive policy that bypasses product/package locks
-- Migration 043 accidentally re-added admin_employee_manager_all to products/packages
-- which ORs with the lock-aware policies, making locks ineffective

-- Products: remove the blanket policy, keep lock-aware ones
DROP POLICY IF EXISTS "admin_employee_manager_all" ON products;

-- Packages: same fix
DROP POLICY IF EXISTS "admin_employee_manager_all" ON packages;

-- Also fix entity_access_rules: restrict to master_admin only (was admin+master_admin)
DROP POLICY IF EXISTS "admin_full_access" ON entity_access_rules;
CREATE POLICY "owner_full_access" ON entity_access_rules FOR ALL
  USING (get_user_role() = 'master_admin');

-- Fix email_conversations: add manager/admin
DROP POLICY IF EXISTS "admin_employee_all" ON email_conversations;
CREATE POLICY "admin_employee_manager_all" ON email_conversations FOR ALL
  USING (get_user_role() IN ('master_admin', 'admin', 'manager', 'employee'));

-- Fix project DELETE: restrict to owner only (was admin+employee via ae_all)
-- The admin_employee_manager_all on projects allows ALL including DELETE
-- We need to split it into separate SELECT/INSERT/UPDATE/DELETE policies
DROP POLICY IF EXISTS "admin_employee_manager_all" ON projects;

-- Projects: everyone can read
CREATE POLICY "projects_read_all" ON projects FOR SELECT
  USING (get_user_role() IN ('master_admin', 'admin', 'manager', 'employee')
    OR (get_user_role() = 'contractor' AND id IN (SELECT my_project_ids())));

-- Projects: manager+ can create
CREATE POLICY "projects_insert" ON projects FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin', 'admin', 'manager', 'employee'));

-- Projects: manager+ can update (contractor on assigned only)
CREATE POLICY "projects_update" ON projects FOR UPDATE
  USING (get_user_role() IN ('master_admin', 'admin', 'manager', 'employee')
    OR (get_user_role() = 'contractor' AND id IN (SELECT my_project_ids())));

-- Projects: ONLY owner can delete
CREATE POLICY "projects_delete_owner_only" ON projects FOR DELETE
  USING (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

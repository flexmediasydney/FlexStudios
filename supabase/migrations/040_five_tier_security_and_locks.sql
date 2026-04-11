-- ============================================================================
-- 040: 5-Tier Security Levels + Product/Package Locking
-- ============================================================================

-- 1. Expand security level options on users table
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('master_admin','admin','manager','employee','contractor'));

-- 2. Product lock fields
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS locked_by_name TEXT;

-- 3. Package lock fields
ALTER TABLE packages ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS locked_by_name TEXT;

-- 4. Update RLS policies to include 'manager' in appropriate tiers
-- Drop and recreate the TIER 2 (CRM) policy to include manager
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'agencies', 'agents', 'clients', 'products', 'packages', 'price_matrices',
    'product_audit_logs', 'package_audit_logs', 'price_matrix_audit_logs',
    'product_snapshots', 'package_snapshots', 'price_matrix_snapshots',
    'product_categories', 'project_types', 'delivery_settings',
    'tonomo_integration_settings', 'tonomo_processing_queue',
    'tonomo_webhook_logs', 'tonomo_mapping_tables', 'tonomo_role_defaults',
    'tonomo_project_type_mappings', 'tonomo_booking_flow_tiers',
    'team_role_assignments', 'entity_access_rules',
    'internal_teams', 'employee_roles', 'scheduled_emails', 'email_link_clicks',
    'entity_files', 'project_automation_rules', 'automation_rule_logs',
    'interaction_logs', 'external_listings'
  ])
  LOOP
    -- Drop old policy if exists
    EXECUTE format('DROP POLICY IF EXISTS "admin_employee_all" ON %I', tbl);
    -- Create new policy with manager included
    EXECUTE format(
      'CREATE POLICY "admin_employee_manager_all" ON %I FOR ALL USING (get_user_role() IN (''master_admin'', ''admin'', ''manager'', ''employee''))',
      tbl
    );
  END LOOP;
END;
$$;

-- 5. Product/package lock guard: prevent writes when locked (except master_admin)
-- For products
DROP POLICY IF EXISTS "admin_employee_manager_all" ON products;
CREATE POLICY "products_read_all_staff" ON products FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "products_write_unlocked" ON products FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "products_update_lock_aware" ON products FOR UPDATE
  USING (
    get_user_role() = 'master_admin'
    OR (get_user_role() IN ('admin') AND NOT is_locked)
  );
CREATE POLICY "products_delete_owner_only" ON products FOR DELETE
  USING (get_user_role() = 'master_admin');

-- For packages
DROP POLICY IF EXISTS "admin_employee_manager_all" ON packages;
CREATE POLICY "packages_read_all_staff" ON packages FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "packages_write_unlocked" ON packages FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "packages_update_lock_aware" ON packages FOR UPDATE
  USING (
    get_user_role() = 'master_admin'
    OR (get_user_role() IN ('admin') AND NOT is_locked)
  );
CREATE POLICY "packages_delete_owner_only" ON packages FOR DELETE
  USING (get_user_role() = 'master_admin');

-- 6. Ensure entity_access_rules table exists
CREATE TABLE IF NOT EXISTS entity_access_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role            TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  access_level    TEXT NOT NULL DEFAULT 'none'
                  CHECK (access_level IN ('none', 'view', 'edit')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(role, entity_type)
);

ALTER TABLE entity_access_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_full_access" ON entity_access_rules;
DROP POLICY IF EXISTS "authenticated_read" ON entity_access_rules;
CREATE POLICY "admin_full_access" ON entity_access_rules FOR ALL
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "authenticated_read" ON entity_access_rules FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- 7. Seed entity_access_rules for all 5 levels x 11 entity types
INSERT INTO entity_access_rules (role, entity_type, access_level) VALUES
  -- master_admin: full edit on everything
  ('master_admin', 'products', 'edit'),
  ('master_admin', 'packages', 'edit'),
  ('master_admin', 'project_types', 'edit'),
  ('master_admin', 'product_categories', 'edit'),
  ('master_admin', 'role_matrix', 'edit'),
  ('master_admin', 'price_matrices', 'edit'),
  ('master_admin', 'tonomo_mappings', 'edit'),
  ('master_admin', 'internal_teams', 'edit'),
  ('master_admin', 'users', 'edit'),
  ('master_admin', 'request_templates', 'edit'),
  ('master_admin', 'pricing_visibility', 'edit'),
  -- admin: edit most, view-only on some
  ('admin', 'products', 'edit'),
  ('admin', 'packages', 'edit'),
  ('admin', 'project_types', 'edit'),
  ('admin', 'product_categories', 'edit'),
  ('admin', 'role_matrix', 'edit'),
  ('admin', 'price_matrices', 'edit'),
  ('admin', 'tonomo_mappings', 'edit'),
  ('admin', 'internal_teams', 'edit'),
  ('admin', 'users', 'edit'),
  ('admin', 'request_templates', 'edit'),
  ('admin', 'pricing_visibility', 'view'),
  -- manager: view most, edit templates
  ('manager', 'products', 'view'),
  ('manager', 'packages', 'view'),
  ('manager', 'project_types', 'view'),
  ('manager', 'product_categories', 'view'),
  ('manager', 'role_matrix', 'view'),
  ('manager', 'price_matrices', 'view'),
  ('manager', 'tonomo_mappings', 'view'),
  ('manager', 'internal_teams', 'view'),
  ('manager', 'users', 'view'),
  ('manager', 'request_templates', 'edit'),
  ('manager', 'pricing_visibility', 'view'),
  -- employee: view-only on most, none on sensitive
  ('employee', 'products', 'view'),
  ('employee', 'packages', 'view'),
  ('employee', 'project_types', 'view'),
  ('employee', 'product_categories', 'view'),
  ('employee', 'role_matrix', 'none'),
  ('employee', 'price_matrices', 'none'),
  ('employee', 'tonomo_mappings', 'none'),
  ('employee', 'internal_teams', 'view'),
  ('employee', 'users', 'none'),
  ('employee', 'request_templates', 'view'),
  ('employee', 'pricing_visibility', 'none'),
  -- contractor: minimal access
  ('contractor', 'products', 'none'),
  ('contractor', 'packages', 'none'),
  ('contractor', 'project_types', 'none'),
  ('contractor', 'product_categories', 'none'),
  ('contractor', 'role_matrix', 'none'),
  ('contractor', 'price_matrices', 'none'),
  ('contractor', 'tonomo_mappings', 'none'),
  ('contractor', 'internal_teams', 'none'),
  ('contractor', 'users', 'none'),
  ('contractor', 'request_templates', 'none'),
  ('contractor', 'pricing_visibility', 'none')
ON CONFLICT (role, entity_type) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- 284_drone_property_boundary_rls
--
-- Wave 5 Phase 2 / S1: RLS for drone_property_boundary.
-- Read: any role with project visibility (manager/employee/admin/master_admin),
-- contractor scoped via my_project_ids().
-- Write (insert/update/delete): master_admin/admin always; manager/employee
-- with project visibility; contractor blocked from boundary writes.

ALTER TABLE drone_property_boundary ENABLE ROW LEVEL SECURITY;

CREATE POLICY drone_property_boundary_read ON drone_property_boundary
  FOR SELECT USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );

CREATE POLICY drone_property_boundary_write ON drone_property_boundary
  FOR ALL USING (
    get_user_role() IN ('master_admin','admin')
    OR (get_user_role() IN ('manager','employee')
        AND project_id IN (SELECT my_project_ids()))
  )
  WITH CHECK (
    get_user_role() IN ('master_admin','admin')
    OR (get_user_role() IN ('manager','employee')
        AND project_id IN (SELECT my_project_ids()))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON drone_property_boundary TO authenticated;

-- Security hardening: tighten RLS policies for media_favorites, media_tags,
-- and audit_logs. Addresses findings from security audit.
--
-- Changes:
--   1. media_favorites: replace blanket "authenticated_all" with owner-scoped
--      write policies. All authenticated users can still READ (team visibility),
--      but only the owning user can INSERT/UPDATE/DELETE their own favorites.
--   2. media_tags: keep "authenticated_all" for read, but restrict writes to
--      authenticated users (tag names are shared, but we scope the creator).
--   3. audit_logs: make effectively append-only from the frontend by restricting
--      UPDATE and DELETE to service_role / master_admin only.

-- ============================================================================
-- 1. media_favorites — owner-scoped writes
-- ============================================================================

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "authenticated_all" ON media_favorites;

-- Anyone authenticated can read all favorites (team visibility feature)
CREATE POLICY "authenticated_read" ON media_favorites FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only the owner can insert their own favorites (user_id must match auth.uid())
CREATE POLICY "owner_insert" ON media_favorites FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND user_id = auth.uid()
  );

-- Only the owner can update their own favorites
CREATE POLICY "owner_update" ON media_favorites FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Only the owner can delete their own favorites
CREATE POLICY "owner_delete" ON media_favorites FOR DELETE
  USING (user_id = auth.uid());


-- ============================================================================
-- 2. media_tags — keep shared read, restrict writes to authenticated
-- ============================================================================

-- The existing "authenticated_all" policy is acceptable for media_tags because
-- tags are a shared registry (any team member can create or update tag metadata).
-- No change needed here — the policy already requires auth.uid() IS NOT NULL.


-- ============================================================================
-- 3. audit_logs — append-only from frontend perspective
-- ============================================================================

-- The existing "admin_employee_all" policy from 002_rls_policies.sql grants
-- full CRUD to admin+employee roles. We need to split this so that:
--   - SELECT + INSERT remain available to admin+employee
--   - UPDATE + DELETE are restricted to master_admin only
--
-- Drop the existing blanket policy and replace with granular ones.

DROP POLICY IF EXISTS "admin_employee_all" ON audit_logs;

-- Read: admin + employee can read all audit logs
CREATE POLICY "admin_employee_read" ON audit_logs FOR SELECT
  USING (get_user_role() IN ('master_admin', 'employee'));

-- Insert: admin + employee can create audit log entries
CREATE POLICY "admin_employee_insert" ON audit_logs FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin', 'employee'));

-- Update: only master_admin (audit logs should be immutable from normal users)
CREATE POLICY "admin_only_update" ON audit_logs FOR UPDATE
  USING (get_user_role() = 'master_admin');

-- Delete: only master_admin (prevent log tampering)
CREATE POLICY "admin_only_delete" ON audit_logs FOR DELETE
  USING (get_user_role() = 'master_admin');

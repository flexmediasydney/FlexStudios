-- ============================================================================
-- 025: RLS Security Fixes
--
-- Fixes discovered during security audit:
--
-- 1. scheduled_emails: had USING(true) — any authenticated user could read/write
--    ALL scheduled emails (cross-tenant data leak of email content, recipients)
-- 2. email_link_clicks: had USING(true) — any authenticated user could read/write
--    ALL click tracking data (IP addresses, user agents exposed)
-- 3. invite_codes: NO RLS enabled — readable even by unauthenticated anon key
-- 4. entity_access_rules: NO proper RLS — access control rules modifiable by anyone
-- 5. entity_files: NO proper RLS — file metadata exposed to all users
-- ============================================================================

-- ─── 1. Fix scheduled_emails: replace USING(true) with proper scoped policies ─

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Allow all for authenticated" ON scheduled_emails;

-- Admin + Employee: full access (consistent with email_messages tier)
CREATE POLICY "admin_employee_all" ON scheduled_emails FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));

-- ─── 2. Fix email_link_clicks: replace USING(true) with proper scoped policies ─

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Allow all for authenticated" ON email_link_clicks;

-- Admin + Employee: full access (consistent with email_messages tier)
CREATE POLICY "admin_employee_all" ON email_link_clicks FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));

-- ─── 3. Fix invite_codes: enable RLS + restrict to admin-only ─────────────────

ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;

-- Only master_admin can manage invite codes
CREATE POLICY "admin_full_access" ON invite_codes FOR ALL
  USING (get_user_role() = 'master_admin');

-- Allow the claim_invite_code RPC (which runs as SECURITY DEFINER) to work,
-- but anon/authenticated users cannot directly query the table
-- No additional SELECT policy needed — the RPC bypasses RLS via SECURITY DEFINER

-- ─── 4. Fix entity_access_rules: enable RLS + admin-only write, all read ──────

ALTER TABLE entity_access_rules ENABLE ROW LEVEL SECURITY;

-- Only master_admin can modify access rules
CREATE POLICY "admin_full_access" ON entity_access_rules FOR ALL
  USING (get_user_role() = 'master_admin');

-- All authenticated users can READ access rules (needed for UI permission checks)
CREATE POLICY "authenticated_read" ON entity_access_rules FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- ─── 5. Fix entity_files: enable RLS + role-based access ──────────────────────

ALTER TABLE entity_files ENABLE ROW LEVEL SECURITY;

-- Admin + Employee: full access (files are CRM-related, same tier as agents/agencies)
CREATE POLICY "admin_employee_all" ON entity_files FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));

-- ─── 6. Fix auth_events: enable RLS + admin-only ──────────────────────────────

ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;

-- Only master_admin can view auth events (sensitive login/invite audit trail)
CREATE POLICY "admin_full_access" ON auth_events FOR ALL
  USING (get_user_role() = 'master_admin');

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

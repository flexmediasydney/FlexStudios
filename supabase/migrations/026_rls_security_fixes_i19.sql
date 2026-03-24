-- Iteration 19: RLS Security Audit Fixes
-- 3 critical gaps found across 114 policies on 75 tables

-- Fix 1: email_link_clicks had qual=true — any authenticated user could read/write/delete
DROP POLICY IF EXISTS "Allow all for authenticated" ON email_link_clicks;
CREATE POLICY "ae_all" ON email_link_clicks FOR ALL
  USING (get_user_role() = ANY (ARRAY['master_admin', 'employee']));

-- Fix 2: scheduled_emails had qual=true — any authenticated user could manipulate
DROP POLICY IF EXISTS "Allow all for authenticated" ON scheduled_emails;
CREATE POLICY "ae_all" ON scheduled_emails FOR ALL
  USING (get_user_role() = ANY (ARRAY['master_admin', 'employee']));

-- Fix 3: invite_codes ALL had qual=true — any user could create/delete invite codes
DROP POLICY IF EXISTS "invite_codes_admin" ON invite_codes;
CREATE POLICY "invite_codes_admin" ON invite_codes FOR ALL
  USING (get_user_role() = 'master_admin');
-- Note: invite_codes_read (SELECT with qual=true) intentionally left open for registration flow

-- Allow unauthenticated users to validate invite codes on the /register page.
-- Without this, the RLS policy (auth.uid() IS NOT NULL) blocks code validation
-- for users who haven't signed in yet — which is the entire point of invite codes.
CREATE POLICY IF NOT EXISTS invite_codes_anon_validate
  ON invite_codes FOR SELECT TO anon
  USING (is_active = true);

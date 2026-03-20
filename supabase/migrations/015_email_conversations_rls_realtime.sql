-- ============================================================================
-- 015_email_conversations_rls_realtime.sql
-- Add RLS policies and Realtime to email_conversations table
-- (was missed because 002_rls_policies.sql and 009_enable_realtime.sql
--  were written before the email_conversations table existed in 013)
-- ============================================================================

-- Enable RLS
ALTER TABLE email_conversations ENABLE ROW LEVEL SECURITY;

-- Admin + Employee full access (same tier as email_messages, email_accounts)
CREATE POLICY "admin_employee_all" ON email_conversations FOR ALL
  USING (get_user_role() IN ('master_admin', 'employee'));

-- Enable Realtime so frontend subscriptions receive events
ALTER PUBLICATION supabase_realtime ADD TABLE email_conversations;

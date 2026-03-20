-- 014_email_agent_linking.sql
-- Add agent/agency linking columns to email_messages for CRM auto-linking

ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS agent_id UUID;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS agency_id UUID;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS agent_name TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS agency_name TEXT;

CREATE INDEX IF NOT EXISTS idx_email_messages_agent ON email_messages(agent_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_agency ON email_messages(agency_id, received_at DESC);

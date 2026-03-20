CREATE TABLE IF NOT EXISTS email_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  subject TEXT,
  snippet TEXT,
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  unread_count INTEGER DEFAULT 0,
  participant_count INTEGER DEFAULT 0,
  participants JSONB DEFAULT '[]'::jsonb,
  is_archived BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  is_starred BOOLEAN DEFAULT false,
  project_id UUID,
  project_title TEXT,
  agent_id UUID,
  agency_id UUID,
  labels JSONB DEFAULT '[]'::jsonb,
  last_sender TEXT,
  last_sender_name TEXT,
  has_attachments BOOLEAN DEFAULT false,
  snoozed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(email_account_id, gmail_thread_id)
);

CREATE INDEX idx_email_conversations_account ON email_conversations(email_account_id, last_message_at DESC);
CREATE INDEX idx_email_conversations_project ON email_conversations(project_id);
CREATE INDEX idx_email_conversations_agent ON email_conversations(agent_id);
CREATE INDEX idx_email_conversations_agency ON email_conversations(agency_id);
CREATE INDEX idx_email_conversations_folder ON email_conversations(email_account_id, is_archived, is_deleted, last_message_at DESC);

CREATE TRIGGER set_updated_at_email_conversations BEFORE UPDATE ON email_conversations
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

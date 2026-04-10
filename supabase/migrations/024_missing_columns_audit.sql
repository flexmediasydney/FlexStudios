-- Migration 024: Add missing columns discovered by full codebase audit
-- These columns are written by edge functions or frontend code but were never created

-- email_accounts
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_mode TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_full_sync_at TIMESTAMPTZ;

-- email_messages
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS assigned_to UUID;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS bcc JSONB DEFAULT '[]'::jsonb;

-- notifications
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_date TIMESTAMPTZ;

-- projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS assigned_teams JSONB DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by TEXT;

-- project_tasks
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS total_effort_logged INTEGER DEFAULT 0;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS shoot_date_missing BOOLEAN DEFAULT false;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

-- project_efforts
ALTER TABLE project_efforts ADD COLUMN IF NOT EXISTS project_title TEXT;
ALTER TABLE project_efforts ADD COLUMN IF NOT EXISTS effort_breakdown JSONB DEFAULT '[]'::jsonb;
ALTER TABLE project_efforts ADD COLUMN IF NOT EXISTS total_estimated_seconds INTEGER DEFAULT 0;
ALTER TABLE project_efforts ADD COLUMN IF NOT EXISTS total_actual_seconds INTEGER DEFAULT 0;
ALTER TABLE project_efforts ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ;

-- project_activities
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS automation_rule_id UUID;
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS automation_rule_name TEXT;

-- calendar_events
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;

-- agencies
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS total_revenue NUMERIC DEFAULT 0;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS last_booking_at TIMESTAMPTZ;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS branding_preferences JSONB;

-- agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS average_booking_value NUMERIC DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS booking_count_12m INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_booking_at TIMESTAMPTZ;

-- New tables
CREATE TABLE IF NOT EXISTS scheduled_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID REFERENCES email_accounts(id),
  user_id UUID REFERENCES users(id),
  to_addresses JSONB DEFAULT '[]'::jsonb,
  cc JSONB DEFAULT '[]'::jsonb,
  bcc JSONB DEFAULT '[]'::jsonb,
  subject TEXT,
  body TEXT,
  in_reply_to TEXT,
  thread_id TEXT,
  gmail_message_id TEXT,
  status TEXT DEFAULT 'pending',
  error TEXT,
  sent_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  project_id UUID,
  attachments JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_link_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id UUID REFERENCES email_messages(id),
  clicked_by UUID,
  clicked_by_name TEXT,
  link_url TEXT,
  link_text TEXT,
  ip_address TEXT,
  user_agent TEXT,
  clicked_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE scheduled_emails ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='scheduled_emails' AND policyname='Allow all for authenticated') THEN
    CREATE POLICY "Allow all for authenticated" ON scheduled_emails FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
ALTER TABLE email_link_clicks ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='email_link_clicks' AND policyname='Allow all for authenticated') THEN
    CREATE POLICY "Allow all for authenticated" ON email_link_clicks FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

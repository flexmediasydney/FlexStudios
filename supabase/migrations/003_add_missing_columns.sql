-- ============================================================================
-- Migration 003: Add missing columns discovered during Edge Function testing
-- These columns are used by sync functions but weren't in the initial schema
-- because they're only written server-side (not visible in frontend code)
-- ============================================================================

-- ── calendar_connections ────────────────────────────────────────────────────
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS next_sync_token TEXT;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS last_sync_count INTEGER;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS visibility_policy TEXT DEFAULT 'show_all';
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- ── calendar_events ─────────────────────────────────────────────────────────
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_html_link TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_synced BOOLEAN DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_all_day BOOLEAN DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS is_done BOOLEAN DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS activity_type TEXT DEFAULT 'meeting';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_event_type TEXT DEFAULT 'default';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_visibility TEXT DEFAULT 'default';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_transparency TEXT DEFAULT 'opaque';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS connection_visibility_policy TEXT DEFAULT 'show_all';
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS attendees JSONB;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS attendee_responses JSONB;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS conference_link TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurring_event_id TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS auto_linked BOOLEAN DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS link_source TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS link_confidence TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS calendar_account TEXT;

-- ── email_accounts ──────────────────────────────────────────────────────────
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS next_page_token TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS history_id TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'idle';
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_error TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_count INTEGER;

-- ── email_messages ──────────────────────────────────────────────────────────
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT true;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS labels JSONB DEFAULT '[]'::jsonb;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS snippet TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS internal_date TIMESTAMPTZ;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS size_estimate INTEGER;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS header_message_id TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS references_header TEXT;

-- ── projects (extra fields used by sync/automation functions) ────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tonomo_google_event_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS calendar_auto_linked BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS calendar_link_source TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS invoice_status TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geocoded_lat NUMERIC;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geocoded_lng NUMERIC;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;

-- ── project_tasks (extra fields) ────────────────────────────────────────────
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS actual_minutes NUMERIC;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS completed_by_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS completed_by_name TEXT;

-- ── Indexes on new columns ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_calendar_events_google_event_id ON calendar_events(google_event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar_account ON calendar_events(calendar_account);
CREATE INDEX IF NOT EXISTS idx_calendar_events_auto_linked ON calendar_events(auto_linked) WHERE auto_linked = true;
CREATE INDEX IF NOT EXISTS idx_email_messages_is_visible ON email_messages(is_visible);
CREATE INDEX IF NOT EXISTS idx_email_messages_internal_date ON email_messages(internal_date);
CREATE INDEX IF NOT EXISTS idx_projects_tonomo_google_event_id ON projects(tonomo_google_event_id);
CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(is_archived);

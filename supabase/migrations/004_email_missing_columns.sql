-- ============================================================================
-- Migration 004: Add missing columns for email system
-- Columns written by syncGmailMessagesForAccount, sendGmailMessage,
-- and used by frontend email settings components
-- ============================================================================

-- ── email_accounts: sync metrics (written by syncGmailMessagesForAccount) ──
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_message_count INTEGER DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS total_synced_count INTEGER DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sync_error_count INTEGER DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sync_health TEXT DEFAULT 'ok';

-- ── email_accounts: settings used by EmailAccountSettingsTab ──
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS team_name TEXT;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS track_opens BOOLEAN DEFAULT false;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS track_clicks BOOLEAN DEFAULT false;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS auto_link_to_projects BOOLEAN DEFAULT false;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS default_visibility TEXT DEFAULT 'private'
  CHECK (default_visibility IN ('private', 'shared'));

-- ── email_messages: idempotency key (written by sendGmailMessage) ──
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- ── email_templates: columns used by frontend (body, is_shared) ──
-- Schema has body_html but code reads/writes "body" and "is_shared"
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT true;

-- ── email_blocked_addresses: email_account_id (used by settings filter) ──
ALTER TABLE email_blocked_addresses ADD COLUMN IF NOT EXISTS email_account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE;

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_email_messages_idempotency ON email_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_blocked_addresses_account ON email_blocked_addresses(email_account_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_sync_health ON email_accounts(sync_health);

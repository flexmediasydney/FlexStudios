-- 012_email_missing_columns.sql
-- Add missing columns and performance indexes for email_messages and email_accounts

-- 1. Add is_deleted column if not exists
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;

-- 2. Add is_archived column if not exists
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

-- 3. Index on is_deleted
CREATE INDEX IF NOT EXISTS idx_email_messages_is_deleted
  ON email_messages (is_deleted);

-- 4. Index on is_archived
CREATE INDEX IF NOT EXISTS idx_email_messages_is_archived
  ON email_messages (is_archived);

-- 5. Composite index for folder view
CREATE INDEX IF NOT EXISTS idx_email_messages_folder_view
  ON email_messages (email_account_id, is_draft, is_sent, is_deleted, is_archived, received_at DESC);

-- 6. Composite index for active user accounts
CREATE INDEX IF NOT EXISTS idx_email_accounts_active_user
  ON email_accounts (assigned_to_user_id, is_active);

-- 7. Composite index for thread grouping
CREATE INDEX IF NOT EXISTS idx_email_messages_thread_grouping
  ON email_messages (email_account_id, gmail_thread_id, received_at DESC);

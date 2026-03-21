-- Add missing columns to email_labels table.
-- The initial schema (001) only had id, name, created_at, updated_at.
-- Application code requires color and email_account_id.

ALTER TABLE email_labels ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#3b82f6';
ALTER TABLE email_labels ADD COLUMN IF NOT EXISTS email_account_id TEXT;

-- Index for filtering labels by account
CREATE INDEX IF NOT EXISTS idx_email_labels_account ON email_labels (email_account_id);

-- ============================================================================
-- Migration 010: Fix missing columns found by Edge Function audit
-- These columns are written by Edge Functions but don't exist in the schema
-- ============================================================================

-- ── email_messages ──────────────────────────────────────────────────────────
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- ── email_accounts (sync tracking fields) ───────────────────────────────────
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sync_message_count INTEGER;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS total_synced_count INTEGER DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sync_error_count INTEGER DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sync_health TEXT DEFAULT 'idle';

-- ── project_activities (actor tracking) ─────────────────────────────────────
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS actor_type TEXT;
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS actor_source TEXT;

-- ── projects (additional fields used by various functions) ──────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_stage_change_by TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_archive_checked_at TIMESTAMPTZ;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_email_messages_idempotency ON email_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_accounts_sync_health ON email_accounts(sync_health);

-- Migration 072: Agent email hygiene tracking
--
-- REA listing payloads ship emails as comma-joined strings mixing the agent's
-- real address with their CRM's capture/lead-drop alias (Agentbox, Rex, Eagle,
-- Inspect RE, etc.). The cleanup utility in
-- supabase/functions/_shared/emailCleanup.ts filters these out before writing
-- to pulse_agents; this migration adds the audit trail columns so we can see
-- what was rejected and when.

ALTER TABLE pulse_agents
  ADD COLUMN IF NOT EXISTS rejected_emails jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE pulse_agents
  ADD COLUMN IF NOT EXISTS email_cleaned_at timestamptz;

-- Partial index: quickly find rows that still need the one-shot backfill.
CREATE INDEX IF NOT EXISTS idx_pulse_agents_email_uncleaned
  ON pulse_agents(id)
  WHERE email_cleaned_at IS NULL;

COMMENT ON COLUMN pulse_agents.rejected_emails IS
  'Emails filtered out by _shared/emailCleanup.ts (CRM middleman / forwarder / generic role aliases). JSONB array of lowercase strings. Audit trail for blocklist tuning.';
COMMENT ON COLUMN pulse_agents.email_cleaned_at IS
  'Timestamp of last hygiene pass. NULL means this row has never been run through the cleanup utility.';

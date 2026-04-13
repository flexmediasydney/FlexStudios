-- Agent data integrity: Tonomo UID tracking + integrity flags
-- Enables auto-creation of agents from webhooks and data quality tracking

-- 1. Tonomo UID for matching webhook-detected people to CRM agents
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tonomo_uid TEXT;
CREATE INDEX IF NOT EXISTS idx_agents_tonomo_uid ON agents(tonomo_uid) WHERE tonomo_uid IS NOT NULL;

-- 2. Data integrity flags
ALTER TABLE agents ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS data_integrity_issues JSONB DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_created BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_agents_needs_review ON agents(needs_review) WHERE needs_review = true;

COMMENT ON COLUMN agents.tonomo_uid IS 'Tonomo Firebase UID — used to match webhook contacts to CRM agents';
COMMENT ON COLUMN agents.needs_review IS 'True when agent was auto-created or has data integrity issues';
COMMENT ON COLUMN agents.data_integrity_issues IS 'JSON array of issue codes: missing_organisation, missing_email, missing_phone';
COMMENT ON COLUMN agents.auto_created IS 'True when agent was auto-created by a Tonomo webhook (not manually)';

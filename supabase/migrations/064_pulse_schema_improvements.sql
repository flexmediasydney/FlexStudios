-- 064_pulse_schema_improvements.sql
-- Comprehensive cleanup: drop duplicate indexes, add missing indexes,
-- fix data quality issues, clean stale sync logs, remove dead Domain
-- cron jobs, and add new columns for websift enrichment.

-- ============================================================
-- 1. DROP DUPLICATE INDEXES
-- ============================================================
-- idx_pulse_agencies_rea_id is identical to idx_pulse_agencies_rea_agency_id
DROP INDEX IF EXISTS idx_pulse_agencies_rea_id;

-- idx_pulse_agencies_name (btree on name) is redundant with idx_pulse_agencies_name_unique (lower(trim(name)))
DROP INDEX IF EXISTS idx_pulse_agencies_name;

-- idx_pulse_agents_rea_agent_id (non-unique) duplicates idx_pulse_agents_rea_id (unique) on same column
DROP INDEX IF EXISTS idx_pulse_agents_rea_agent_id;

-- idx_pulse_listings_agent_rea_id duplicates idx_pulse_listings_agent_rea (identical definition)
DROP INDEX IF EXISTS idx_pulse_listings_agent_rea_id;

-- idx_pulse_listings_source_listing_id (non-unique) duplicates idx_pulse_listings_source_id (unique)
DROP INDEX IF EXISTS idx_pulse_listings_source_listing_id;

-- ============================================================
-- 2. ADD MISSING INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_pulse_agents_agency_rea_id ON pulse_agents(agency_rea_id) WHERE agency_rea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_listings_type ON pulse_listings(listing_type);
CREATE INDEX IF NOT EXISTS idx_pulse_listings_type_suburb ON pulse_listings(listing_type, suburb);
CREATE INDEX IF NOT EXISTS idx_pulse_agents_in_crm ON pulse_agents(is_in_crm) WHERE is_in_crm = true;
CREATE INDEX IF NOT EXISTS idx_pulse_crm_mappings_pulse_entity ON pulse_crm_mappings(pulse_entity_id) WHERE pulse_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_crm_mappings_crm_entity ON pulse_crm_mappings(crm_entity_id) WHERE crm_entity_id IS NOT NULL;

-- ============================================================
-- 3. FIX SOURCE CONCATENATION GARBAGE
-- ============================================================
UPDATE pulse_agencies SET source = 'rea' WHERE source LIKE '%+%';
UPDATE pulse_agents SET source = 'rea' WHERE source LIKE '%+%';

-- ============================================================
-- 4. CLEAN UP STALE SYNC LOGS
-- ============================================================
UPDATE pulse_sync_logs SET status = 'failed', completed_at = now() WHERE status = 'running' AND started_at < now() - interval '1 hour';

-- ============================================================
-- 5. REMOVE DEAD DOMAIN CRON JOBS
-- ============================================================
SELECT cron.unschedule('pulse-domain-agents');
SELECT cron.unschedule('pulse-domain-agencies');
SELECT cron.unschedule('pulse-domain-listings-buy');
SELECT cron.unschedule('pulse-domain-listings-rent');

-- ============================================================
-- 6. ADD TIMESTAMP DEFAULTS (idempotent -- already set, but safe)
-- ============================================================
ALTER TABLE pulse_agents ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE pulse_agents ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE pulse_agencies ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE pulse_agencies ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE pulse_listings ALTER COLUMN created_at SET DEFAULT now();

-- ============================================================
-- 7. ADD NEW COLUMNS FOR WEBSIFT ENRICHMENT
-- ============================================================
ALTER TABLE pulse_agents ADD COLUMN IF NOT EXISTS biography text;
ALTER TABLE pulse_agents ADD COLUMN IF NOT EXISTS all_emails jsonb;
ALTER TABLE pulse_agents ADD COLUMN IF NOT EXISTS previous_email text;
-- first_seen_at already exists on pulse_agents

-- first_seen_at already exists on pulse_listings
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS previous_asking_price numeric;
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS price_changed_at timestamptz;
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS previous_listing_type text;
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;

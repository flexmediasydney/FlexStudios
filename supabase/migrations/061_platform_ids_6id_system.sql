-- 061: 6-ID Platform Mapping System
-- Adds REA + Domain platform IDs to CRM entities and extends pulse_crm_mappings for agencies

-- ═══ CRM agents — store platform IDs for bidirectional linking ═══
ALTER TABLE agents ADD COLUMN IF NOT EXISTS rea_agent_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS domain_agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agents_rea_id ON agents(rea_agent_id) WHERE rea_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_domain_id ON agents(domain_agent_id) WHERE domain_agent_id IS NOT NULL;

-- ═══ CRM agencies — store platform IDs ═══
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS rea_agency_id TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS domain_agency_id TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS domain_profile_url TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS rea_profile_url TEXT;
CREATE INDEX IF NOT EXISTS idx_agencies_rea_id ON agencies(rea_agency_id) WHERE rea_agency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agencies_domain_id ON agencies(domain_agency_id) WHERE domain_agency_id IS NOT NULL;

-- ═══ pulse_agencies — add Domain agency ID ═══
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS domain_agency_id TEXT;
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS domain_profile_url TEXT;
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS profile_tier TEXT;
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS brand_colour TEXT;
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS total_sold_and_auctioned INTEGER;
ALTER TABLE pulse_agencies ADD COLUMN IF NOT EXISTS total_for_rent INTEGER;
CREATE INDEX IF NOT EXISTS idx_pulse_agencies_domain_id ON pulse_agencies(domain_agency_id) WHERE domain_agency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_agencies_rea_id ON pulse_agencies(rea_agency_id) WHERE rea_agency_id IS NOT NULL;

-- ═══ pulse_listings — add domain listing ID for future ═══
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS domain_listing_id TEXT;

-- ═══ pulse_crm_mappings — extend for agencies + domain IDs ═══
ALTER TABLE pulse_crm_mappings ADD COLUMN IF NOT EXISTS domain_id TEXT;
-- entity_type already supports 'agent', now also 'agency'
-- No schema change needed, just document the convention

-- Index for agency mappings
CREATE INDEX IF NOT EXISTS idx_pulse_crm_mappings_domain ON pulse_crm_mappings(domain_id, entity_type) WHERE domain_id IS NOT NULL;

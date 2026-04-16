-- 063: Pulse REA-Only Cleanup
-- Simplify from 10 data sources (REA+Domain) to 2 REA-only actors
-- Domain columns kept for historical data but code stops writing to them

-- 1. Disable Domain source configs
UPDATE pulse_source_configs SET is_enabled = false
WHERE source_id IN ('domain_agents', 'domain_agencies', 'domain_listings_buy', 'domain_listings_rent', 'domain_listings_sold');

-- 2. Remove Domain scheduled scrapes
DELETE FROM pulse_scheduled_scrapes
WHERE source_id IN ('domain_agents', 'domain_agencies', 'domain_listings_buy', 'domain_listings_rent', 'domain_listings_sold');

-- 3. Performance indexes for cross-enrichment lookups
CREATE INDEX IF NOT EXISTS idx_pulse_listings_agent_rea_id ON pulse_listings(agent_rea_id) WHERE agent_rea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_agents_rea_agent_id ON pulse_agents(rea_agent_id) WHERE rea_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_agents_full_name ON pulse_agents(lower(trim(full_name)));
CREATE INDEX IF NOT EXISTS idx_pulse_agencies_rea_agency_id ON pulse_agencies(rea_agency_id) WHERE rea_agency_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_listings_source_listing_id ON pulse_listings(source_listing_id) WHERE source_listing_id IS NOT NULL;

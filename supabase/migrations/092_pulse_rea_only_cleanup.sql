-- 092_pulse_rea_only_cleanup.sql
-- Finalise REA-only 2-actor architecture by removing dead Domain source config rows
-- and adding the cross-enrichment indexes that Step 7 of pulseDataSync relies on.
--
-- Rationale:
--   The pulseDataSync engine has been REA-only for some time (2 actors:
--   websift/realestateau for agent profiles + azzouzana/real-estate-au-scraper-pro
--   for all listings, linked by rea_agent_id). Two Domain source_config rows
--   (domain_agents, domain_agencies) still exist in pulse_source_configs with
--   is_enabled=false — they are dead weight in the UI and the cron dispatcher.
--
-- What this migration does:
--   1. Deletes disabled Domain source_config rows so the Data Sources tab no
--      longer renders them.
--   2. Creates supporting indexes for the rea_agent_id cross-enrichment join
--      in pulseDataSync Step 7 (email + photo bridging from listings to agents).
--
-- What this migration does NOT do:
--   - Drop Domain columns from pulse_agents / pulse_agencies / pulse_listings.
--     Historical Domain data stays readable. The application no longer writes
--     to these columns and the UI no longer reads them.

BEGIN;

-- 1. Remove disabled Domain source configs (keep nothing that references Domain)
DELETE FROM pulse_source_configs
WHERE source_id IN (
  'domain_agents',
  'domain_agencies',
  'domain_listings_buy',
  'domain_listings_rent',
  'domain_listings_sold',
  'fair_trading'
);

-- 2. Cross-enrichment indexes — Step 7 of pulseDataSync joins on these columns
--    at every sync run. Partial indexes keep them small (ignore NULLs).
CREATE INDEX IF NOT EXISTS idx_pulse_listings_agent_rea_id
  ON pulse_listings(agent_rea_id)
  WHERE agent_rea_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_agents_rea_agent_id
  ON pulse_agents(rea_agent_id)
  WHERE rea_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_listings_agency_rea_id
  ON pulse_listings(agency_rea_id)
  WHERE agency_rea_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_agencies_rea_agency_id
  ON pulse_agencies(rea_agency_id)
  WHERE rea_agency_id IS NOT NULL;

COMMIT;

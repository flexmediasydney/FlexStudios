-- ============================================================================
-- 047: Domain API Agent Monitor — schema additions
-- ============================================================================

-- 1. Add Domain/REA identifiers to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS domain_agent_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS domain_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS rea_url TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_domain_id ON agents(domain_agent_id) WHERE domain_agent_id IS NOT NULL;

-- 2. Add Domain listing tracking columns to external_listings
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS matched_project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS matched_project_title TEXT;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS domain_listing_id TEXT;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS has_floorplan BOOLEAN DEFAULT false;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS has_video BOOLEAN DEFAULT false;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS has_virtual_tour BOOLEAN DEFAULT false;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS media_urls JSONB DEFAULT '[]';
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS date_listed TIMESTAMPTZ;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS date_updated TIMESTAMPTZ;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS domain_raw JSONB;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS photo_quality_score INTEGER DEFAULT 0;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS headline TEXT;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS bedrooms INTEGER;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS bathrooms INTEGER;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS carspaces INTEGER;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS land_area_sqm NUMERIC;
ALTER TABLE external_listings ADD COLUMN IF NOT EXISTS display_price TEXT;

CREATE INDEX IF NOT EXISTS idx_external_listings_domain ON external_listings(domain_listing_id) WHERE domain_listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_listings_matched ON external_listings(matched_project_id) WHERE matched_project_id IS NOT NULL;

COMMENT ON COLUMN agents.domain_agent_id IS 'Domain.com.au agent ID (integer as text) for API lookups';
COMMENT ON COLUMN external_listings.photo_quality_score IS '0-100 score: photo count + resolution + floorplan + video weighted';

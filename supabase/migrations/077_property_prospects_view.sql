-- 077: Property Prospects view
--
-- Surfaces the core prospecting insight: properties WE'VE PHOTOGRAPHED
-- that are CURRENTLY LISTED by a DIFFERENT AGENT.
-- These are targets for case-study campaigns — show the new agent our
-- previous work vs their current media.
--
-- Uses LATERAL join to grab the most recent listing per property.

CREATE OR REPLACE VIEW property_prospects_v AS
SELECT
  pv.id,
  pv.property_key,
  pv.display_address,
  pv.suburb,
  pv.postcode,
  pv.latitude,
  pv.longitude,
  pv.hero_image,
  pv.bedrooms,
  pv.bathrooms,
  pv.parking,
  pv.property_type,
  pv.project_count,
  pv.listing_count,

  -- Our project context (most recent shoot at this address)
  p.id AS project_id,
  p.title AS project_title,
  p.shoot_date AS project_shoot_date,
  p.tonomo_package AS project_package_name,
  p.agent_id AS project_agent_id,
  p.agent_name AS project_agent_name,
  p.agency_id AS project_agency_id,
  a.rea_agent_id AS project_agent_rea_id,
  ag.name AS project_agency_name,

  -- The "prospect" — current listing with different agent
  l.id AS current_listing_id,
  l.source_listing_id AS current_source_listing_id,
  l.listing_type AS current_listing_type,
  l.listed_date AS current_listed_date,
  l.asking_price AS current_asking_price,
  l.sold_price AS current_sold_price,
  l.sold_date AS current_sold_date,
  l.agent_name AS prospect_agent_name,
  l.agent_rea_id AS prospect_agent_rea_id,
  l.agent_phone AS prospect_agent_phone,
  l.agency_name AS prospect_agency_name,
  l.agency_rea_id AS prospect_agency_rea_id,
  l.source_url AS prospect_listing_url,
  l.last_synced_at AS prospect_last_seen,

  -- How competitive? (how many of OUR previously shot properties is this
  -- agent now listing?)
  (SELECT count(DISTINCT pl.property_key) FROM pulse_listings pl
   WHERE pl.agent_rea_id = l.agent_rea_id
     AND EXISTS (SELECT 1 FROM projects pr WHERE pr.property_key = pl.property_key)
  ) AS prospect_agent_our_properties_count,

  -- Is the prospect agent in our CRM already?
  (SELECT id FROM agents WHERE rea_agent_id = l.agent_rea_id LIMIT 1) AS prospect_agent_crm_id

FROM property_full_v pv
INNER JOIN projects p ON p.property_key = pv.property_key
  AND p.status NOT IN ('cancelled', 'archived')
LEFT JOIN agents a ON a.id = p.agent_id
LEFT JOIN agencies ag ON ag.id = p.agency_id
INNER JOIN LATERAL (
  SELECT * FROM pulse_listings
  WHERE property_key = pv.property_key
  ORDER BY listed_date DESC NULLS LAST, last_synced_at DESC NULLS LAST
  LIMIT 1
) l ON true
WHERE pv.listing_count > 0
  AND pv.project_count > 0
  AND l.agent_rea_id IS NOT NULL
  AND a.rea_agent_id IS NOT NULL
  AND l.agent_rea_id::text != a.rea_agent_id::text
ORDER BY l.listed_date DESC NULLS LAST, l.last_synced_at DESC NULLS LAST;

GRANT SELECT ON property_prospects_v TO authenticated, anon, service_role;

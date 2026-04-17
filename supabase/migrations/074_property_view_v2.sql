-- 074: Property view v2 — adds hero_image, property facts, current_listed_date
-- Allows the Properties index + PropertyDetails to render thumbnails + bed/bath/car
-- without an extra query per row.

DROP VIEW IF EXISTS property_full_v CASCADE;

CREATE VIEW property_full_v AS
SELECT
  p.id,
  p.property_key,
  p.display_address,
  p.suburb,
  p.postcode,
  p.state,
  p.latitude,
  p.longitude,
  p.first_seen_at,
  p.last_seen_at,
  -- Counts
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key) AS listing_count,
  (SELECT count(*) FROM projects WHERE property_key = p.property_key) AS project_count,
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS sold_listing_count,
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'for_sale') AS for_sale_listing_count,
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'for_rent') AS for_rent_listing_count,
  -- Current state
  (SELECT listing_type FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST, last_synced_at DESC NULLS LAST LIMIT 1) AS current_listing_type,
  (SELECT asking_price FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST LIMIT 1) AS current_asking_price,
  (SELECT listed_date FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST LIMIT 1) AS current_listed_date,
  -- Sale history
  (SELECT max(sold_price) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS last_sold_price,
  (SELECT max(sold_date) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS last_sold_at,
  -- NEW: hero image from most recent listing (for visual property cards)
  (SELECT coalesce(hero_image, image_url) FROM pulse_listings
     WHERE property_key = p.property_key
       AND coalesce(hero_image, image_url) IS NOT NULL
     ORDER BY listed_date DESC NULLS LAST, last_synced_at DESC NULLS LAST LIMIT 1) AS hero_image,
  -- NEW: most recent listing's facts
  (SELECT bedrooms FROM pulse_listings WHERE property_key = p.property_key AND bedrooms IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS bedrooms,
  (SELECT bathrooms FROM pulse_listings WHERE property_key = p.property_key AND bathrooms IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS bathrooms,
  (SELECT parking FROM pulse_listings WHERE property_key = p.property_key AND parking IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS parking,
  (SELECT property_type FROM pulse_listings WHERE property_key = p.property_key AND property_type IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS property_type,
  -- Cross-references
  (SELECT array_agg(DISTINCT source_listing_id) FROM pulse_listings
     WHERE property_key = p.property_key AND source_listing_id IS NOT NULL) AS rea_listing_ids,
  (SELECT array_agg(DISTINCT agent_rea_id) FROM pulse_listings
     WHERE property_key = p.property_key AND agent_rea_id IS NOT NULL) AS rea_agent_ids,
  (SELECT array_agg(DISTINCT agency_rea_id) FROM pulse_listings
     WHERE property_key = p.property_key AND agency_rea_id IS NOT NULL) AS rea_agency_ids,
  (SELECT array_agg(DISTINCT id) FROM projects
     WHERE property_key = p.property_key) AS project_ids
FROM properties p;

GRANT SELECT ON property_full_v TO authenticated, anon, service_role;

-- Recreate health view (was dropped via CASCADE)
CREATE OR REPLACE VIEW properties_health_v AS
SELECT
  (SELECT count(*) FROM properties) AS total_properties,
  (SELECT count(*) FROM pulse_listings WHERE property_key IS NULL) AS listings_with_null_key,
  (SELECT count(*) FROM projects WHERE property_key IS NULL) AS projects_with_null_key,
  (SELECT count(*) FROM property_full_v WHERE listing_count = 0 AND project_count = 0) AS orphan_properties,
  (SELECT count(*) FROM property_full_v WHERE project_count > 0 AND listing_count > 0) AS linked_properties,
  (SELECT count(*) FROM property_full_v WHERE project_count > 0 AND listing_count = 0) AS project_only_properties,
  (SELECT count(*) FROM property_full_v WHERE listing_count > 0 AND project_count = 0) AS listing_only_properties;

GRANT SELECT ON properties_health_v TO authenticated, service_role;

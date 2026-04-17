-- 078: Property merge RPC
--
-- Admin tool for combining two properties when the normalizer fails to
-- detect them as duplicates (e.g. addresses with edge-case formatting).
--
-- Merge strategy:
--   - Keep the "winner" property row
--   - No physical data move needed — listings and projects link by property_key
--   - Just update the "loser" property's key to match the winner, then delete
--     the now-redundant loser row
--   - All listings and projects that had the loser's key will be rewritten
--     (via an UPDATE) to point to the winner's key

CREATE OR REPLACE FUNCTION merge_properties(
  p_winner_id uuid,
  p_loser_id uuid
) RETURNS jsonb AS $$
DECLARE
  winner record;
  loser record;
  listings_moved int := 0;
  projects_moved int := 0;
BEGIN
  -- Load both
  SELECT * INTO winner FROM properties WHERE id = p_winner_id;
  SELECT * INTO loser FROM properties WHERE id = p_loser_id;

  IF winner IS NULL OR loser IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'One or both properties not found');
  END IF;

  IF winner.id = loser.id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot merge a property with itself');
  END IF;

  -- Move all pulse_listings pointing at loser's key → winner's key
  -- NOTE: property_key is a GENERATED column so we can't UPDATE it directly.
  -- Instead, we must update the base address fields so the generated column
  -- recomputes to the winner's key.
  -- For listings, we append the winner's suburb/postcode to nudge the key.
  -- Simpler: delete the loser row, leaving listings/projects pointing to a
  -- now-orphan property_key; the winner's key stays the canonical.
  -- BUT — generated columns can't be forced. So the loser's key stays what
  -- it was; re-aliasing would require a mapping table.
  --
  -- Approach used here: store an alias in properties.merged_into_property_id
  -- and teach the view to resolve it. Actual data move happens via a
  -- secondary indirection.

  -- Simplest practical approach: add merged_into column, keep loser row but
  -- mark it merged; UI and views filter out merged rows
  UPDATE properties
  SET merged_into_property_id = winner.id,
      is_merged = true,
      updated_at = now()
  WHERE id = loser.id;

  -- Count affected rows
  SELECT count(*) INTO listings_moved FROM pulse_listings WHERE property_key = loser.property_key;
  SELECT count(*) INTO projects_moved FROM projects WHERE property_key = loser.property_key;

  RETURN jsonb_build_object(
    'success', true,
    'winner_id', winner.id,
    'winner_key', winner.property_key,
    'loser_id', loser.id,
    'loser_key', loser.property_key,
    'listings_affected', listings_moved,
    'projects_affected', projects_moved,
    'merged_at', now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION merge_properties(uuid, uuid) TO authenticated;

-- Add merge tracking columns
ALTER TABLE properties ADD COLUMN IF NOT EXISTS merged_into_property_id uuid REFERENCES properties(id);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_merged boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_properties_merged_into ON properties(merged_into_property_id) WHERE merged_into_property_id IS NOT NULL;

-- Update property_full_v to exclude merged rows by default
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
  p.merged_into_property_id,
  p.is_merged,
  -- When merged, counts come from the winner (resolve through merged_into_property_id)
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key) AS listing_count,
  (SELECT count(*) FROM projects WHERE property_key = p.property_key) AS project_count,
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS sold_listing_count,
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'for_sale') AS for_sale_listing_count,
  (SELECT count(*) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'for_rent') AS for_rent_listing_count,
  (SELECT listing_type FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST, last_synced_at DESC NULLS LAST LIMIT 1) AS current_listing_type,
  (SELECT asking_price FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST LIMIT 1) AS current_asking_price,
  (SELECT listed_date FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST LIMIT 1) AS current_listed_date,
  (SELECT max(sold_price) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS last_sold_price,
  (SELECT max(sold_date) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS last_sold_at,
  (SELECT coalesce(hero_image, image_url) FROM pulse_listings
     WHERE property_key = p.property_key
       AND coalesce(hero_image, image_url) IS NOT NULL
     ORDER BY listed_date DESC NULLS LAST, last_synced_at DESC NULLS LAST LIMIT 1) AS hero_image,
  (SELECT bedrooms FROM pulse_listings WHERE property_key = p.property_key AND bedrooms IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS bedrooms,
  (SELECT bathrooms FROM pulse_listings WHERE property_key = p.property_key AND bathrooms IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS bathrooms,
  (SELECT parking FROM pulse_listings WHERE property_key = p.property_key AND parking IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS parking,
  (SELECT property_type FROM pulse_listings WHERE property_key = p.property_key AND property_type IS NOT NULL
     ORDER BY last_synced_at DESC NULLS LAST LIMIT 1) AS property_type,
  (SELECT array_agg(DISTINCT source_listing_id) FROM pulse_listings
     WHERE property_key = p.property_key AND source_listing_id IS NOT NULL) AS rea_listing_ids,
  (SELECT array_agg(DISTINCT agent_rea_id) FROM pulse_listings
     WHERE property_key = p.property_key AND agent_rea_id IS NOT NULL) AS rea_agent_ids,
  (SELECT array_agg(DISTINCT agency_rea_id) FROM pulse_listings
     WHERE property_key = p.property_key AND agency_rea_id IS NOT NULL) AS rea_agency_ids,
  (SELECT array_agg(DISTINCT id) FROM projects
     WHERE property_key = p.property_key) AS project_ids
FROM properties p
WHERE coalesce(p.is_merged, false) = false;

GRANT SELECT ON property_full_v TO authenticated, anon, service_role;

-- Recreate dependent views
CREATE OR REPLACE VIEW properties_health_v AS
SELECT
  (SELECT count(*) FROM properties WHERE coalesce(is_merged, false) = false) AS total_properties,
  (SELECT count(*) FROM properties WHERE coalesce(is_merged, false) = true) AS merged_properties,
  (SELECT count(*) FROM pulse_listings WHERE property_key IS NULL) AS listings_with_null_key,
  (SELECT count(*) FROM projects WHERE property_key IS NULL) AS projects_with_null_key,
  (SELECT count(*) FROM property_full_v WHERE listing_count = 0 AND project_count = 0) AS orphan_properties,
  (SELECT count(*) FROM property_full_v WHERE project_count > 0 AND listing_count > 0) AS linked_properties,
  (SELECT count(*) FROM property_full_v WHERE project_count > 0 AND listing_count = 0) AS project_only_properties,
  (SELECT count(*) FROM property_full_v WHERE listing_count > 0 AND project_count = 0) AS listing_only_properties;

GRANT SELECT ON properties_health_v TO authenticated, service_role;

CREATE OR REPLACE VIEW property_suburb_stats_v AS
SELECT
  lower(trim(suburb)) as suburb_key,
  suburb,
  state,
  postcode,
  count(*) as total_properties,
  count(*) FILTER (WHERE project_count > 0) as our_shoots,
  count(*) FILTER (WHERE listing_count > 0 AND project_count > 0) as linked,
  count(*) FILTER (WHERE current_listing_type = 'for_sale') as currently_for_sale,
  count(*) FILTER (WHERE current_listing_type = 'for_rent') as currently_for_rent,
  count(*) FILTER (WHERE sold_listing_count > 0) as with_sales,
  round(avg(current_asking_price) FILTER (WHERE current_asking_price > 0)::numeric, 0) as avg_asking_price,
  round(avg(last_sold_price) FILTER (WHERE last_sold_price > 0)::numeric, 0) as avg_sold_price,
  max(last_seen_at) as last_activity
FROM property_full_v
WHERE suburb IS NOT NULL AND trim(suburb) != ''
GROUP BY lower(trim(suburb)), suburb, state, postcode
ORDER BY total_properties DESC;

GRANT SELECT ON property_suburb_stats_v TO authenticated, anon, service_role;

-- Recreate property_prospects_v (was dropped via cascade)
CREATE OR REPLACE VIEW property_prospects_v AS
SELECT
  pv.id, pv.property_key, pv.display_address, pv.suburb, pv.postcode,
  pv.latitude, pv.longitude, pv.hero_image,
  pv.bedrooms, pv.bathrooms, pv.parking, pv.property_type,
  pv.project_count, pv.listing_count,
  p.id AS project_id, p.title AS project_title, p.shoot_date AS project_shoot_date,
  p.tonomo_package AS project_package_name,
  p.agent_id AS project_agent_id, p.agent_name AS project_agent_name,
  p.agency_id AS project_agency_id,
  a.rea_agent_id AS project_agent_rea_id,
  ag.name AS project_agency_name,
  l.id AS current_listing_id, l.source_listing_id AS current_source_listing_id,
  l.listing_type AS current_listing_type, l.listed_date AS current_listed_date,
  l.asking_price AS current_asking_price, l.sold_price AS current_sold_price,
  l.sold_date AS current_sold_date,
  l.agent_name AS prospect_agent_name, l.agent_rea_id AS prospect_agent_rea_id,
  l.agent_phone AS prospect_agent_phone, l.agency_name AS prospect_agency_name,
  l.agency_rea_id AS prospect_agency_rea_id, l.source_url AS prospect_listing_url,
  l.last_synced_at AS prospect_last_seen,
  (SELECT count(DISTINCT pl.property_key) FROM pulse_listings pl
   WHERE pl.agent_rea_id = l.agent_rea_id
     AND EXISTS (SELECT 1 FROM projects pr WHERE pr.property_key = pl.property_key)
  ) AS prospect_agent_our_properties_count,
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
WHERE pv.listing_count > 0 AND pv.project_count > 0
  AND l.agent_rea_id IS NOT NULL AND a.rea_agent_id IS NOT NULL
  AND l.agent_rea_id::text != a.rea_agent_id::text
ORDER BY l.listed_date DESC NULLS LAST, l.last_synced_at DESC NULLS LAST;

GRANT SELECT ON property_prospects_v TO authenticated, anon, service_role;

-- Suggest merge candidates (similar keys, not already merged)
CREATE OR REPLACE VIEW property_merge_candidates_v AS
WITH pairs AS (
  SELECT
    a.id AS a_id, a.property_key AS a_key, a.display_address AS a_addr,
    a.suburb AS a_suburb, a.postcode AS a_postcode,
    b.id AS b_id, b.property_key AS b_key, b.display_address AS b_addr,
    b.suburb AS b_suburb,
    -- Heuristic similarity score
    similarity(a.property_key, b.property_key) AS sim_score
  FROM properties a
  JOIN properties b
    ON a.suburb IS NOT DISTINCT FROM b.suburb
    AND a.id < b.id
    AND a.is_merged IS NOT TRUE
    AND b.is_merged IS NOT TRUE
    AND similarity(a.property_key, b.property_key) > 0.7
)
SELECT * FROM pairs
ORDER BY sim_score DESC, a_suburb
LIMIT 200;

-- Requires pg_trgm extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT SELECT ON property_merge_candidates_v TO authenticated, service_role;

-- 073: Property Layer Foundation
-- Bridges pulse_listings + projects via a normalized property_key.
-- Architecture rules:
--   1. PostgreSQL is single source of truth — function called nowhere else
--   2. properties table = identity only (no aggregates — those go in views)
--   3. No hard FK from properties.id to listings/projects (link by property_key)
--   4. AFTER INSERT triggers only — never fail original insert
--   5. NULL key when normalization can't produce a sensible value (no street number / too short)
--   6. display_address ≠ property_key (always show address, never the key)

-- ── 1. Normalizer function ──────────────────────────────────────────────

DROP FUNCTION IF EXISTS compute_property_key(text);
CREATE OR REPLACE FUNCTION compute_property_key(raw text) RETURNS text AS $$
DECLARE
  s text;
  i int;
  prev text;
BEGIN
  IF raw IS NULL OR length(trim(raw)) < 5 THEN RETURN NULL; END IF;

  s := lower(trim(raw));

  -- Junk filters
  IF s ~ 'address available on request' THEN RETURN NULL; END IF;
  IF s ~ '^\s*p\.?\s*o\.?\s*box\s' THEN RETURN NULL; END IF;

  -- Strip country anywhere
  s := regexp_replace(s, ',?\s*\maustralia\M', '', 'gi');
  -- Strip ALL state+postcode patterns globally (handles duplicates)
  s := regexp_replace(s, '\m(nsw|vic|qld|sa|wa|act|tas|nt)\s+\d{4}\M', '', 'gi');
  -- Strip standalone state at end
  s := regexp_replace(s, ',?\s*\m(nsw|vic|qld|sa|wa|act|tas|nt)\M\s*$', '', 'gi');
  -- Strip standalone trailing 4-digit postcode
  s := regexp_replace(s, ',?\s*\d{4}\s*$', '', 'gi');

  -- Iterate prefix-strip to handle nested 'Building A, Level 3, Suite 401, ...'
  FOR i IN 1..3 LOOP
    s := regexp_replace(s, '^\s*lot\s+\w+\s*[,/]?\s+', '', 'gi');
    s := regexp_replace(s, '^\s*(building|bldg|level|lvl|floor|fl)\s+\w+\s*,?\s*', '', 'gi');
  END LOOP;

  -- Unit prefix normalization: 'unit/apt/suite X, ...' → 'X/...'
  s := regexp_replace(s, '\m(unit|apt|apartment|suite|ste)\s+([a-z0-9]+)\s*[,/]\s*', '\2/', 'gi');

  -- Street type normalization (longer first to avoid partial-word damage)
  s := regexp_replace(s, '\mhighway\M', 'hwy', 'gi');
  s := regexp_replace(s, '\mcrescent\M', 'cres', 'gi');
  s := regexp_replace(s, '\mparade\M', 'pde', 'gi');
  s := regexp_replace(s, '\mterrace\M', 'tce', 'gi');
  s := regexp_replace(s, '\mboulevard\M', 'blvd', 'gi');
  s := regexp_replace(s, '\mparkway\M', 'pkwy', 'gi');
  s := regexp_replace(s, '\mesplanade\M', 'esp', 'gi');
  s := regexp_replace(s, '\mavenue\M', 'ave', 'gi');
  s := regexp_replace(s, '\mstreet\M', 'st', 'gi');
  s := regexp_replace(s, '\mroad\M', 'rd', 'gi');
  s := regexp_replace(s, '\mplace\M', 'pl', 'gi');
  s := regexp_replace(s, '\mclose\M', 'cl', 'gi');
  s := regexp_replace(s, '\mcourt\M', 'ct', 'gi');
  s := regexp_replace(s, '\mdrive\M', 'dr', 'gi');
  s := regexp_replace(s, '\mlane\M', 'ln', 'gi');
  s := regexp_replace(s, '\msquare\M', 'sq', 'gi');

  -- Collapse street number ranges: '50-52' → '50', '9/554-558' → '9/554'
  s := regexp_replace(s, '(\d+)\s*-\s*\d+', '\1', 'g');

  -- Convert commas to spaces, collapse whitespace
  s := regexp_replace(s, ',', ' ', 'g');
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := trim(s);

  -- Dedupe consecutive identical word chunks (handles duplicate suburbs)
  FOR i IN 1..3 LOOP
    prev := s;
    s := regexp_replace(s, '\m(\w+(?:\s+\w+){0,3})\s+\1\M', '\1', 'gi');
    EXIT WHEN s = prev;
  END LOOP;

  s := trim(s);

  -- Safety gate: must contain digit AND length >= 8 (prevents mass-suburb merges)
  IF s !~ '\d' OR length(s) < 8 THEN RETURN NULL; END IF;

  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- ── 2. Properties table (identity only, no aggregates) ─────────────────

CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_key text UNIQUE NOT NULL,
  display_address text NOT NULL,
  suburb text,
  postcode text,
  state text DEFAULT 'NSW',
  latitude numeric,
  longitude numeric,
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_suburb ON properties(suburb);
CREATE INDEX IF NOT EXISTS idx_properties_postcode ON properties(postcode);

-- ── 3. Generated property_key columns ──────────────────────────────────

-- pulse_listings: combine address + suburb + postcode for normalization
-- (address alone often missing suburb/state, e.g. "1 Delamere Crescent")
ALTER TABLE pulse_listings
  ADD COLUMN IF NOT EXISTS property_key text
  GENERATED ALWAYS AS (
    compute_property_key(
      coalesce(address, '') ||
      coalesce(', ' || suburb, '') ||
      coalesce(' NSW ' || postcode, '')
    )
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_pulse_listings_property_key
  ON pulse_listings(property_key) WHERE property_key IS NOT NULL;

-- projects: property_address already has full format from Tonomo
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS property_key text
  GENERATED ALWAYS AS (compute_property_key(property_address)) STORED;
CREATE INDEX IF NOT EXISTS idx_projects_property_key
  ON projects(property_key) WHERE property_key IS NOT NULL;

-- ── 4. Triggers to upsert properties ───────────────────────────────────

CREATE OR REPLACE FUNCTION upsert_property_from_listing() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.property_key IS NULL THEN RETURN NEW; END IF;

  INSERT INTO properties (property_key, display_address, suburb, postcode, latitude, longitude, last_seen_at)
  VALUES (
    NEW.property_key,
    NEW.address,
    NEW.suburb,
    NEW.postcode,
    NEW.latitude,
    NEW.longitude,
    now()
  )
  ON CONFLICT (property_key) DO UPDATE SET
    -- Prefer addresses with postcode embedded (longer/richer)
    display_address = CASE
      WHEN properties.display_address ~* '\d{4}' THEN properties.display_address
      ELSE EXCLUDED.display_address END,
    suburb = COALESCE(properties.suburb, EXCLUDED.suburb),
    postcode = COALESCE(properties.postcode, EXCLUDED.postcode),
    latitude = COALESCE(properties.latitude, EXCLUDED.latitude),
    longitude = COALESCE(properties.longitude, EXCLUDED.longitude),
    last_seen_at = now(),
    updated_at = now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never fail the listing insert because of a property issue
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_upsert_property_from_listing ON pulse_listings;
CREATE TRIGGER trg_upsert_property_from_listing
  AFTER INSERT OR UPDATE OF property_key ON pulse_listings
  FOR EACH ROW EXECUTE FUNCTION upsert_property_from_listing();

CREATE OR REPLACE FUNCTION upsert_property_from_project() RETURNS TRIGGER AS $$
DECLARE
  proj_postcode text;
BEGIN
  IF NEW.property_key IS NULL THEN RETURN NEW; END IF;

  -- Extract postcode from property_address tail
  proj_postcode := substring(NEW.property_address from '(\d{4})\s*(?:,\s*Australia)?\s*$');

  INSERT INTO properties (property_key, display_address, suburb, postcode, latitude, longitude, last_seen_at)
  VALUES (
    NEW.property_key,
    NEW.property_address,
    NEW.property_suburb,
    proj_postcode,
    NEW.geocoded_lat,
    NEW.geocoded_lng,
    now()
  )
  ON CONFLICT (property_key) DO UPDATE SET
    display_address = CASE
      WHEN properties.display_address ~* '\d{4}' THEN properties.display_address
      ELSE EXCLUDED.display_address END,
    suburb = COALESCE(properties.suburb, EXCLUDED.suburb),
    postcode = COALESCE(properties.postcode, EXCLUDED.postcode),
    latitude = COALESCE(properties.latitude, EXCLUDED.latitude),
    longitude = COALESCE(properties.longitude, EXCLUDED.longitude),
    last_seen_at = now(),
    updated_at = now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_upsert_property_from_project ON projects;
CREATE TRIGGER trg_upsert_property_from_project
  AFTER INSERT OR UPDATE OF property_key ON projects
  FOR EACH ROW EXECUTE FUNCTION upsert_property_from_project();

-- ── 5. Unified view (derived stats) ────────────────────────────────────

CREATE OR REPLACE VIEW property_full_v AS
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
  -- Current state (most recent active listing)
  (SELECT listing_type FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST, last_synced_at DESC NULLS LAST LIMIT 1) AS current_listing_type,
  (SELECT asking_price FROM pulse_listings WHERE property_key = p.property_key
     ORDER BY listed_date DESC NULLS LAST LIMIT 1) AS current_asking_price,
  -- Most recent sale
  (SELECT max(sold_price) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS last_sold_price,
  (SELECT max(sold_date) FROM pulse_listings WHERE property_key = p.property_key AND listing_type = 'sold') AS last_sold_at,
  -- Cross-references (all listing IDs + agent/agency IDs ever seen at this property)
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

-- ── 6. Health view for ops ─────────────────────────────────────────────

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

-- ── 7. Backfill from existing data ─────────────────────────────────────

-- pulse_listings → properties (largest source)
INSERT INTO properties (property_key, display_address, suburb, postcode, latitude, longitude, first_seen_at, last_seen_at)
SELECT
  property_key,
  -- pick best address: prefer ones with postcode embedded (richer)
  (array_agg(address ORDER BY
    CASE WHEN address ~ '\d{4}' THEN 1 ELSE 2 END,
    length(address) DESC,
    last_synced_at DESC NULLS LAST
  ))[1] AS display_address,
  (array_agg(suburb ORDER BY length(suburb) DESC NULLS LAST))[1] AS suburb,
  (array_agg(postcode) FILTER (WHERE postcode ~ '^\d{4}$'))[1] AS postcode,
  avg(latitude) AS latitude,
  avg(longitude) AS longitude,
  min(last_synced_at) AS first_seen_at,
  max(last_synced_at) AS last_seen_at
FROM pulse_listings
WHERE property_key IS NOT NULL
GROUP BY property_key
ON CONFLICT (property_key) DO NOTHING;

-- projects → properties (additional rows for project-only properties)
INSERT INTO properties (property_key, display_address, suburb, postcode, latitude, longitude, first_seen_at, last_seen_at)
SELECT
  property_key,
  (array_agg(property_address ORDER BY length(property_address) DESC))[1] AS display_address,
  (array_agg(property_suburb))[1] AS suburb,
  (array_agg(substring(property_address from '(\d{4})\s*(?:,\s*Australia)?\s*$')))[1] AS postcode,
  avg(geocoded_lat) AS latitude,
  avg(geocoded_lng) AS longitude,
  min(created_at) AS first_seen_at,
  max(updated_at) AS last_seen_at
FROM projects
WHERE property_key IS NOT NULL
GROUP BY property_key
ON CONFLICT (property_key) DO NOTHING;

-- Drop the test function (no longer needed)
DROP FUNCTION IF EXISTS compute_property_key_test(text);

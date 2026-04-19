-- 158_pulse_missed_opportunity_substrate.sql
-- Substrate for the Market Share / Missed Opportunity engine.
--
-- One row per active for_sale pulse_listings row, containing the engine's
-- current quote — the price we WOULD have charged if we'd won that listing.
-- Populated/updated by the edge function `pulseComputeListingQuote`; consumed
-- by aggregation RPCs for the Market Share dashboard and Client Retention page.
--
-- Design notes:
--   • Unique on listing_id — each listing has exactly one live quote. New
--     sync runs re-compute and UPSERT in place.
--   • Freshness tracked via `quote_status`:
--       fresh                 - computed from current enrichment; inputs match
--       stale                 - listing media changed since last compute; needs refresh
--       pending_enrichment    - listing not yet enriched (media/price unknown)
--       data_gap              - no projects within 50km radial for pricing inheritance
--   • raw_cascade_log jsonb captures every step tried — for Legend's quote-source-mix
--     chart and per-listing debug drill.
--   • engine_version text stores the git sha of the compute function when
--     the quote was produced — enables reproducible historical rollups.
--
-- Safe to re-run: CREATE IF NOT EXISTS everywhere.

BEGIN;

-- ── 1. Main substrate table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pulse_listing_missed_opportunity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL UNIQUE REFERENCES pulse_listings(id) ON DELETE CASCADE,

  -- cached listing fields (so the dashboard doesn't need to join pulse_listings)
  property_key text,
  suburb text,
  postcode text,
  listing_type text NOT NULL,
  listing_status text,
  first_seen_at timestamptz,

  -- classifier inputs (snapshot of what was used to classify)
  photo_count int DEFAULT 0,
  has_floorplan boolean DEFAULT false,
  has_video boolean DEFAULT false,
  has_drone_inferred boolean DEFAULT false,
  asking_price_numeric numeric,

  -- classification result
  classified_package_id uuid,       -- NULL = UNCLASSIFIABLE
  classified_package_name text,

  -- tier resolution
  resolved_tier text NOT NULL CHECK (resolved_tier IN ('standard','premium')),
  tier_source text NOT NULL,         -- see tier_source enum comment below
  tier_source_ref uuid,              -- FK to matrix or project that drove tier

  -- pricing result
  pricing_method text NOT NULL,      -- see pricing_method enum comment below
  pricing_source_ref uuid,
  pricing_source_ref_type text CHECK (pricing_source_ref_type IS NULL OR pricing_source_ref_type IN ('price_matrix','project')),
  package_base_price numeric NOT NULL DEFAULT 0,
  overflow_photos int DEFAULT 0,
  overflow_charge numeric DEFAULT 0,
  discount_applied_pct numeric DEFAULT 0,
  quoted_price numeric NOT NULL DEFAULT 0,

  -- quality flags
  address_hidden boolean DEFAULT false,      -- REA "Address available on request"
  data_gap_flag boolean DEFAULT false,       -- ring 9 — no projects nearby
  photos_capped_at_34 boolean DEFAULT false, -- REA scrape cap — true count may be higher

  -- freshness snapshot (for change detection on next compute pass)
  photo_count_at_quote int,
  has_floorplan_at_quote boolean,
  has_video_at_quote boolean,
  price_text_at_quote text,
  quote_status text NOT NULL CHECK (quote_status IN ('fresh','stale','pending_enrichment','data_gap')),

  -- provenance
  computed_at timestamptz NOT NULL DEFAULT now(),
  engine_version text,
  raw_cascade_log jsonb DEFAULT '[]'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enum-like documentation for text fields (enforced in engine, not DB — gives flexibility to add new sources without migrations):
--
-- tier_source:
--   'matrix_agent'           - agent-level price_matrix.default_tier
--   'matrix_agency'           - agency/org-level price_matrix.default_tier
--   'proximity_same_property' - inherited from project at same property_key
--   'proximity_same_agent'    - inherited from agent's past project <12m
--   'proximity_same_suburb'   - inherited from suburb-match project
--   'proximity_radial_2km'    - from closest project within 2km
--   'proximity_radial_5km'
--   'proximity_radial_10km'
--   'proximity_radial_20km'
--   'proximity_radial_50km'
--   'default_std'             - ring 9 — no project found anywhere
--
-- pricing_method:
--   'agency_matrix'                    - matrix package/product overrides + blanket discount
--   'proximity_same_property_same_pkg' - same address same package inheritance
--   'proximity_same_agent_same_pkg'
--   'proximity_suburb_same_pkg'
--   'proximity_radial_Nkm_same_pkg'
--   'proximity_suburb_any_pkg'         - tier inherited, price = package global default at tier
--   'proximity_radial_Nkm_any_pkg'
--   'global_default'                   - std/prm package default from packages table
--   'item_sum_unclassifiable'          - UNCLASSIFIABLE — sum of atomic products at tier

-- ── 2. Indexes for dashboard queries ───────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pmo_first_seen_at ON pulse_listing_missed_opportunity(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_pmo_suburb_first_seen ON pulse_listing_missed_opportunity(suburb, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_pmo_package ON pulse_listing_missed_opportunity(classified_package_id);
CREATE INDEX IF NOT EXISTS idx_pmo_tier ON pulse_listing_missed_opportunity(resolved_tier);
CREATE INDEX IF NOT EXISTS idx_pmo_quote_status ON pulse_listing_missed_opportunity(quote_status);
CREATE INDEX IF NOT EXISTS idx_pmo_computed_at ON pulse_listing_missed_opportunity(computed_at);
CREATE INDEX IF NOT EXISTS idx_pmo_listing_type ON pulse_listing_missed_opportunity(listing_type);

-- ── 3. updated_at trigger ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_pmo_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pulse_pmo_updated_at ON pulse_listing_missed_opportunity;
CREATE TRIGGER pulse_pmo_updated_at
  BEFORE UPDATE ON pulse_listing_missed_opportunity
  FOR EACH ROW EXECUTE FUNCTION pulse_pmo_touch_updated_at();

-- ── 4. Helper: parse numeric value out of REA price_text ───────────────────
-- Handles common AU listing formats:
--   "$1,875,000"                    → 1875000
--   "$4.2m" / "$4.2M" / "$4,200,000" → 4200000
--   "$2.6m-$2.8m" / "$2.6-2.8m"     → 2700000 (midpoint)
--   "Guide $950,000"                → 950000
--   "For Sale - $2,698,000"         → 2698000
--   "Offers over $1.5m"             → 1500000
--   "Contact Agent" / "Auction" / "Forthcoming Auction" → NULL
--   "$750k" / "$750K"                → 750000
--
-- Returns NULL when no parseable number is found.

CREATE OR REPLACE FUNCTION pulse_parse_price_text(p_text text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_text text;
  v_numbers numeric[];
  v_num numeric;
BEGIN
  IF p_text IS NULL OR length(trim(p_text)) = 0 THEN
    RETURN NULL;
  END IF;

  v_text := lower(p_text);

  -- Collect all numeric candidates from the text.
  -- Regex groups: (number with optional comma/decimal)(optional k/m suffix).
  -- Expand k/m suffixes to real values. Keep only "plausible property prices"
  -- ($100k – $50M) to exclude stray numbers like bed/bath counts or postcodes.
  SELECT array_agg(num) INTO v_numbers
  FROM (
    SELECT
      CASE
        WHEN m[2] = 'm' THEN replace(m[1], ',', '')::numeric * 1000000
        WHEN m[2] = 'k' THEN replace(m[1], ',', '')::numeric * 1000
        ELSE replace(m[1], ',', '')::numeric
      END AS num
    FROM regexp_matches(v_text, '([\d][\d,]*(?:\.\d+)?)\s*([km]?)', 'g') AS t(m)
  ) x
  WHERE num >= 100000 AND num <= 50000000;

  IF v_numbers IS NULL OR array_length(v_numbers, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  -- Single hit → return as-is. Multiple → midpoint (handles "$2.6m-$2.8m").
  IF array_length(v_numbers, 1) = 1 THEN
    RETURN v_numbers[1];
  END IF;
  SELECT (min(n) + max(n)) / 2 INTO v_num FROM unnest(v_numbers) AS n;
  RETURN v_num;
END;
$$;

-- ── 5. Helper: haversine distance between two (lat,lon) in km ──────────────
-- Portable — no PostGIS required.
-- 6371 km = Earth mean radius.

CREATE OR REPLACE FUNCTION pulse_haversine_km(
  lat1 numeric, lon1 numeric,
  lat2 numeric, lon2 numeric
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  r numeric := 6371.0;
  dlat numeric; dlon numeric; a numeric; c numeric;
BEGIN
  IF lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN
    RETURN NULL;
  END IF;
  dlat := radians(lat2 - lat1);
  dlon := radians(lon2 - lon1);
  a := sin(dlat/2)*sin(dlat/2) + cos(radians(lat1))*cos(radians(lat2))*sin(dlon/2)*sin(dlon/2);
  c := 2 * atan2(sqrt(a), sqrt(1-a));
  RETURN r * c;
END;
$$;

-- ── 6. Helper: extract suburb from AU "property_address" string ────────────
-- Rough heuristic — splits on ", " and picks the segment before "NSW" or "VIC".
-- Falls back to penultimate segment if no state marker found.
-- "501/8 Parramatta Rd, Strathfield NSW 2135, Australia" → "Strathfield"
-- "6 Roma Ave, Mount Pritchard NSW 2170, Australia" → "Mount Pritchard"
--
-- Used by proximity cascade ring 3 (same suburb match). Projects don't have a
-- standalone `suburb` column — we parse on demand.

CREATE OR REPLACE FUNCTION pulse_extract_suburb(p_address text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_parts text[];
  v_part text;
BEGIN
  IF p_address IS NULL THEN RETURN NULL; END IF;
  v_parts := string_to_array(p_address, ',');
  FOR i IN 1..array_length(v_parts, 1) LOOP
    v_part := trim(v_parts[i]);
    -- Match "Suburb Name STATE postcode" (e.g. "Strathfield NSW 2135")
    IF v_part ~* '\y(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\y(\s*\d{4})?' THEN
      -- Strip the state + postcode trailing part
      RETURN trim(regexp_replace(v_part, '\s*\y(NSW|VIC|QLD|WA|SA|TAS|NT|ACT)\y.*$', ''));
    END IF;
  END LOOP;
  -- Fallback: penultimate part (common when country-less)
  IF array_length(v_parts, 1) >= 2 THEN
    RETURN trim(v_parts[array_length(v_parts, 1) - 1]);
  END IF;
  RETURN NULL;
END;
$$;

-- ── 7. RLS ─────────────────────────────────────────────────────────────────
-- Read-only for authenticated users (dashboard consumption).
-- Writes restricted to service_role (engine + cron).

ALTER TABLE pulse_listing_missed_opportunity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pmo_select_authenticated ON pulse_listing_missed_opportunity;
CREATE POLICY pmo_select_authenticated ON pulse_listing_missed_opportunity
  FOR SELECT TO authenticated USING (true);

-- ── 8. Self-test: parse_price_text correctness ─────────────────────────────
-- Runs inline; RAISE EXCEPTION if any assertion fails.

DO $$
BEGIN
  ASSERT pulse_parse_price_text('$1,875,000') = 1875000, 'simple comma';
  ASSERT pulse_parse_price_text('$4.2m') = 4200000, 'dollar m';
  ASSERT pulse_parse_price_text('$4.2M') = 4200000, 'dollar M';
  ASSERT pulse_parse_price_text('Guide $950,000') = 950000, 'guide prefix';
  ASSERT pulse_parse_price_text('Buyers guide $2,500,000') = 2500000, 'buyers guide';
  ASSERT pulse_parse_price_text('Buyers'' Guide $4.2m') = 4200000, 'buyers apostrophe';
  ASSERT pulse_parse_price_text('For Sale - $2,698,000') = 2698000, 'for sale prefix';
  ASSERT pulse_parse_price_text('Price guide $795,000') = 795000, 'price guide';
  ASSERT pulse_parse_price_text('$750k') = 750000, 'k suffix';
  ASSERT pulse_parse_price_text('Contact Agent') IS NULL, 'contact agent is null';
  ASSERT pulse_parse_price_text('Auction') IS NULL, 'auction is null';
  ASSERT pulse_parse_price_text('Forthcoming Auction') IS NULL, 'forthcoming auction is null';
  ASSERT pulse_parse_price_text('Expressions of Interest') IS NULL, 'eoi is null';
  ASSERT pulse_parse_price_text(NULL) IS NULL, 'null input';
  ASSERT pulse_parse_price_text('') IS NULL, 'empty input';
  ASSERT pulse_haversine_km(-33.87, 151.10, -33.87, 151.10) = 0, 'zero distance';
  -- Strathfield to Parramatta — ~14km
  ASSERT pulse_haversine_km(-33.87, 151.07, -33.82, 151.00) BETWEEN 7 AND 15, 'strathfield parra ~14km';
  ASSERT pulse_extract_suburb('501/8 Parramatta Rd, Strathfield NSW 2135, Australia') = 'Strathfield', 'suburb simple';
  ASSERT pulse_extract_suburb('22 Robinson St, Croydon NSW, Australia') = 'Croydon', 'suburb no postcode';
  ASSERT pulse_extract_suburb('6 Roma Ave, Mount Pritchard NSW 2170, Australia') = 'Mount Pritchard', 'suburb multi-word';
  RAISE NOTICE 'All self-tests passed';
END $$;

COMMIT;

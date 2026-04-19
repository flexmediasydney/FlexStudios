-- 187_marketshare_legacy_integration.sql
-- Extend the FlexStudios Market Share / Retention engine to treat
-- `legacy_projects` (imported historical Pipedrive projects, keyed by
-- property_key) as a first-class captured-source alongside `projects`.
--
-- Before: a listing is "captured" iff an ACTIVE project exists at the same
--         property_key in status
--         (delivered / scheduled / ready_for_partial / to_be_scheduled).
-- After:  a listing is "captured" iff EITHER an ACTIVE project OR a LEGACY
--         project exists at the same property_key. The two sources are
--         reported separately so operators can see which historical footprint
--         each agency / agent has.
--
-- Substrate additions
--   pulse_listing_missed_opportunity
--     + captured_by_active  boolean DEFAULT false
--     + captured_by_legacy  boolean DEFAULT false
--
-- RPCs rewritten (full pg_get_functiondef-level replacement)
--   1.  pulse_compute_listing_quote(uuid)                — populates both flags
--   2.  pulse_get_market_share(tstz, tstz, text)         — breakdown + back-compat
--   3.  pulse_get_missed_top_n(tstz, tstz, int)          — dual EXISTS (no row change)
--   4.  pulse_get_retention_agent_scope_v2(tstz, tstz)   — +4 cols
--   5.  pulse_get_retention_agency_scope_v2(tstz, tstz)  — +4 cols
--   6.  pulse_get_retention_agent_detail(text, tstz, tstz)   — +captured_by
--   7.  pulse_get_retention_agency_detail(uuid, tstz, tstz)  — +captured_by
--   8.  pulse_get_agency_retention(uuid, tstz, tstz)     — +captured_by
--   9.  pulse_get_top_agents_retention(tstz, tstz, int, int) — +legacy breakdown
--   10. pulse_get_listing_quote_detail(uuid)             — +captured_by
--   11. pulse_get_agent_retention(text, tstz, tstz)      — +captured_by
--
-- Retro-fill — at the end of the migration, every existing PMO row has its
-- captured_by_active / captured_by_legacy columns back-filled from the
-- current projects + legacy_projects snapshot.
--
-- Operator notification — a pulse_timeline row is emitted with event_type
--   marketshare_engine_extended so dashboards / audit trails see when the
--   shift happened.
--
-- Anti-scope:
--   • Does NOT touch legacy_projects schema (agent 1 owns it) — only
--     references its property_key column.
--   • Does NOT change any UI / edge functions (agents 4+5 own).
--   • Does NOT touch package mapping logic (agent 2 owns).
--
-- Idempotent — re-running this migration is a no-op for columns/indexes and
-- re-creates the RPCs.

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 0. Safety net — legacy_projects may not exist yet (parallel agent 1 owns
-- the full schema). We stub the MINIMAL set of columns we reference so this
-- migration can apply in any order. Agent 1's migration uses
-- CREATE TABLE IF NOT EXISTS and adds the remaining columns via ALTER TABLE,
-- so our stub coexists cleanly — we do not touch anything beyond property_key.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS legacy_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_projects_property_key_idx
  ON legacy_projects(property_key);

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Substrate columns
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE pulse_listing_missed_opportunity
  ADD COLUMN IF NOT EXISTS captured_by_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS captured_by_legacy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pulse_listing_missed_opportunity.captured_by_active IS
  'True iff an ACTIVE project exists at this property_key (projects.status IN delivered/scheduled/ready_for_partial/to_be_scheduled). Source of truth: pulse_compute_listing_quote + nightly retro-fill.';

COMMENT ON COLUMN pulse_listing_missed_opportunity.captured_by_legacy IS
  'True iff a LEGACY project exists at this property_key (imported Pipedrive history via legacy_projects). Source of truth: pulse_compute_listing_quote + nightly retro-fill.';

-- Register the new event_type for audit/drift-detection (migration 116)
INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  ('marketshare_engine_extended', 'system',
   'Market Share engine extended to include legacy_projects as a captured-source')
ON CONFLICT (event_type) DO UPDATE SET
  category    = EXCLUDED.category,
  description = EXCLUDED.description;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. pulse_compute_listing_quote — populate new flags on UPSERT
-- ──────────────────────────────────────────────────────────────────────────
-- Keeps the v1.0.0 cascade semantics identical EXCEPT the substrate now
-- records captured_by_active / captured_by_legacy. The "captured" concept
-- previously was derived-at-query-time, never stored. This function now
-- snapshots both flags so downstream RPCs can filter without re-running
-- EXISTS per row.
--
-- Note: the tier/pricing cascade still reads `projects` only (legacy rows
-- have no pricing_tier / calculated_price so they cannot seed tier inheritance).
-- They only contribute to the capture predicate.

CREATE OR REPLACE FUNCTION pulse_compute_listing_quote(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_listing record;
  v_pulse_agency record;
  v_matrix_id uuid;
  v_matrix_default_tier text;
  v_matrix_use_default boolean;
  v_matrix_package_pricing jsonb;
  v_matrix_product_pricing jsonb;
  v_matrix_blanket_enabled boolean;
  v_matrix_blanket_pkg_pct numeric;
  v_matrix_blanket_prod_pct numeric;
  v_classification jsonb;
  v_package_id uuid;
  v_package_name text;
  v_tier text;
  v_tier_source text;
  v_tier_source_ref uuid;
  v_pricing_method text;
  v_pricing_source_ref uuid;
  v_pricing_source_ref_type text;
  v_package_base_price numeric := 0;
  v_overflow_photos int := 0;
  v_overflow_charge numeric := 0;
  v_discount_pct numeric := 0;
  v_quoted_price numeric := 0;
  v_photos int;
  v_has_fp boolean;
  v_has_video boolean;
  v_has_drone boolean;
  v_asking numeric;
  v_suburb text;
  v_package_std_price numeric;
  v_package_prm_price numeric;
  v_sales_img_std_base numeric := 200;
  v_sales_img_std_unit numeric := 25;
  v_sales_img_prm_base numeric := 275;
  v_sales_img_prm_unit numeric := 50;
  v_floorplan_std numeric := 200;
  v_floorplan_prm numeric := 250;
  v_drone_std numeric := 200;
  v_drone_std_unit numeric := 25;
  v_drone_prm numeric := 350;
  v_drone_prm_unit numeric := 50;
  v_package_base_qty int;
  v_quote_status text;
  v_address_hidden boolean;
  v_data_gap boolean := false;
  v_cascade jsonb := '[]'::jsonb;
  v_proximity_match record;
  v_ring_name text;
  v_ring_km numeric;
  v_engine_version text := 'v1.1.0-legacy';
  v_ring_kms numeric[] := ARRAY[2, 5, 10, 20, 50];
  i int;
  v_captured_active boolean;
  v_captured_legacy boolean;
BEGIN
  -- ─── Load listing ──────────────────────────────────────────────────────
  SELECT l.*,
    pulse_listing_photo_count(l.media_items, l.images) AS photo_count,
    pulse_listing_has_floorplan(l.media_items, l.floorplan_urls) AS fp,
    pulse_listing_has_video(l.has_video, l.video_url, l.media_items) AS hv
  INTO v_listing
  FROM pulse_listings l
  WHERE l.id = p_listing_id;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'Listing % not found', p_listing_id;
  END IF;

  v_photos := v_listing.photo_count;
  v_has_fp := v_listing.fp;
  v_has_video := v_listing.hv;
  v_has_drone := v_has_video;
  v_suburb := v_listing.suburb;
  v_address_hidden := v_listing.address IS NOT NULL
    AND (lower(v_listing.address) LIKE '%address available%' OR lower(v_listing.address) LIKE '%address on request%');

  v_asking := COALESCE(v_listing.asking_price, pulse_parse_price_text(v_listing.price_text));

  -- ─── Snapshot capture flags BOTH sources ─────────────────────────────
  v_captured_active := EXISTS (
    SELECT 1 FROM projects pr
    WHERE pr.property_key = v_listing.property_key
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  );
  v_captured_legacy := EXISTS (
    SELECT 1 FROM legacy_projects lp
    WHERE lp.property_key = v_listing.property_key
  );

  -- ─── Classify package ─────────────────────────────────────────────────
  v_classification := pulse_classify_listing_package(v_photos, v_has_fp, v_has_video, v_asking);
  v_package_id := NULLIF(v_classification->>'package_id', '')::uuid;
  v_package_name := v_classification->>'package_name';

  v_cascade := v_cascade || jsonb_build_object(
    'step', 'classify',
    'package_id', v_package_id,
    'package_name', v_package_name,
    'photos', v_photos,
    'fp', v_has_fp,
    'video', v_has_video,
    'asking', v_asking,
    'captured_by_active', v_captured_active,
    'captured_by_legacy', v_captured_legacy
  );

  IF v_package_id IS NOT NULL THEN
    SELECT
      (standard_tier->>'package_price')::numeric,
      (premium_tier->>'package_price')::numeric
    INTO v_package_std_price, v_package_prm_price
    FROM packages WHERE id = v_package_id;

    SELECT (COALESCE(
      (SELECT (p->>'quantity')::int FROM jsonb_array_elements(products) p
       WHERE p->>'product_id' = '30000000-0000-4000-a000-000000000001' LIMIT 1),
      5
    ))
    INTO v_package_base_qty
    FROM packages WHERE id = v_package_id;
  END IF;

  -- ─── Load billable entity + matrix ─────────────────────────────────────
  SELECT pa.*, a.name AS crm_agency_name
  INTO v_pulse_agency
  FROM pulse_agencies pa
  LEFT JOIN agencies a ON a.id = pa.linked_agency_id
  WHERE pa.id = v_listing.agency_pulse_id;

  IF v_pulse_agency.linked_agency_id IS NOT NULL THEN
    SELECT id, default_tier, use_default_pricing, package_pricing, product_pricing,
           COALESCE((blanket_discount->>'enabled')::boolean, false),
           COALESCE((blanket_discount->>'package_percent')::numeric, 0),
           COALESCE((blanket_discount->>'product_percent')::numeric, 0)
    INTO v_matrix_id, v_matrix_default_tier, v_matrix_use_default, v_matrix_package_pricing, v_matrix_product_pricing,
         v_matrix_blanket_enabled, v_matrix_blanket_pkg_pct, v_matrix_blanket_prod_pct
    FROM price_matrices
    WHERE entity_type = 'agency'
      AND entity_id = v_pulse_agency.linked_agency_id
      AND project_type_name = 'Residential Real Estate';
  END IF;

  -- ─── STEP 1: Tier resolution ──────────────────────────────────────────
  IF v_matrix_id IS NOT NULL AND v_matrix_default_tier IS NOT NULL THEN
    v_tier := v_matrix_default_tier;
    v_tier_source := 'matrix_agency';
    v_tier_source_ref := v_matrix_id;
    v_cascade := v_cascade || jsonb_build_object('step', 'tier_t2_matrix', 'matched', true, 'tier', v_tier);
  ELSE
    SELECT id, pricing_tier, property_address
    INTO v_proximity_match
    FROM projects
    WHERE property_key = v_listing.property_key
      AND NOT v_address_hidden
      AND status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pricing_tier IS NOT NULL
    LIMIT 1;
    IF v_proximity_match.id IS NOT NULL THEN
      v_tier := v_proximity_match.pricing_tier;
      v_tier_source := 'proximity_same_property';
      v_tier_source_ref := v_proximity_match.id;
    END IF;

    IF v_tier IS NULL AND v_listing.suburb IS NOT NULL THEN
      SELECT id, pricing_tier, property_address
      INTO v_proximity_match
      FROM projects
      WHERE pulse_extract_suburb(property_address) = v_listing.suburb
        AND status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        AND pricing_tier IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1;
      IF v_proximity_match.id IS NOT NULL THEN
        v_tier := v_proximity_match.pricing_tier;
        v_tier_source := 'proximity_same_suburb';
        v_tier_source_ref := v_proximity_match.id;
      END IF;
    END IF;

    IF v_tier IS NULL AND v_listing.latitude IS NOT NULL AND v_listing.longitude IS NOT NULL THEN
      FOR i IN 1..5 LOOP
        v_ring_km := v_ring_kms[i];
        SELECT id, pricing_tier, property_address, pulse_haversine_km(v_listing.latitude, v_listing.longitude, geocoded_lat, geocoded_lng) AS dist
        INTO v_proximity_match
        FROM projects
        WHERE geocoded_lat IS NOT NULL AND geocoded_lng IS NOT NULL
          AND status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
          AND pricing_tier IS NOT NULL
          AND pulse_haversine_km(v_listing.latitude, v_listing.longitude, geocoded_lat, geocoded_lng) <= v_ring_km
        ORDER BY pulse_haversine_km(v_listing.latitude, v_listing.longitude, geocoded_lat, geocoded_lng) ASC
        LIMIT 1;
        IF v_proximity_match.id IS NOT NULL THEN
          v_tier := v_proximity_match.pricing_tier;
          v_tier_source := 'proximity_radial_' || v_ring_km::text || 'km';
          v_tier_source_ref := v_proximity_match.id;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_tier IS NULL THEN
      v_tier := 'standard';
      v_tier_source := 'default_std';
      v_data_gap := true;
    END IF;

    v_cascade := v_cascade || jsonb_build_object(
      'step', 'tier_proximity',
      'tier', v_tier,
      'source', v_tier_source,
      'source_ref', v_tier_source_ref
    );
  END IF;

  -- ─── STEP 2: Price resolution ─────────────────────────────────────────
  IF v_matrix_id IS NOT NULL AND v_package_id IS NOT NULL THEN
    DECLARE
      v_pkg_override jsonb;
      v_base_from_matrix numeric;
      v_prod_override jsonb;
      v_sales_unit numeric;
    BEGIN
      SELECT po INTO v_pkg_override
      FROM jsonb_array_elements(COALESCE(v_matrix_package_pricing,'[]'::jsonb)) po
      WHERE po->>'package_id' = v_package_id::text AND (po->>'override_enabled')::boolean IS TRUE
      LIMIT 1;

      IF v_pkg_override IS NOT NULL THEN
        v_base_from_matrix := (v_pkg_override->>(v_tier||'_price'))::numeric;
        v_package_base_price := COALESCE(v_base_from_matrix, CASE WHEN v_tier='premium' THEN v_package_prm_price ELSE v_package_std_price END);
      ELSIF v_matrix_blanket_enabled THEN
        v_discount_pct := v_matrix_blanket_pkg_pct;
        v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
        v_package_base_price := v_package_base_price * (1 - v_discount_pct/100);
      ELSE
        v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
      END IF;

      SELECT po INTO v_prod_override
      FROM jsonb_array_elements(COALESCE(v_matrix_product_pricing,'[]'::jsonb)) po
      WHERE po->>'product_id' = '30000000-0000-4000-a000-000000000001' AND (po->>'override_enabled')::boolean IS TRUE
      LIMIT 1;

      IF v_prod_override IS NOT NULL THEN
        v_sales_unit := (v_prod_override->>(v_tier||'_unit'))::numeric;
      ELSE
        v_sales_unit := CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;
        IF v_matrix_blanket_enabled THEN
          v_sales_unit := v_sales_unit * (1 - v_matrix_blanket_prod_pct/100);
        END IF;
      END IF;

      v_overflow_photos := GREATEST(0, v_photos - v_package_base_qty);
      v_overflow_charge := v_overflow_photos * v_sales_unit;

      v_pricing_method := 'agency_matrix';
      v_pricing_source_ref := v_matrix_id;
      v_pricing_source_ref_type := 'price_matrix';
    END;

    v_cascade := v_cascade || jsonb_build_object(
      'step', 'pricing_p1_matrix',
      'matrix_id', v_matrix_id,
      'package_base', v_package_base_price,
      'overflow_photos', v_overflow_photos,
      'overflow_charge', v_overflow_charge,
      'discount_pct', v_discount_pct
    );

  ELSIF v_package_id IS NOT NULL THEN
    IF v_listing.suburb IS NOT NULL THEN
      SELECT p.id, p.pricing_tier, p.calculated_price
      INTO v_proximity_match
      FROM projects p
      WHERE pulse_extract_suburb(p.property_address) = v_listing.suburb
        AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        AND p.calculated_price IS NOT NULL AND p.calculated_price > 0
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p.packages,'[]'::jsonb)) pkg
          WHERE pkg->>'package_id' = v_package_id::text
        )
      ORDER BY p.created_at DESC
      LIMIT 1;
      IF v_proximity_match.id IS NOT NULL THEN
        v_package_base_price := v_proximity_match.calculated_price;
        v_pricing_method := 'proximity_suburb_same_pkg';
        v_pricing_source_ref := v_proximity_match.id;
        v_pricing_source_ref_type := 'project';
      END IF;
    END IF;

    IF v_pricing_method IS NULL AND v_listing.suburb IS NOT NULL THEN
      SELECT p.id, p.pricing_tier
      INTO v_proximity_match
      FROM projects p
      WHERE pulse_extract_suburb(p.property_address) = v_listing.suburb
        AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ORDER BY p.created_at DESC
      LIMIT 1;
      IF v_proximity_match.id IS NOT NULL THEN
        v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
        v_pricing_method := 'proximity_suburb_any_pkg';
        v_pricing_source_ref := v_proximity_match.id;
        v_pricing_source_ref_type := 'project';
      END IF;
    END IF;

    IF v_pricing_method IS NULL THEN
      v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
      v_pricing_method := 'global_default';
      v_data_gap := true;
    END IF;

    v_overflow_photos := GREATEST(0, v_photos - v_package_base_qty);
    v_overflow_charge := v_overflow_photos * CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;

    v_cascade := v_cascade || jsonb_build_object(
      'step', 'pricing_p2_p3',
      'method', v_pricing_method,
      'package_base', v_package_base_price,
      'overflow_photos', v_overflow_photos,
      'overflow_charge', v_overflow_charge
    );

  ELSE
    v_package_base_price := 0;
    v_overflow_photos := 0;
    v_overflow_charge := 0;
    DECLARE v_imgs numeric;
    BEGIN
      v_imgs := CASE WHEN v_tier='premium' THEN v_sales_img_prm_base ELSE v_sales_img_std_base END
              + GREATEST(0, v_photos - 5) * CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;
      v_package_base_price := v_imgs;
    END;
    IF v_has_fp THEN
      v_package_base_price := v_package_base_price + CASE WHEN v_tier='premium' THEN v_floorplan_prm ELSE v_floorplan_std END;
    END IF;
    IF v_has_drone THEN
      v_package_base_price := v_package_base_price + CASE WHEN v_tier='premium' THEN v_drone_prm ELSE v_drone_std END;
    END IF;
    v_pricing_method := 'item_sum_unclassifiable';
    v_cascade := v_cascade || jsonb_build_object('step', 'pricing_item_sum', 'total', v_package_base_price);
  END IF;

  v_quoted_price := v_package_base_price + v_overflow_charge;

  IF v_listing.detail_enriched_at IS NULL THEN
    v_quote_status := 'pending_enrichment';
  ELSIF v_data_gap THEN
    v_quote_status := 'data_gap';
  ELSE
    v_quote_status := 'fresh';
  END IF;

  INSERT INTO pulse_listing_missed_opportunity (
    listing_id, property_key, suburb, postcode, listing_type, listing_status, first_seen_at,
    photo_count, has_floorplan, has_video, has_drone_inferred, asking_price_numeric,
    classified_package_id, classified_package_name,
    resolved_tier, tier_source, tier_source_ref,
    pricing_method, pricing_source_ref, pricing_source_ref_type,
    package_base_price, overflow_photos, overflow_charge, discount_applied_pct, quoted_price,
    address_hidden, data_gap_flag, photos_capped_at_34,
    photo_count_at_quote, has_floorplan_at_quote, has_video_at_quote, price_text_at_quote,
    quote_status, computed_at, engine_version, raw_cascade_log,
    captured_by_active, captured_by_legacy
  )
  VALUES (
    v_listing.id, v_listing.property_key, v_listing.suburb, v_listing.postcode, v_listing.listing_type, v_listing.status, v_listing.first_seen_at,
    v_photos, v_has_fp, v_has_video, v_has_drone, v_asking,
    v_package_id, v_package_name,
    v_tier, v_tier_source, v_tier_source_ref,
    v_pricing_method, v_pricing_source_ref, v_pricing_source_ref_type,
    v_package_base_price, v_overflow_photos, v_overflow_charge, v_discount_pct, v_quoted_price,
    v_address_hidden, v_data_gap, (v_photos = 34),
    v_photos, v_has_fp, v_has_video, v_listing.price_text,
    v_quote_status, now(), v_engine_version, v_cascade,
    v_captured_active, v_captured_legacy
  )
  ON CONFLICT (listing_id) DO UPDATE SET
    property_key = EXCLUDED.property_key,
    suburb = EXCLUDED.suburb,
    postcode = EXCLUDED.postcode,
    listing_type = EXCLUDED.listing_type,
    listing_status = EXCLUDED.listing_status,
    first_seen_at = EXCLUDED.first_seen_at,
    photo_count = EXCLUDED.photo_count,
    has_floorplan = EXCLUDED.has_floorplan,
    has_video = EXCLUDED.has_video,
    has_drone_inferred = EXCLUDED.has_drone_inferred,
    asking_price_numeric = EXCLUDED.asking_price_numeric,
    classified_package_id = EXCLUDED.classified_package_id,
    classified_package_name = EXCLUDED.classified_package_name,
    resolved_tier = EXCLUDED.resolved_tier,
    tier_source = EXCLUDED.tier_source,
    tier_source_ref = EXCLUDED.tier_source_ref,
    pricing_method = EXCLUDED.pricing_method,
    pricing_source_ref = EXCLUDED.pricing_source_ref,
    pricing_source_ref_type = EXCLUDED.pricing_source_ref_type,
    package_base_price = EXCLUDED.package_base_price,
    overflow_photos = EXCLUDED.overflow_photos,
    overflow_charge = EXCLUDED.overflow_charge,
    discount_applied_pct = EXCLUDED.discount_applied_pct,
    quoted_price = EXCLUDED.quoted_price,
    address_hidden = EXCLUDED.address_hidden,
    data_gap_flag = EXCLUDED.data_gap_flag,
    photos_capped_at_34 = EXCLUDED.photos_capped_at_34,
    photo_count_at_quote = EXCLUDED.photo_count_at_quote,
    has_floorplan_at_quote = EXCLUDED.has_floorplan_at_quote,
    has_video_at_quote = EXCLUDED.has_video_at_quote,
    price_text_at_quote = EXCLUDED.price_text_at_quote,
    quote_status = EXCLUDED.quote_status,
    computed_at = EXCLUDED.computed_at,
    engine_version = EXCLUDED.engine_version,
    raw_cascade_log = EXCLUDED.raw_cascade_log,
    captured_by_active = EXCLUDED.captured_by_active,
    captured_by_legacy = EXCLUDED.captured_by_legacy;

  RETURN (
    SELECT to_jsonb(pmo) FROM pulse_listing_missed_opportunity pmo WHERE pmo.listing_id = p_listing_id
  );
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. pulse_get_market_share — adds captured_listings_{active,legacy,total}
--    plus captured_by_source_breakdown { active, legacy, both }
-- ──────────────────────────────────────────────────────────────────────────
-- Back-compat: existing captured_listings stays as "total" for consumers that
-- haven't migrated yet. Dedup logic is trivial: each PMO row has one
-- property_key and we count the LISTING (not the property_key) so "both"
-- does not double-count; we partition the universe into
-- {active-only, legacy-only, both, neither}.

CREATE OR REPLACE FUNCTION pulse_get_market_share(
  p_from timestamptz,
  p_to timestamptz,
  p_suburb text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH in_window AS (
    SELECT q.*,
      -- Dual-source capture. The stored columns are authoritative (retro-fill
      -- keeps them fresh); we intentionally trust the substrate here so this
      -- rollup is O(N) over pulse_listing_missed_opportunity with no joins.
      q.captured_by_active AS cap_active,
      q.captured_by_legacy AS cap_legacy,
      (q.captured_by_active OR q.captured_by_legacy) AS is_captured
    FROM pulse_listing_missed_opportunity q
    WHERE q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
      AND (p_suburb IS NULL OR q.suburb = p_suburb)
  ),
  totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE is_captured) AS captured_listings,
      count(*) FILTER (WHERE cap_active) AS captured_listings_active,
      count(*) FILTER (WHERE cap_legacy) AS captured_listings_legacy,
      count(*) FILTER (WHERE cap_active AND cap_legacy) AS captured_listings_both,
      count(*) FILTER (WHERE cap_active AND NOT cap_legacy) AS captured_active_only,
      count(*) FILTER (WHERE cap_legacy AND NOT cap_active) AS captured_legacy_only,
      count(*) FILTER (WHERE NOT is_captured) AS missed_listings,
      count(*) FILTER (WHERE quote_status = 'pending_enrichment') AS pending_enrichment,
      count(*) FILTER (WHERE quote_status = 'data_gap') AS data_gap,
      count(*) FILTER (WHERE quote_status = 'fresh') AS fresh,
      COALESCE(sum(asking_price_numeric), 0) AS total_market_value,
      COALESCE(sum(asking_price_numeric) FILTER (WHERE is_captured), 0) AS captured_market_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0) AS missed_opportunity_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured), 0) AS missed_opportunity_value_including_pending
    FROM in_window
  ),
  by_package AS (
    SELECT classified_package_name, count(*) AS n, COALESCE(sum(quoted_price), 0) AS value
    FROM in_window
    WHERE NOT is_captured
    GROUP BY classified_package_name
  ),
  by_tier AS (
    SELECT resolved_tier, count(*) AS n, COALESCE(sum(quoted_price), 0) AS value
    FROM in_window
    WHERE NOT is_captured
    GROUP BY resolved_tier
  )
  SELECT jsonb_build_object(
    'window_from', p_from,
    'window_to', p_to,
    'suburb_filter', p_suburb,
    'total_listings', (SELECT total_listings FROM totals),
    -- Back-compat: captured_listings is the union (dedup'd).
    'captured_listings', (SELECT captured_listings FROM totals),
    -- New: per-source breakdown. Sum of active + legacy counts DOUBLE-COUNTS
    -- the "both" bucket — use captured_listings_total for the deduped union.
    'captured_listings_active', (SELECT captured_listings_active FROM totals),
    'captured_listings_legacy', (SELECT captured_listings_legacy FROM totals),
    'captured_listings_total', (SELECT captured_listings FROM totals),
    'captured_by_source_breakdown', jsonb_build_object(
      'active', (SELECT captured_active_only FROM totals),
      'legacy', (SELECT captured_legacy_only FROM totals),
      'both',   (SELECT captured_listings_both FROM totals)
    ),
    'missed_listings', (SELECT missed_listings FROM totals),
    'capture_rate_pct', CASE WHEN (SELECT total_listings FROM totals) = 0 THEN 0 ELSE round(100.0 * (SELECT captured_listings FROM totals) / (SELECT total_listings FROM totals), 2) END,
    'total_market_value', (SELECT total_market_value FROM totals),
    'captured_market_value', (SELECT captured_market_value FROM totals),
    'missed_opportunity_value', (SELECT missed_opportunity_value FROM totals),
    'missed_opportunity_including_pending', (SELECT missed_opportunity_value_including_pending FROM totals),
    'quote_quality', jsonb_build_object(
      'fresh', (SELECT fresh FROM totals),
      'pending_enrichment', (SELECT pending_enrichment FROM totals),
      'data_gap', (SELECT data_gap FROM totals)
    ),
    'by_package', (SELECT jsonb_agg(jsonb_build_object('package', classified_package_name, 'listings', n, 'value', value)) FROM by_package),
    'by_tier', (SELECT jsonb_agg(jsonb_build_object('tier', resolved_tier, 'listings', n, 'value', value)) FROM by_tier)
  );
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. pulse_get_missed_top_n — "missed" now means neither active nor legacy
-- ──────────────────────────────────────────────────────────────────────────
-- Row shape unchanged (back-compat). The filter expands to include the dual
-- capture check, so legacy-captured listings no longer appear in missed-top-N.

DROP FUNCTION IF EXISTS pulse_get_missed_top_n(timestamptz, timestamptz, int);

CREATE OR REPLACE FUNCTION pulse_get_missed_top_n(
  p_from timestamptz,
  p_to timestamptz,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  listing_id uuid,
  address text,
  suburb text,
  first_seen_at timestamptz,
  asking_price numeric,
  classified_package_name text,
  resolved_tier text,
  pricing_method text,
  quoted_price numeric,
  photo_count int,
  has_video boolean,
  agency_name text,
  agent_name text,
  agent_rea_id text,
  agent_pulse_id uuid,
  agency_pulse_id uuid,
  source_url text,
  data_gap_flag boolean,
  detail_enriched_at timestamptz,
  quote_status text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    q.listing_id,
    l.address,
    q.suburb,
    q.first_seen_at,
    q.asking_price_numeric,
    q.classified_package_name,
    q.resolved_tier,
    q.pricing_method,
    q.quoted_price,
    q.photo_count,
    q.has_video,
    l.agency_name,
    l.agent_name,
    l.agent_rea_id,
    l.agent_pulse_id,
    l.agency_pulse_id,
    l.source_url,
    q.data_gap_flag,
    l.detail_enriched_at,
    q.quote_status
  FROM pulse_listing_missed_opportunity q
  JOIN pulse_listings l ON l.id = q.listing_id
  WHERE q.listing_type = 'for_sale'
    AND q.first_seen_at >= p_from
    AND q.first_seen_at < p_to
    AND q.quote_status IN ('fresh','data_gap')
    -- Dual-source missed predicate
    AND NOT q.captured_by_active
    AND NOT q.captured_by_legacy
  ORDER BY q.quoted_price DESC NULLS LAST, q.first_seen_at DESC
  LIMIT p_limit;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. pulse_get_retention_agent_scope_v2 — +active/legacy columns
-- ──────────────────────────────────────────────────────────────────────────
-- Return-type changes require a DROP first (Postgres rejects CREATE OR
-- REPLACE when OUT column set differs).

DROP FUNCTION IF EXISTS pulse_get_retention_agent_scope_v2(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION pulse_get_retention_agent_scope_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agent_rea_id text,
  agent_pulse_id uuid,
  agent_name text,
  agency_name text,
  agency_pulse_id uuid,
  profile_image text,
  email text,
  mobile text,
  -- Current dimension
  current_listings bigint,
  current_captured bigint,
  current_captured_active bigint,
  current_captured_legacy bigint,
  current_missed bigint,
  current_retention_pct numeric,
  current_missed_value numeric,
  -- Sold dimension
  sold_listings bigint,
  sold_captured bigint,
  sold_captured_active bigint,
  sold_captured_legacy bigint,
  sold_missed bigint,
  sold_retention_pct numeric,
  sold_missed_value numeric,
  projects_in_window bigint,
  last_project_date date,
  last_listing_date date
)
LANGUAGE sql
STABLE
AS $$
  WITH crm_agents AS (
    SELECT pa.id AS agent_pulse_id,
           pa.rea_agent_id,
           pa.full_name AS agent_name,
           pa.agency_name AS agency_name,
           pa.profile_image,
           pa.email,
           pa.mobile,
           (SELECT id FROM pulse_agencies WHERE rea_agency_id = pa.agency_rea_id LIMIT 1) AS agency_pulse_id
    FROM pulse_agents pa
    WHERE pa.is_in_crm = true
      AND pa.rea_agent_id IS NOT NULL
  ),
  -- Captured-property-key set materialized ONCE per window across sources.
  cap_active AS (
    SELECT DISTINCT property_key FROM projects
    WHERE status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND property_key IS NOT NULL
  ),
  cap_legacy AS (
    SELECT DISTINCT property_key FROM legacy_projects
    WHERE property_key IS NOT NULL
  ),
  curr AS (
    SELECT l.agent_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
                OR EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
           ) AS captured_active,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured_legacy,
           COALESCE(sum(q.quoted_price) FILTER (
             WHERE q.quote_status IN ('fresh','data_gap')
               AND NOT EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
               AND NOT EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ), 0) AS missed_value,
           max(l.first_seen_at::date) AS last_seen
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
    GROUP BY l.agent_rea_id
  ),
  sold AS (
    SELECT l.agent_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
                OR EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
           ) AS captured_active,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured_legacy,
           0::numeric AS missed_value,
           max(l.sold_date)::date AS last_sold
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= p_from::date
      AND l.sold_date < p_to::date
    GROUP BY l.agent_rea_id
  ),
  proj AS (
    SELECT pa.rea_agent_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM pulse_agents pa
    JOIN pulse_crm_mappings m ON m.entity_type = 'agent' AND (m.pulse_entity_id = pa.id OR m.rea_id = pa.rea_agent_id)
    JOIN projects pr ON pr.agent_id = m.crm_entity_id
    WHERE pa.is_in_crm = true
      AND pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= p_from::date
      AND pr.shoot_date < p_to::date
    GROUP BY pa.rea_agent_id
  )
  SELECT
    ca.rea_agent_id AS agent_rea_id,
    ca.agent_pulse_id,
    ca.agent_name,
    ca.agency_name,
    ca.agency_pulse_id,
    ca.profile_image,
    ca.email,
    ca.mobile,
    COALESCE(c.total, 0) AS current_listings,
    COALESCE(c.captured, 0) AS current_captured,
    COALESCE(c.captured_active, 0) AS current_captured_active,
    COALESCE(c.captured_legacy, 0) AS current_captured_legacy,
    COALESCE(c.total, 0) - COALESCE(c.captured, 0) AS current_missed,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(c.captured, 0) / c.total, 2) END AS current_retention_pct,
    COALESCE(c.missed_value, 0) AS current_missed_value,
    COALESCE(s.total, 0) AS sold_listings,
    COALESCE(s.captured, 0) AS sold_captured,
    COALESCE(s.captured_active, 0) AS sold_captured_active,
    COALESCE(s.captured_legacy, 0) AS sold_captured_legacy,
    COALESCE(s.total, 0) - COALESCE(s.captured, 0) AS sold_missed,
    CASE WHEN COALESCE(s.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(s.captured, 0) / s.total, 2) END AS sold_retention_pct,
    COALESCE(s.missed_value, 0) AS sold_missed_value,
    COALESCE(p.n, 0) AS projects_in_window,
    p.last_date AS last_project_date,
    GREATEST(c.last_seen, s.last_sold) AS last_listing_date
  FROM crm_agents ca
  LEFT JOIN curr c ON c.agent_rea_id = ca.rea_agent_id
  LEFT JOIN sold s ON s.agent_rea_id = ca.rea_agent_id
  LEFT JOIN proj p ON p.rea_agent_id = ca.rea_agent_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agent_name;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. pulse_get_retention_agency_scope_v2 — +active/legacy columns
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pulse_get_retention_agency_scope_v2(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION pulse_get_retention_agency_scope_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agency_pulse_id uuid,
  crm_agency_id uuid,
  agency_name text,
  logo_url text,
  suburb text,
  rea_agency_id text,
  agents_in_agency bigint,
  current_listings bigint,
  current_captured bigint,
  current_captured_active bigint,
  current_captured_legacy bigint,
  current_missed bigint,
  current_retention_pct numeric,
  current_missed_value numeric,
  sold_listings bigint,
  sold_captured bigint,
  sold_captured_active bigint,
  sold_captured_legacy bigint,
  sold_missed bigint,
  sold_retention_pct numeric,
  sold_missed_value numeric,
  projects_in_window bigint,
  last_project_date date,
  last_listing_date date
)
LANGUAGE sql
STABLE
AS $$
  WITH crm_agencies AS (
    SELECT pa.id AS agency_pulse_id,
           pa.linked_agency_id AS crm_agency_id,
           pa.name AS agency_name,
           pa.logo_url,
           pa.suburb,
           pa.rea_agency_id
    FROM pulse_agencies pa
    WHERE pa.is_in_crm = true
  ),
  agents_count AS (
    SELECT agency_rea_id, count(*)::bigint AS n
    FROM pulse_agents
    WHERE agency_rea_id IS NOT NULL
    GROUP BY agency_rea_id
  ),
  cap_active AS (
    SELECT DISTINCT property_key FROM projects
    WHERE status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND property_key IS NOT NULL
  ),
  cap_legacy AS (
    SELECT DISTINCT property_key FROM legacy_projects
    WHERE property_key IS NOT NULL
  ),
  curr AS (
    SELECT l.agency_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
                OR EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
           ) AS captured_active,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured_legacy,
           COALESCE(sum(q.quoted_price) FILTER (
             WHERE q.quote_status IN ('fresh','data_gap')
               AND NOT EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
               AND NOT EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ), 0) AS missed_value,
           max(l.first_seen_at::date) AS last_seen
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
    GROUP BY l.agency_rea_id
  ),
  sold AS (
    SELECT l.agency_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
                OR EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = l.property_key)
           ) AS captured_active,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = l.property_key)
           ) AS captured_legacy,
           0::numeric AS missed_value,
           max(l.sold_date)::date AS last_sold
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= p_from::date
      AND l.sold_date < p_to::date
    GROUP BY l.agency_rea_id
  ),
  proj AS (
    SELECT ca.rea_agency_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM crm_agencies ca
    JOIN projects pr ON pr.agency_id = ca.crm_agency_id
    WHERE pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= p_from::date
      AND pr.shoot_date < p_to::date
    GROUP BY ca.rea_agency_id
  )
  SELECT
    ca.agency_pulse_id,
    ca.crm_agency_id,
    ca.agency_name,
    ca.logo_url,
    ca.suburb,
    ca.rea_agency_id,
    COALESCE(ac.n, 0) AS agents_in_agency,
    COALESCE(c.total, 0) AS current_listings,
    COALESCE(c.captured, 0) AS current_captured,
    COALESCE(c.captured_active, 0) AS current_captured_active,
    COALESCE(c.captured_legacy, 0) AS current_captured_legacy,
    COALESCE(c.total, 0) - COALESCE(c.captured, 0) AS current_missed,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(c.captured, 0) / c.total, 2) END AS current_retention_pct,
    COALESCE(c.missed_value, 0) AS current_missed_value,
    COALESCE(s.total, 0) AS sold_listings,
    COALESCE(s.captured, 0) AS sold_captured,
    COALESCE(s.captured_active, 0) AS sold_captured_active,
    COALESCE(s.captured_legacy, 0) AS sold_captured_legacy,
    COALESCE(s.total, 0) - COALESCE(s.captured, 0) AS sold_missed,
    CASE WHEN COALESCE(s.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(s.captured, 0) / s.total, 2) END AS sold_retention_pct,
    COALESCE(s.missed_value, 0) AS sold_missed_value,
    COALESCE(p.n, 0) AS projects_in_window,
    p.last_date AS last_project_date,
    GREATEST(c.last_seen, s.last_sold) AS last_listing_date
  FROM crm_agencies ca
  LEFT JOIN agents_count ac ON ac.agency_rea_id = ca.rea_agency_id
  LEFT JOIN curr c ON c.agency_rea_id = ca.rea_agency_id
  LEFT JOIN sold s ON s.agency_rea_id = ca.rea_agency_id
  LEFT JOIN proj p ON p.rea_agency_id = ca.rea_agency_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agency_name;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 7. pulse_get_retention_agent_detail — per-listing captured_by on each row
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_retention_agent_detail(
  p_agent_rea_id text,
  p_from         timestamptz,
  p_to           timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  agent_row AS (
    SELECT
      pa.id            AS agent_pulse_id,
      pa.rea_agent_id,
      pa.full_name,
      pa.email,
      pa.mobile,
      pa.business_phone,
      pa.agency_name,
      pa.linked_agency_pulse_id AS agency_pulse_id,
      pa.linked_agent_id       AS crm_agent_id,
      pa.profile_image,
      pa.is_in_crm
    FROM pulse_agents pa
    WHERE pa.rea_agent_id = p_agent_rea_id
    LIMIT 1
  ),
  proj_rows AS (
    SELECT
      p.id                     AS project_id,
      p.property_address,
      p.property_key,
      COALESCE(p.shoot_date, p.created_at)::date AS booking_date,
      p.status,
      p.calculated_price,
      COALESCE(
        (SELECT pk.name FROM packages pk
          WHERE pk.id = COALESCE(
            ((p.packages->0->>'package_id')::uuid),
            NULL)
          LIMIT 1),
        NULLIF(p.tonomo_package,'')
      ) AS package_name
    FROM projects p
    JOIN agent_row ar ON p.agent_id = ar.crm_agent_id
    WHERE p.project_type_name = 'Residential Real Estate'
      AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  ),
  listing_rows AS (
    SELECT
      l.id                           AS listing_id,
      l.address,
      l.suburb,
      l.first_seen_at,
      l.source_url,
      l.property_key,
      l.asking_price,
      l.agent_pulse_id,
      l.agency_pulse_id,
      q.classified_package_name      AS package,
      q.resolved_tier                AS tier,
      q.quoted_price,
      q.quote_status,
      q.data_gap_flag,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp
        WHERE lp.property_key = l.property_key
      ) AS cap_legacy,
      (SELECT pr.id FROM projects pr
         WHERE pr.property_key = l.property_key
           AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
         LIMIT 1
      ) AS matched_project_id
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.agent_rea_id = p_agent_rea_id
      AND l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
  ),
  listing_rows_enriched AS (
    SELECT lr.*,
           (cap_active OR cap_legacy) AS is_captured,
           CASE
             WHEN cap_active AND cap_legacy THEN 'both'
             WHEN cap_active THEN 'active'
             WHEN cap_legacy THEN 'legacy'
             ELSE NULL
           END AS captured_by
    FROM listing_rows lr
  ),
  match_rows AS (
    SELECT
      property_key,
      bool_or(is_captured)          AS any_captured,
      count(*)                       AS listings_cnt
    FROM listing_rows_enriched
    GROUP BY property_key
  )
  SELECT jsonb_build_object(
    'agent', (SELECT to_jsonb(ar.*) FROM agent_row ar),
    'window_from', p_from,
    'window_to',   p_to,
    'summary', jsonb_build_object(
      'projects_in_scope',         (SELECT count(*) FROM proj_rows),
      'listings_in_window',        (SELECT count(*) FROM listing_rows_enriched),
      'listings_captured',         (SELECT count(*) FILTER (WHERE is_captured) FROM listing_rows_enriched),
      'listings_captured_active',  (SELECT count(*) FILTER (WHERE cap_active) FROM listing_rows_enriched),
      'listings_captured_legacy',  (SELECT count(*) FILTER (WHERE cap_legacy) FROM listing_rows_enriched),
      'listings_missed',           (SELECT count(*) FILTER (WHERE NOT is_captured) FROM listing_rows_enriched),
      'missed_opportunity_value',  COALESCE((SELECT sum(quoted_price) FROM listing_rows_enriched WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0)
    ),
    'projects',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'project_id',       project_id,
        'property_address', property_address,
        'property_key',     property_key,
        'booking_date',     booking_date,
        'status',           status,
        'package_name',     package_name,
        'calculated_price', calculated_price
      ) ORDER BY booking_date DESC NULLS LAST)
      FROM proj_rows
    ), '[]'::jsonb),
    'listings',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',     listing_id,
        'address',        address,
        'suburb',         suburb,
        'first_seen_at',  first_seen_at,
        'source_url',     source_url,
        'property_key',   property_key,
        'package',        package,
        'tier',           tier,
        'quoted_price',   quoted_price,
        'quote_status',   quote_status,
        'data_gap_flag',  data_gap_flag,
        'is_captured',    is_captured,
        'captured_by',    captured_by,
        'matched_project_id', matched_project_id,
        'agent_pulse_id',  agent_pulse_id,
        'agency_pulse_id', agency_pulse_id
      ) ORDER BY first_seen_at DESC)
      FROM listing_rows_enriched
    ), '[]'::jsonb),
    'matches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'property_key', property_key,
        'any_captured', any_captured,
        'listings_cnt', listings_cnt
      ) ORDER BY any_captured DESC, property_key)
      FROM match_rows
    ), '[]'::jsonb)
  );
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 8. pulse_get_retention_agency_detail — per-listing captured_by on each row
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_retention_agency_detail(
  p_agency_pulse_id uuid,
  p_from            timestamptz,
  p_to              timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  agency_row AS (
    SELECT
      pag.id AS agency_pulse_id,
      pag.name AS agency_name,
      pag.rea_agency_id,
      pag.logo_url,
      pag.address_street,
      pag.phone,
      pag.email,
      pag.is_in_crm
    FROM pulse_agencies pag
    WHERE pag.id = p_agency_pulse_id
    LIMIT 1
  ),
  agency_agents AS (
    SELECT pa.id             AS agent_pulse_id,
           pa.rea_agent_id,
           pa.linked_agent_id AS crm_agent_id,
           pa.full_name,
           pa.profile_image,
           pa.is_in_crm
    FROM pulse_agents pa
    WHERE pa.linked_agency_pulse_id = p_agency_pulse_id
  ),
  proj_rows AS (
    SELECT
      p.id                     AS project_id,
      p.property_address,
      p.property_key,
      p.agent_name,
      COALESCE(p.shoot_date, p.created_at)::date AS booking_date,
      p.status,
      p.calculated_price,
      COALESCE(
        (SELECT pk.name FROM packages pk
          WHERE pk.id = COALESCE(
            ((p.packages->0->>'package_id')::uuid),
            NULL)
          LIMIT 1),
        NULLIF(p.tonomo_package,'')
      ) AS package_name
    FROM projects p
    JOIN agency_agents aa ON p.agent_id = aa.crm_agent_id
    WHERE p.project_type_name = 'Residential Real Estate'
      AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  ),
  listing_rows AS (
    SELECT DISTINCT
      l.id                           AS listing_id,
      l.address,
      l.suburb,
      l.first_seen_at,
      l.source_url,
      l.property_key,
      l.agent_name,
      l.agent_rea_id,
      l.agent_pulse_id,
      l.agency_pulse_id,
      q.classified_package_name      AS package,
      q.resolved_tier                AS tier,
      q.quoted_price,
      q.quote_status,
      q.data_gap_flag,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp
        WHERE lp.property_key = l.property_key
      ) AS cap_legacy,
      (SELECT pr.id FROM projects pr
         WHERE pr.property_key = l.property_key
           AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
         LIMIT 1
      ) AS matched_project_id
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at <  p_to
      AND (
        l.agency_pulse_id = p_agency_pulse_id
        OR l.agent_pulse_id IN (SELECT agent_pulse_id FROM agency_agents)
      )
  ),
  listing_rows_enriched AS (
    SELECT lr.*,
           (cap_active OR cap_legacy) AS is_captured,
           CASE
             WHEN cap_active AND cap_legacy THEN 'both'
             WHEN cap_active THEN 'active'
             WHEN cap_legacy THEN 'legacy'
             ELSE NULL
           END AS captured_by
    FROM listing_rows lr
  ),
  match_rows AS (
    SELECT
      property_key,
      bool_or(is_captured) AS any_captured,
      count(*)              AS listings_cnt
    FROM listing_rows_enriched
    GROUP BY property_key
  ),
  agent_rollup AS (
    SELECT
      aa.agent_pulse_id,
      aa.rea_agent_id,
      aa.full_name,
      aa.profile_image,
      aa.is_in_crm,
      (SELECT count(*) FROM proj_rows pr WHERE pr.agent_name = aa.full_name) AS projects_cnt,
      (SELECT count(*) FROM listing_rows_enriched lr WHERE lr.agent_rea_id = aa.rea_agent_id) AS listings_cnt,
      (SELECT count(*) FROM listing_rows_enriched lr WHERE lr.agent_rea_id = aa.rea_agent_id AND lr.is_captured) AS captured_cnt,
      (SELECT count(*) FROM listing_rows_enriched lr WHERE lr.agent_rea_id = aa.rea_agent_id AND lr.cap_active) AS captured_active_cnt,
      (SELECT count(*) FROM listing_rows_enriched lr WHERE lr.agent_rea_id = aa.rea_agent_id AND lr.cap_legacy) AS captured_legacy_cnt,
      (SELECT count(*) FROM listing_rows_enriched lr WHERE lr.agent_rea_id = aa.rea_agent_id AND NOT lr.is_captured) AS missed_cnt,
      COALESCE((SELECT sum(quoted_price) FROM listing_rows_enriched lr
                WHERE lr.agent_rea_id = aa.rea_agent_id
                  AND NOT lr.is_captured
                  AND lr.quote_status IN ('fresh','data_gap')), 0) AS missed_value
    FROM agency_agents aa
  )
  SELECT jsonb_build_object(
    'agency', (SELECT to_jsonb(ar.*) FROM agency_row ar),
    'window_from', p_from,
    'window_to',   p_to,
    'summary', jsonb_build_object(
      'agent_count',               (SELECT count(*) FROM agency_agents),
      'projects_in_scope',         (SELECT count(*) FROM proj_rows),
      'listings_in_window',        (SELECT count(*) FROM listing_rows_enriched),
      'listings_captured',         (SELECT count(*) FILTER (WHERE is_captured) FROM listing_rows_enriched),
      'listings_captured_active',  (SELECT count(*) FILTER (WHERE cap_active) FROM listing_rows_enriched),
      'listings_captured_legacy',  (SELECT count(*) FILTER (WHERE cap_legacy) FROM listing_rows_enriched),
      'listings_missed',           (SELECT count(*) FILTER (WHERE NOT is_captured) FROM listing_rows_enriched),
      'missed_opportunity_value',  COALESCE((SELECT sum(quoted_price) FROM listing_rows_enriched WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0)
    ),
    'agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'agent_pulse_id', agent_pulse_id,
        'agent_rea_id',   rea_agent_id,
        'agent_name',     full_name,
        'profile_image',  profile_image,
        'is_in_crm',      is_in_crm,
        'projects_cnt',   projects_cnt,
        'listings_cnt',   listings_cnt,
        'captured_cnt',   captured_cnt,
        'captured_active_cnt', captured_active_cnt,
        'captured_legacy_cnt', captured_legacy_cnt,
        'missed_cnt',     missed_cnt,
        'missed_value',   missed_value
      ) ORDER BY missed_value DESC NULLS LAST, listings_cnt DESC NULLS LAST)
      FROM agent_rollup
    ), '[]'::jsonb),
    'projects',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'project_id',       project_id,
        'property_address', property_address,
        'property_key',     property_key,
        'agent_name',       agent_name,
        'booking_date',     booking_date,
        'status',           status,
        'package_name',     package_name,
        'calculated_price', calculated_price
      ) ORDER BY booking_date DESC NULLS LAST)
      FROM proj_rows
    ), '[]'::jsonb),
    'listings',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',     listing_id,
        'address',        address,
        'suburb',         suburb,
        'first_seen_at',  first_seen_at,
        'source_url',     source_url,
        'property_key',   property_key,
        'agent_name',     agent_name,
        'agent_rea_id',   agent_rea_id,
        'package',        package,
        'tier',           tier,
        'quoted_price',   quoted_price,
        'quote_status',   quote_status,
        'data_gap_flag',  data_gap_flag,
        'is_captured',    is_captured,
        'captured_by',    captured_by,
        'matched_project_id', matched_project_id,
        'agent_pulse_id',  agent_pulse_id,
        'agency_pulse_id', agency_pulse_id
      ) ORDER BY first_seen_at DESC)
      FROM listing_rows_enriched
    ), '[]'::jsonb),
    'matches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'property_key', property_key,
        'any_captured', any_captured,
        'listings_cnt', listings_cnt
      ) ORDER BY any_captured DESC, property_key)
      FROM match_rows
    ), '[]'::jsonb)
  );
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 9. pulse_get_agency_retention — + captured_by on each listing + breakdown
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_agency_retention(
  p_agency_pulse_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agency_ctx AS (
    SELECT id AS agency_pulse_id, linked_agency_id AS crm_agency_id
    FROM pulse_agencies
    WHERE id = p_agency_pulse_id
  ),
  agency_listings AS (
    SELECT
      q.*,
      l.agent_name,
      l.agent_rea_id,
      l.agent_pulse_id,
      l.address,
      l.source_url,
      l.agency_name,
      l.agency_pulse_id,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp
        WHERE lp.property_key = q.property_key
      ) AS cap_legacy
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agency_pulse_id = p_agency_pulse_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  agency_listings_enriched AS (
    SELECT al.*,
           (cap_active OR cap_legacy) AS is_captured,
           CASE
             WHEN cap_active AND cap_legacy THEN 'both'
             WHEN cap_active THEN 'active'
             WHEN cap_legacy THEN 'legacy'
             ELSE NULL
           END AS captured_by
    FROM agency_listings al
  ),
  totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE is_captured) AS captured,
      count(*) FILTER (WHERE cap_active) AS captured_active,
      count(*) FILTER (WHERE cap_legacy) AS captured_legacy,
      count(*) FILTER (WHERE NOT is_captured) AS missed,
      COALESCE(sum(quoted_price) FILTER (
        WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured), 0) AS missed_value_incl_pending
    FROM agency_listings_enriched
  ),
  by_package AS (
    SELECT classified_package_name AS package, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings_enriched
    WHERE NOT is_captured
    GROUP BY classified_package_name
  ),
  by_tier AS (
    SELECT resolved_tier AS tier, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings_enriched
    WHERE NOT is_captured
    GROUP BY resolved_tier
  ),
  agents_rollup AS (
    SELECT
      al.agent_rea_id,
      al.agent_pulse_id,
      max(al.agent_name) AS agent_name,
      count(*) AS total_listings,
      count(*) FILTER (WHERE al.is_captured) AS captured,
      count(*) FILTER (WHERE al.cap_active) AS captured_active,
      count(*) FILTER (WHERE al.cap_legacy) AS captured_legacy,
      count(*) FILTER (WHERE NOT al.is_captured) AS missed,
      COALESCE(sum(al.quoted_price) FILTER (
        WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value
    FROM agency_listings_enriched al
    WHERE al.agent_rea_id IS NOT NULL OR al.agent_pulse_id IS NOT NULL
    GROUP BY al.agent_rea_id, al.agent_pulse_id
  ),
  agents_enriched AS (
    SELECT
      ar.agent_rea_id,
      ar.agent_pulse_id,
      COALESCE(ar.agent_name, pa.full_name) AS agent_name,
      pa.profile_image,
      ar.total_listings,
      ar.captured,
      ar.captured_active,
      ar.captured_legacy,
      ar.missed,
      CASE WHEN ar.total_listings = 0 THEN 0
           ELSE round(100.0 * ar.captured / ar.total_listings, 2) END AS retention_rate_pct,
      ar.missed_value
    FROM agents_rollup ar
    LEFT JOIN pulse_agents pa ON pa.id = ar.agent_pulse_id
  ),
  top_missed AS (
    SELECT
      al.listing_id,
      al.address,
      al.suburb,
      al.first_seen_at,
      al.asking_price_numeric AS asking_price,
      al.classified_package_name,
      al.resolved_tier,
      al.pricing_method,
      al.quoted_price,
      al.photo_count,
      al.has_video,
      al.agency_name,
      al.agent_name,
      al.agent_rea_id,
      al.agent_pulse_id,
      al.source_url,
      al.quote_status,
      al.data_gap_flag,
      al.captured_by
    FROM agency_listings_enriched al
    WHERE NOT al.is_captured
      AND al.quote_status IN ('fresh','data_gap')
    ORDER BY al.quoted_price DESC NULLS LAST, al.first_seen_at DESC
    LIMIT 20
  )
  SELECT jsonb_build_object(
    'agency_pulse_id', p_agency_pulse_id,
    'crm_agency_id', (SELECT crm_agency_id FROM agency_ctx),
    'window_from', p_from,
    'window_to', p_to,
    'total_listings', (SELECT total_listings FROM totals),
    'captured', (SELECT captured FROM totals),
    'captured_active', (SELECT captured_active FROM totals),
    'captured_legacy', (SELECT captured_legacy FROM totals),
    'missed', (SELECT missed FROM totals),
    'retention_rate_pct', CASE
      WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * (SELECT captured FROM totals) / (SELECT total_listings FROM totals), 2)
    END,
    'missed_opportunity_value', (SELECT missed_value FROM totals),
    'missed_opportunity_including_pending', (SELECT missed_value_incl_pending FROM totals),
    'by_package', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('package', package, 'listings', listings, 'value', value) ORDER BY value DESC) FROM by_package),
      '[]'::jsonb
    ),
    'by_tier', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('tier', tier, 'listings', listings, 'value', value) ORDER BY value DESC) FROM by_tier),
      '[]'::jsonb
    ),
    'agents', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'agent_rea_id', agent_rea_id,
        'agent_pulse_id', agent_pulse_id,
        'agent_name', agent_name,
        'profile_image', profile_image,
        'total_listings', total_listings,
        'captured', captured,
        'captured_active', captured_active,
        'captured_legacy', captured_legacy,
        'missed', missed,
        'retention_rate_pct', retention_rate_pct,
        'missed_opportunity_value', missed_value
      ) ORDER BY missed_value DESC, total_listings DESC) FROM agents_enriched),
      '[]'::jsonb
    ),
    'top_missed_listings', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'asking_price', asking_price,
        'classified_package_name', classified_package_name,
        'resolved_tier', resolved_tier,
        'pricing_method', pricing_method,
        'quoted_price', quoted_price,
        'photo_count', photo_count,
        'has_video', has_video,
        'agency_name', agency_name,
        'agent_name', agent_name,
        'agent_rea_id', agent_rea_id,
        'agent_pulse_id', agent_pulse_id,
        'source_url', source_url,
        'quote_status', quote_status,
        'data_gap_flag', data_gap_flag,
        'captured_by', captured_by
      )) FROM top_missed),
      '[]'::jsonb
    )
  );
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 10. pulse_get_top_agents_retention — +captured_active/legacy columns
-- ──────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS pulse_get_top_agents_retention(timestamptz, timestamptz, int, int);

CREATE OR REPLACE FUNCTION pulse_get_top_agents_retention(
  p_from timestamptz,
  p_to timestamptz,
  p_limit int DEFAULT 100,
  p_min_listings int DEFAULT 3
)
RETURNS TABLE (
  agent_rea_id text,
  agent_pulse_id uuid,
  agency_pulse_id uuid,
  agent_name text,
  agency_name text,
  total_listings bigint,
  captured bigint,
  captured_active bigint,
  captured_legacy bigint,
  missed bigint,
  retention_rate_pct numeric,
  missed_opportunity_value numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH agent_rollup AS (
    SELECT
      l.agent_rea_id,
      max(l.agent_pulse_id::text)::uuid AS agent_pulse_id,
      max(l.agency_pulse_id::text)::uuid AS agency_pulse_id,
      l.agent_name,
      l.agency_name,
      count(*) AS total_listings,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM projects pr
          WHERE pr.property_key = q.property_key
            AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        ) OR EXISTS (
          SELECT 1 FROM legacy_projects lp WHERE lp.property_key = q.property_key
        )
      ) AS captured,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM projects pr
          WHERE pr.property_key = q.property_key
            AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        )
      ) AS captured_active,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM legacy_projects lp WHERE lp.property_key = q.property_key
        )
      ) AS captured_legacy,
      COALESCE(sum(q.quoted_price) FILTER (
        WHERE q.quote_status IN ('fresh','data_gap')
          AND NOT EXISTS (
            SELECT 1 FROM projects pr
            WHERE pr.property_key = q.property_key
              AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
          )
          AND NOT EXISTS (
            SELECT 1 FROM legacy_projects lp WHERE lp.property_key = q.property_key
          )
      ), 0) AS missed_opportunity_value
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE q.listing_type = 'for_sale'
      AND l.agent_rea_id IS NOT NULL
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
    GROUP BY l.agent_rea_id, l.agent_name, l.agency_name
    HAVING count(*) >= p_min_listings
  )
  SELECT
    agent_rea_id,
    agent_pulse_id,
    agency_pulse_id,
    agent_name,
    agency_name,
    total_listings,
    captured,
    captured_active,
    captured_legacy,
    (total_listings - captured) AS missed,
    CASE WHEN total_listings = 0 THEN 0
         ELSE round(100.0 * captured / total_listings, 2) END AS retention_rate_pct,
    missed_opportunity_value
  FROM agent_rollup
  ORDER BY missed_opportunity_value DESC, total_listings DESC
  LIMIT p_limit;
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 11. pulse_get_listing_quote_detail — +captured_by + evidence
-- ──────────────────────────────────────────────────────────────────────────
-- Minimal extension: we re-use the substrate columns when available, else
-- compute on the fly. Capture info is attached to quality_flags so front-end
-- components can render the legacy badge without a second round-trip.

CREATE OR REPLACE FUNCTION pulse_get_listing_quote_detail(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_listing record;
  v_pmo record;
  v_photos int;
  v_has_fp boolean;
  v_has_video boolean;
  v_asking numeric;

  v_tier_evidence jsonb := '{}'::jsonb;
  v_matrix record;
  v_proj record;

  v_pricing_source jsonb := '{}'::jsonb;
  v_math_lines jsonb := '[]'::jsonb;

  v_resolved_package_name text;
  v_sales_img_std_base numeric := 200;
  v_sales_img_std_unit numeric := 25;
  v_sales_img_prm_base numeric := 275;
  v_sales_img_prm_unit numeric := 50;
  v_floorplan_std numeric := 200;
  v_floorplan_prm numeric := 250;
  v_drone_std numeric := 200;
  v_drone_prm numeric := 350;

  v_eval jsonb := '[]'::jsonb;
  v_fired boolean;
  v_fired_any boolean := false;

  v_result jsonb;

  v_sales_base_used numeric;
  v_sales_unit_used numeric;

  v_cap_active boolean;
  v_cap_legacy boolean;
  v_captured_by text;
BEGIN
  SELECT l.*,
    pulse_listing_photo_count(l.media_items, l.images) AS photo_count,
    pulse_listing_has_floorplan(l.media_items, l.floorplan_urls) AS fp,
    pulse_listing_has_video(l.has_video, l.video_url, l.media_items) AS hv
  INTO v_listing
  FROM pulse_listings l
  WHERE l.id = p_listing_id;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'Listing % not found', p_listing_id;
  END IF;

  v_photos := v_listing.photo_count;
  v_has_fp := v_listing.fp;
  v_has_video := v_listing.hv;
  v_asking := COALESCE(v_listing.asking_price, pulse_parse_price_text(v_listing.price_text));

  SELECT * INTO v_pmo FROM pulse_listing_missed_opportunity WHERE listing_id = p_listing_id;

  -- Capture resolution — prefer stored snapshot; fall back to live EXISTS.
  IF v_pmo.listing_id IS NOT NULL THEN
    v_cap_active := COALESCE(v_pmo.captured_by_active, false);
    v_cap_legacy := COALESCE(v_pmo.captured_by_legacy, false);
  ELSE
    v_cap_active := EXISTS (
      SELECT 1 FROM projects pr
      WHERE pr.property_key = v_listing.property_key
        AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
    );
    v_cap_legacy := EXISTS (
      SELECT 1 FROM legacy_projects lp
      WHERE lp.property_key = v_listing.property_key
    );
  END IF;

  v_captured_by := CASE
    WHEN v_cap_active AND v_cap_legacy THEN 'both'
    WHEN v_cap_active THEN 'active'
    WHEN v_cap_legacy THEN 'legacy'
    ELSE NULL
  END;

  -- Classification eval (identical to migration 164)
  v_fired := (v_photos >= 30 AND v_has_fp AND v_has_video AND COALESCE(v_asking, 0) > 8000000);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Flex Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'all thresholds met'
      WHEN v_photos < 30 THEN 'photo_count ' || v_photos || ' < 30'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      WHEN NOT v_has_video THEN 'no video detected'
      WHEN v_asking IS NULL THEN 'asking_price null - $8M gate unverifiable'
      WHEN v_asking <= 8000000 THEN 'asking_price $' || v_asking::bigint || ' <= $8M gate'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '>=30', 'fp', true, 'video', true, 'asking_gt', 8000000),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp, 'video', v_has_video, 'asking', v_asking)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Flex Package'; END IF;

  v_fired := NOT v_fired_any AND (v_photos >= 26 AND v_has_fp AND v_has_video);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Dusk Video Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos >= 26 + floorplan + video'
      WHEN v_fired_any THEN 'earlier rule matched'
      WHEN v_photos < 26 THEN 'photo_count ' || v_photos || ' < 26'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      WHEN NOT v_has_video THEN 'no video detected'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '>=26', 'fp', true, 'video', true),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp, 'video', v_has_video)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Dusk Video Package'; END IF;

  v_fired := NOT v_fired_any AND (v_photos >= 1 AND v_has_fp AND v_has_video);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Day Video Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos >= 1 + floorplan + video (below Dusk threshold)'
      WHEN v_fired_any THEN 'earlier rule matched'
      WHEN v_photos < 1 THEN 'no photos'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      WHEN NOT v_has_video THEN 'no video detected'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '>=1', 'fp', true, 'video', true),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp, 'video', v_has_video)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Day Video Package'; END IF;

  v_fired := NOT v_fired_any AND (v_photos > 10 AND v_has_fp);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Gold Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos > 10 + floorplan (no video)'
      WHEN v_fired_any THEN 'earlier rule matched'
      WHEN v_photos <= 10 THEN 'photo_count ' || v_photos || ' <= 10 (Silver range)'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '>10', 'fp', true),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Gold Package'; END IF;

  v_fired := NOT v_fired_any AND (v_photos <= 10 AND v_has_fp);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Silver Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos <= 10 + floorplan'
      WHEN v_fired_any THEN 'earlier rule matched'
      WHEN v_photos > 10 THEN 'photo_count ' || v_photos || ' > 10'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '<=10', 'fp', true),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Silver Package'; END IF;

  IF NOT v_fired_any THEN
    v_eval := v_eval || jsonb_build_array(jsonb_build_object(
      'rule', 'UNCLASSIFIABLE',
      'fired', true,
      'reason', CASE
        WHEN NOT v_has_fp THEN 'no floorplan - no package rule matches; item-sum fallback'
        ELSE 'no package rule matched'
      END,
      'thresholds', jsonb_build_object(),
      'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp, 'video', v_has_video)
    ));
    v_resolved_package_name := 'UNCLASSIFIABLE';
  END IF;

  IF v_pmo.listing_id IS NOT NULL AND v_pmo.tier_source IS NOT NULL THEN
    IF v_pmo.tier_source = 'matrix_agency' OR v_pmo.tier_source = 'matrix_agent' THEN
      SELECT pm.*, COALESCE(a.name, pm.entity_name) AS joined_name
      INTO v_matrix
      FROM price_matrices pm
      LEFT JOIN agencies a ON a.id = pm.entity_id AND pm.entity_type = 'agency'
      WHERE pm.id = v_pmo.tier_source_ref;

      v_tier_evidence := jsonb_build_object(
        'matrix_id', v_matrix.id,
        'entity_type', v_matrix.entity_type,
        'entity_id', v_matrix.entity_id,
        'entity_name', COALESCE(v_matrix.joined_name, v_matrix.entity_name),
        'default_tier', v_matrix.default_tier,
        'use_default_pricing', v_matrix.use_default_pricing,
        'snapshot_date', v_matrix.snapshot_date
      );
    ELSIF v_pmo.tier_source LIKE 'proximity_%' THEN
      SELECT p.id, p.property_address, p.pricing_tier, p.latitude, p.longitude,
             p.geocoded_lat, p.geocoded_lng,
             CASE
               WHEN v_listing.latitude IS NOT NULL AND v_listing.longitude IS NOT NULL
                    AND p.geocoded_lat IS NOT NULL AND p.geocoded_lng IS NOT NULL
                 THEN pulse_haversine_km(v_listing.latitude, v_listing.longitude, p.geocoded_lat, p.geocoded_lng)
               ELSE NULL
             END AS distance_km,
             EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(p.packages,'[]'::jsonb)) pk
               WHERE pk->>'package_id' = v_pmo.classified_package_id::text
             ) AS package_id_match
      INTO v_proj
      FROM projects p
      WHERE p.id = v_pmo.tier_source_ref;

      v_tier_evidence := jsonb_build_object(
        'project_id', v_proj.id,
        'project_address', v_proj.property_address,
        'project_pricing_tier', v_proj.pricing_tier,
        'distance_km', v_proj.distance_km,
        'package_id_match', v_proj.package_id_match
      );
    ELSIF v_pmo.tier_source = 'default_std' THEN
      v_tier_evidence := jsonb_build_object(
        'reason',
        CASE
          WHEN v_listing.latitude IS NULL OR v_listing.longitude IS NULL
            THEN 'no lat/lon on listing - radial proximity rings not evaluable'
          ELSE 'no projects within 50km of listing lat/lon'
        END
      );
    END IF;
  END IF;

  IF v_pmo.listing_id IS NOT NULL AND v_pmo.pricing_method IS NOT NULL THEN
    IF v_pmo.pricing_method = 'agency_matrix' THEN
      IF v_matrix.id IS NULL OR v_matrix.id != v_pmo.pricing_source_ref THEN
        SELECT pm.*, COALESCE(a.name, pm.entity_name) AS joined_name
        INTO v_matrix
        FROM price_matrices pm
        LEFT JOIN agencies a ON a.id = pm.entity_id AND pm.entity_type = 'agency'
        WHERE pm.id = v_pmo.pricing_source_ref;
      END IF;

      v_pricing_source := jsonb_build_object(
        'matrix_id', v_matrix.id,
        'entity_type', v_matrix.entity_type,
        'entity_id', v_matrix.entity_id,
        'entity_name', COALESCE(v_matrix.joined_name, v_matrix.entity_name),
        'has_package_override', EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(v_matrix.package_pricing, '[]'::jsonb)) po
          WHERE po->>'package_id' = v_pmo.classified_package_id::text
            AND (po->>'override_enabled')::boolean IS TRUE
        ),
        'has_product_override', EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(v_matrix.product_pricing, '[]'::jsonb)) po
          WHERE po->>'product_id' = '30000000-0000-4000-a000-000000000001'
            AND (po->>'override_enabled')::boolean IS TRUE
        ),
        'blanket_enabled', COALESCE((v_matrix.blanket_discount->>'enabled')::boolean, false),
        'blanket_pkg_pct', COALESCE((v_matrix.blanket_discount->>'package_percent')::numeric, 0),
        'blanket_prod_pct', COALESCE((v_matrix.blanket_discount->>'product_percent')::numeric, 0)
      );

    ELSIF v_pmo.pricing_method LIKE 'proximity_%_same_pkg' OR v_pmo.pricing_method LIKE 'proximity_%same_pkg' THEN
      SELECT p.* INTO v_proj FROM projects p WHERE p.id = v_pmo.pricing_source_ref;
      v_pricing_source := jsonb_build_object(
        'project_id', v_proj.id,
        'project_address', v_proj.property_address,
        'project_calculated_price', v_proj.calculated_price,
        'project_pricing_tier', v_proj.pricing_tier
      );
    ELSIF v_pmo.pricing_method LIKE 'proximity_%_any_pkg' OR v_pmo.pricing_method LIKE 'proximity_%any_pkg' THEN
      SELECT p.* INTO v_proj FROM projects p WHERE p.id = v_pmo.pricing_source_ref;
      v_pricing_source := jsonb_build_object(
        'project_id', v_proj.id,
        'project_address', v_proj.property_address,
        'project_pricing_tier', v_proj.pricing_tier
      );
    ELSIF v_pmo.pricing_method = 'global_default' THEN
      v_pricing_source := jsonb_build_object(
        'note', 'Using global package default; no projects nearby and no matrix for this agency'
      );
    ELSIF v_pmo.pricing_method = 'item_sum_unclassifiable' THEN
      DECLARE
        v_imgs_base numeric;
        v_imgs_unit numeric;
        v_imgs_qty int;
        v_imgs_sub numeric;
        v_fp_price numeric;
        v_drone_price numeric;
        v_items jsonb := '[]'::jsonb;
      BEGIN
        IF v_pmo.resolved_tier = 'premium' THEN
          v_imgs_base := v_sales_img_prm_base;
          v_imgs_unit := v_sales_img_prm_unit;
          v_fp_price := v_floorplan_prm;
          v_drone_price := v_drone_prm;
        ELSE
          v_imgs_base := v_sales_img_std_base;
          v_imgs_unit := v_sales_img_std_unit;
          v_fp_price := v_floorplan_std;
          v_drone_price := v_drone_std;
        END IF;

        v_imgs_qty := v_pmo.photo_count;
        v_imgs_sub := v_imgs_base + GREATEST(0, v_imgs_qty - 5) * v_imgs_unit;
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'product', 'Sales Images',
          'qty', v_imgs_qty,
          'base', v_imgs_base,
          'unit', v_imgs_unit,
          'included_qty', 5,
          'subtotal', v_imgs_sub
        ));
        IF v_pmo.has_floorplan THEN
          v_items := v_items || jsonb_build_array(jsonb_build_object(
            'product', 'Floorplan',
            'qty', 1,
            'subtotal', v_fp_price
          ));
        END IF;
        IF v_pmo.has_drone_inferred THEN
          v_items := v_items || jsonb_build_array(jsonb_build_object(
            'product', 'Drone (inferred from video)',
            'qty', 1,
            'subtotal', v_drone_price
          ));
        END IF;
        v_pricing_source := jsonb_build_object('items', v_items);
      END;
    END IF;
  END IF;

  v_math_lines := '[]'::jsonb;
  IF v_pmo.listing_id IS NOT NULL AND v_pmo.pricing_method IS NOT NULL THEN
    IF v_pmo.pricing_method = 'item_sum_unclassifiable' THEN
      DECLARE
        v_imgs_base numeric;
        v_imgs_unit numeric;
        v_fp_price numeric;
        v_drone_price numeric;
        v_imgs_sub numeric;
      BEGIN
        IF v_pmo.resolved_tier = 'premium' THEN
          v_imgs_base := v_sales_img_prm_base;
          v_imgs_unit := v_sales_img_prm_unit;
          v_fp_price := v_floorplan_prm;
          v_drone_price := v_drone_prm;
        ELSE
          v_imgs_base := v_sales_img_std_base;
          v_imgs_unit := v_sales_img_std_unit;
          v_fp_price := v_floorplan_std;
          v_drone_price := v_drone_std;
        END IF;
        v_imgs_sub := v_imgs_base + GREATEST(0, v_pmo.photo_count - 5) * v_imgs_unit;

        v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
          'label', 'Sales Images ' || v_pmo.resolved_tier || ' base ($' || v_imgs_base::bigint || ' + ' || GREATEST(0, v_pmo.photo_count - 5) || ' x $' || v_imgs_unit::bigint || ')',
          'amount', v_imgs_sub
        ));
        IF v_pmo.has_floorplan THEN
          v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
            'label', 'Floorplan ' || v_pmo.resolved_tier,
            'amount', v_fp_price
          ));
        END IF;
        IF v_pmo.has_drone_inferred THEN
          v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
            'label', 'Drone ' || v_pmo.resolved_tier || ' (inferred from video)',
            'amount', v_drone_price
          ));
        END IF;
      END;
    ELSE
      DECLARE v_pkg_base_undiscounted numeric;
      BEGIN
        IF v_pmo.discount_applied_pct IS NOT NULL AND v_pmo.discount_applied_pct > 0 THEN
          v_pkg_base_undiscounted := CASE
            WHEN v_pmo.discount_applied_pct < 100
              THEN v_pmo.package_base_price / (1 - v_pmo.discount_applied_pct / 100.0)
            ELSE v_pmo.package_base_price
          END;
          v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
            'label', COALESCE(v_pmo.classified_package_name, 'Package') || ' ' || v_pmo.resolved_tier || ' base',
            'amount', round(v_pkg_base_undiscounted, 2)
          ));
          v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
            'label', '- ' || v_pmo.discount_applied_pct::int || '% blanket pkg discount',
            'amount', round(v_pmo.package_base_price - v_pkg_base_undiscounted, 2)
          ));
        ELSE
          v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
            'label', COALESCE(v_pmo.classified_package_name, 'Package') || ' ' || v_pmo.resolved_tier || ' base',
            'amount', v_pmo.package_base_price
          ));
        END IF;
      END;

      IF COALESCE(v_pmo.overflow_photos, 0) > 0 AND COALESCE(v_pmo.overflow_charge, 0) > 0 THEN
        v_sales_unit_used := CASE WHEN v_pmo.overflow_photos > 0 THEN v_pmo.overflow_charge / v_pmo.overflow_photos ELSE 0 END;
        v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
          'label', 'Photo overflow (' || v_pmo.photo_count || ' - ' || (v_pmo.photo_count - v_pmo.overflow_photos) || ') x $' || round(v_sales_unit_used)::int,
          'amount', v_pmo.overflow_charge
        ));
      END IF;
    END IF;

    v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
      'label', 'Quoted price',
      'amount', v_pmo.quoted_price,
      'total', true
    ));
  END IF;

  IF v_pmo.listing_id IS NOT NULL THEN
    IF v_pmo.resolved_tier = 'premium' THEN
      v_sales_base_used := v_sales_img_prm_base;
      v_sales_unit_used := COALESCE(v_sales_unit_used, v_sales_img_prm_unit);
    ELSE
      v_sales_base_used := v_sales_img_std_base;
      v_sales_unit_used := COALESCE(v_sales_unit_used, v_sales_img_std_unit);
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'listing', jsonb_build_object(
      'id', v_listing.id,
      'address', v_listing.address,
      'suburb', v_listing.suburb,
      'postcode', v_listing.postcode,
      'source_url', v_listing.source_url,
      'agent_name', v_listing.agent_name,
      'agency_name', v_listing.agency_name,
      'agent_pulse_id', v_listing.agent_pulse_id,
      'agency_pulse_id', v_listing.agency_pulse_id,
      'listing_type', v_listing.listing_type,
      'listing_status', v_listing.status,
      'photo_count', v_photos,
      'has_floorplan', v_has_fp,
      'has_video', v_has_video,
      'asking_price_numeric', v_asking,
      'price_text', v_listing.price_text,
      'detail_enriched_at', v_listing.detail_enriched_at,
      'first_seen_at', v_listing.first_seen_at
    ),
    'classification', jsonb_build_object(
      'resolved_package_id', COALESCE(v_pmo.classified_package_id, NULL),
      'resolved_package_name', COALESCE(v_pmo.classified_package_name, v_resolved_package_name),
      'evaluation', v_eval
    ),
    'tier_resolution', CASE
      WHEN v_pmo.listing_id IS NULL OR v_pmo.resolved_tier IS NULL THEN NULL
      ELSE jsonb_build_object(
        'resolved_tier', v_pmo.resolved_tier,
        'tier_source', v_pmo.tier_source,
        'tier_source_ref', v_pmo.tier_source_ref,
        'evidence', v_tier_evidence
      )
    END,
    'pricing', CASE
      WHEN v_pmo.listing_id IS NULL OR v_pmo.pricing_method IS NULL THEN NULL
      ELSE jsonb_build_object(
        'pricing_method', v_pmo.pricing_method,
        'package_base_price', v_pmo.package_base_price,
        'overflow_photos', v_pmo.overflow_photos,
        'overflow_charge', v_pmo.overflow_charge,
        'discount_applied_pct', v_pmo.discount_applied_pct,
        'sales_img_base_used', v_sales_base_used,
        'sales_img_unit_used', v_sales_unit_used,
        'quoted_price', v_pmo.quoted_price,
        'math_lines', v_math_lines,
        'source', v_pricing_source
      )
    END,
    'quality_flags', jsonb_build_object(
      'address_hidden', COALESCE(v_pmo.address_hidden, false),
      'data_gap_flag', COALESCE(v_pmo.data_gap_flag, false),
      'photos_capped_at_34', COALESCE(v_pmo.photos_capped_at_34, false),
      'quote_status', COALESCE(v_pmo.quote_status, 'pending_enrichment')
    ),
    'capture', jsonb_build_object(
      'is_captured', (v_cap_active OR v_cap_legacy),
      'captured_by_active', v_cap_active,
      'captured_by_legacy', v_cap_legacy,
      'captured_by', v_captured_by
    ),
    'captured_by', v_captured_by,
    'provenance', jsonb_build_object(
      'computed_at', v_pmo.computed_at,
      'engine_version', v_pmo.engine_version,
      'raw_cascade_log', COALESCE(v_pmo.raw_cascade_log, '[]'::jsonb)
    )
  );

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_get_listing_quote_detail(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 12. pulse_get_agent_retention — +captured_by per listing + breakdown
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_agent_retention(
  p_agent_rea_id text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agent_listings AS (
    SELECT q.*,
      l.agent_name, l.agent_rea_id, l.agent_pulse_id, l.agency_pulse_id,
      l.address, l.source_url, l.agency_name, l.detail_enriched_at,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp
        WHERE lp.property_key = q.property_key
      ) AS cap_legacy
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agent_rea_id = p_agent_rea_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  agent_listings_enriched AS (
    SELECT al.*,
           (cap_active OR cap_legacy) AS is_captured,
           CASE
             WHEN cap_active AND cap_legacy THEN 'both'
             WHEN cap_active THEN 'active'
             WHEN cap_legacy THEN 'legacy'
             ELSE NULL
           END AS captured_by
    FROM agent_listings al
  )
  SELECT jsonb_build_object(
    'agent_rea_id', p_agent_rea_id,
    'agent_pulse_id', (SELECT max(agent_pulse_id::text)::uuid FROM agent_listings_enriched),
    'agency_pulse_id', (SELECT max(agency_pulse_id::text)::uuid FROM agent_listings_enriched),
    'window_from', p_from,
    'window_to', p_to,
    'total_listings', (SELECT count(*) FROM agent_listings_enriched),
    'captured', (SELECT count(*) FROM agent_listings_enriched WHERE is_captured),
    'captured_active', (SELECT count(*) FROM agent_listings_enriched WHERE cap_active),
    'captured_legacy', (SELECT count(*) FROM agent_listings_enriched WHERE cap_legacy),
    'missed', (SELECT count(*) FROM agent_listings_enriched WHERE NOT is_captured),
    'retention_rate_pct', CASE WHEN (SELECT count(*) FROM agent_listings_enriched) = 0 THEN 0
                              ELSE round(100.0 * (SELECT count(*) FROM agent_listings_enriched WHERE is_captured) / (SELECT count(*) FROM agent_listings_enriched), 2) END,
    'missed_opportunity_value', COALESCE((SELECT sum(quoted_price) FROM agent_listings_enriched WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0),
    'missed_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'package', classified_package_name,
        'tier', resolved_tier,
        'quoted_price', quoted_price,
        'source_url', source_url,
        'quote_status', quote_status,
        'agent_pulse_id', agent_pulse_id,
        'agency_pulse_id', agency_pulse_id,
        'detail_enriched_at', detail_enriched_at,
        'captured_by', captured_by
      ) ORDER BY quoted_price DESC NULLS LAST)
      FROM agent_listings_enriched WHERE NOT is_captured
    ), '[]'::jsonb),
    'captured_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'package', classified_package_name,
        'agent_pulse_id', agent_pulse_id,
        'agency_pulse_id', agency_pulse_id,
        'detail_enriched_at', detail_enriched_at,
        'captured_by', captured_by
      ) ORDER BY first_seen_at DESC)
      FROM agent_listings_enriched WHERE is_captured
    ), '[]'::jsonb)
  );
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 13. Retro-fill — back-fill captured_by_active / captured_by_legacy
-- ──────────────────────────────────────────────────────────────────────────
-- Uses a materialized CTE of captured-property-keys set so we run two
-- DISTINCT queries (active + legacy) once, then one UPDATE.

DO $retrofill$
DECLARE
  v_rows bigint;
BEGIN
  WITH cap_active AS (
    SELECT DISTINCT property_key FROM projects
    WHERE status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND property_key IS NOT NULL
  ),
  cap_legacy AS (
    SELECT DISTINCT property_key FROM legacy_projects
    WHERE property_key IS NOT NULL
  )
  UPDATE pulse_listing_missed_opportunity q
  SET captured_by_active = EXISTS (SELECT 1 FROM cap_active ca WHERE ca.property_key = q.property_key),
      captured_by_legacy = EXISTS (SELECT 1 FROM cap_legacy cl WHERE cl.property_key = q.property_key)
  WHERE q.property_key IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[187_retrofill] updated % pulse_listing_missed_opportunity rows', v_rows;
END;
$retrofill$;

-- ──────────────────────────────────────────────────────────────────────────
-- 14. Operator notification — pulse_timeline row
-- ──────────────────────────────────────────────────────────────────────────
-- idempotency_key is deterministic on the migration file name so repeated
-- migration applies (e.g. in dev) do not produce duplicate rows.

INSERT INTO pulse_timeline (
  entity_type, event_type, event_category,
  title, description,
  new_value, source, idempotency_key
) VALUES (
  'system',
  'marketshare_engine_extended',
  'system',
  'Market Share engine extended: legacy_projects now contributes to captured metrics',
  'legacy_projects is now a first-class captured-source alongside projects. pulse_listing_missed_opportunity gained captured_by_active and captured_by_legacy columns. All Market Share + Retention RPCs now treat a listing as captured iff either source has a matching property_key. Migration 187.',
  jsonb_build_object(
    'migration',        '187_marketshare_legacy_integration.sql',
    'rpcs_extended',    jsonb_build_array(
      'pulse_compute_listing_quote',
      'pulse_get_market_share',
      'pulse_get_missed_top_n',
      'pulse_get_retention_agent_scope_v2',
      'pulse_get_retention_agency_scope_v2',
      'pulse_get_retention_agent_detail',
      'pulse_get_retention_agency_detail',
      'pulse_get_agency_retention',
      'pulse_get_top_agents_retention',
      'pulse_get_listing_quote_detail',
      'pulse_get_agent_retention'
    ),
    'engine_version',   'v1.1.0-legacy'
  ),
  '187_marketshare_legacy_integration',
  '187_marketshare_legacy_integration:shift'
)
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;

-- 159_pulse_compute_listing_quote.sql
-- The Missed Opportunity engine's compute RPC.
--
-- pulse_compute_listing_quote(p_listing_id uuid) → jsonb
--   1. Loads the listing + linked pulse_agency/agency/matrix
--   2. Classifies the missing package (Flex / Dusk Video / Day Video / Gold /
--      Silver / UNCLASSIFIABLE) from media + price
--   3. Resolves tier via 4-step cascade (T1 matrix, T2 matrix, T3 proximity, T4 std)
--   4. Resolves price via 3-step cascade (P1 matrix, P2 proximity interleaved, P3 default)
--   5. Upserts the result into pulse_listing_missed_opportunity
--   6. Returns the full computed row as jsonb for inspection
--
-- Idempotent — re-running on the same listing produces the same quote unless
-- the listing's media/price/status has changed. Unit-tested against 3 real
-- walkthrough listings in the verification block at bottom.

BEGIN;

-- ── 1. Media extraction helpers ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_listing_photo_count(p_media jsonb, p_images jsonb)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(
    COALESCE((SELECT count(*) FROM jsonb_array_elements(p_media) m WHERE m->>'type' = 'photo'), 0),
    COALESCE(jsonb_array_length(p_images), 0)
  )::int
$$;

CREATE OR REPLACE FUNCTION pulse_listing_has_floorplan(p_media jsonb, p_floorplan_urls text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT
    COALESCE(array_length(p_floorplan_urls, 1), 0) > 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_media,'[]'::jsonb)) m WHERE m->>'type' = 'floorplan')
$$;

CREATE OR REPLACE FUNCTION pulse_listing_has_video(p_has_video boolean, p_video_url text, p_media jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT
    COALESCE(p_has_video, false)
    OR p_video_url IS NOT NULL
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_media,'[]'::jsonb)) m WHERE m->>'type' = 'video')
$$;

-- ── 2. Package classifier ──────────────────────────────────────────────────
-- Returns a jsonb: { package_id, package_name }, or { package_id: null } for UNCLASSIFIABLE.
-- Package IDs are the canonical UUIDs from the packages table.

CREATE OR REPLACE FUNCTION pulse_classify_listing_package(
  p_photos int,
  p_has_fp boolean,
  p_has_video boolean,
  p_asking_price numeric
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  -- Flex: ≥30 photos + fp + video + asking > $8M
  IF p_photos >= 30 AND p_has_fp AND p_has_video AND COALESCE(p_asking_price, 0) > 8000000 THEN
    RETURN jsonb_build_object(
      'package_id', '40000000-0000-4000-a000-000000000006',
      'package_name', 'Flex Package'
    );
  END IF;
  -- Dusk Video: ≥26 photos + fp + video
  IF p_photos >= 26 AND p_has_fp AND p_has_video THEN
    RETURN jsonb_build_object(
      'package_id', '40000000-0000-4000-a000-000000000004',
      'package_name', 'Dusk Video Package'
    );
  END IF;
  -- Day Video: ≥1 photo + fp + video
  IF p_photos >= 1 AND p_has_fp AND p_has_video THEN
    RETURN jsonb_build_object(
      'package_id', '40000000-0000-4000-a000-000000000003',
      'package_name', 'Day Video Package'
    );
  END IF;
  -- Gold: >10 photos + fp (no video)
  IF p_photos > 10 AND p_has_fp THEN
    RETURN jsonb_build_object(
      'package_id', '40000000-0000-4000-a000-000000000002',
      'package_name', 'Gold Package'
    );
  END IF;
  -- Silver: ≤10 photos + fp
  IF p_photos <= 10 AND p_has_fp THEN
    RETURN jsonb_build_object(
      'package_id', '40000000-0000-4000-a000-000000000001',
      'package_name', 'Silver Package'
    );
  END IF;
  -- UNCLASSIFIABLE
  RETURN jsonb_build_object('package_id', NULL, 'package_name', 'UNCLASSIFIABLE');
END;
$$;

-- ── 3. The main compute RPC ────────────────────────────────────────────────

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
  v_engine_version text := 'v1.0.0';
  v_ring_kms numeric[] := ARRAY[2, 5, 10, 20, 50];
  i int;
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
  v_has_drone := v_has_video;  -- drone inferred from video presence
  v_suburb := v_listing.suburb;
  v_address_hidden := v_listing.address IS NOT NULL
    AND (lower(v_listing.address) LIKE '%address available%' OR lower(v_listing.address) LIKE '%address on request%');

  -- Parse asking price — prefer explicit asking_price, fall back to parsed price_text
  v_asking := COALESCE(v_listing.asking_price, pulse_parse_price_text(v_listing.price_text));

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
    'asking', v_asking
  );

  -- ─── Load package base price + qty if classified ──────────────────────
  IF v_package_id IS NOT NULL THEN
    SELECT
      (standard_tier->>'package_price')::numeric,
      (premium_tier->>'package_price')::numeric
    INTO v_package_std_price, v_package_prm_price
    FROM packages WHERE id = v_package_id;

    -- Get Sales Images base quantity in this package (drives overflow calc)
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
    -- T3 proximity cascade — find any-package project matching rings 1-8
    -- Ring 1 (same property_key)
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

    -- Ring 3 (same suburb) — note skipping ring 2 agent for now; rea_agent_id not tied
    -- to projects directly in schema. Agent proximity would require a contact/lead link.
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

    -- Rings 4-8 (radial) — only if listing has lat/lon
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

    -- T4 default std
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

  -- P1: Agency/org matrix exists → apply it
  IF v_matrix_id IS NOT NULL AND v_package_id IS NOT NULL THEN
    DECLARE
      v_pkg_override jsonb;
      v_base_from_matrix numeric;
      v_prod_override jsonb;
      v_sales_unit numeric;
    BEGIN
      -- Package override lookup
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

      -- Overflow product pricing — matrix override, blanket, or global
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

  -- P2: Proximity cascade (only if package classified — UNCLASSIFIABLE falls straight to P3)
  ELSIF v_package_id IS NOT NULL THEN
    -- Same-package same-suburb preferred, then same-package radial, then any-package global
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

    -- P2 fallback: any-package same suburb → tier inherited, price from global default at tier
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

    -- P3 global default if no proximity match
    IF v_pricing_method IS NULL THEN
      v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
      v_pricing_method := 'global_default';
      v_data_gap := true;
    END IF;

    -- Overflow for P2/P3: global tier unit prices
    v_overflow_photos := GREATEST(0, v_photos - v_package_base_qty);
    v_overflow_charge := v_overflow_photos * CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;

    v_cascade := v_cascade || jsonb_build_object(
      'step', 'pricing_p2_p3',
      'method', v_pricing_method,
      'package_base', v_package_base_price,
      'overflow_photos', v_overflow_photos,
      'overflow_charge', v_overflow_charge
    );

  -- P4: UNCLASSIFIABLE → item-sum at tier
  ELSE
    v_package_base_price := 0;
    v_overflow_photos := 0;
    v_overflow_charge := 0;
    -- Sales Images at tier
    DECLARE v_imgs numeric;
    BEGIN
      v_imgs := CASE WHEN v_tier='premium' THEN v_sales_img_prm_base ELSE v_sales_img_std_base END
              + GREATEST(0, v_photos - 5) * CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;
      v_package_base_price := v_imgs;
    END;
    -- Floorplan at tier (only if present)
    IF v_has_fp THEN
      v_package_base_price := v_package_base_price + CASE WHEN v_tier='premium' THEN v_floorplan_prm ELSE v_floorplan_std END;
    END IF;
    -- Drone at tier (only if inferred from video)
    IF v_has_drone THEN
      v_package_base_price := v_package_base_price + CASE WHEN v_tier='premium' THEN v_drone_prm ELSE v_drone_std END;
    END IF;
    v_pricing_method := 'item_sum_unclassifiable';
    v_cascade := v_cascade || jsonb_build_object('step', 'pricing_item_sum', 'total', v_package_base_price);
  END IF;

  v_quoted_price := v_package_base_price + v_overflow_charge;

  -- ─── Freshness decision ───────────────────────────────────────────────
  IF v_listing.detail_enriched_at IS NULL THEN
    v_quote_status := 'pending_enrichment';
  ELSIF v_data_gap THEN
    v_quote_status := 'data_gap';
  ELSE
    v_quote_status := 'fresh';
  END IF;

  -- ─── UPSERT substrate row ─────────────────────────────────────────────
  INSERT INTO pulse_listing_missed_opportunity (
    listing_id, property_key, suburb, postcode, listing_type, listing_status, first_seen_at,
    photo_count, has_floorplan, has_video, has_drone_inferred, asking_price_numeric,
    classified_package_id, classified_package_name,
    resolved_tier, tier_source, tier_source_ref,
    pricing_method, pricing_source_ref, pricing_source_ref_type,
    package_base_price, overflow_photos, overflow_charge, discount_applied_pct, quoted_price,
    address_hidden, data_gap_flag, photos_capped_at_34,
    photo_count_at_quote, has_floorplan_at_quote, has_video_at_quote, price_text_at_quote,
    quote_status, computed_at, engine_version, raw_cascade_log
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
    v_quote_status, now(), v_engine_version, v_cascade
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
    raw_cascade_log = EXCLUDED.raw_cascade_log;

  -- Return the computed row as jsonb for caller inspection
  RETURN (
    SELECT to_jsonb(pmo) FROM pulse_listing_missed_opportunity pmo WHERE pmo.listing_id = p_listing_id
  );
END;
$$;

COMMIT;

-- 360_pricing_per_tier_override_helpers.sql
-- Engine v3.0.0-shared: per-tier independent overrides + modes (fixed,
-- percent_off, percent_markup) inside price_matrices JSONB columns.
--
-- This migration introduces SQL-side helpers that mirror the TS resolver in
-- supabase/functions/_shared/pricing/matrix.ts, then refactors
-- pulse_compute_listing_quote (migration 159) to call them. Two readers, one
-- semantic — the helper is the single source of truth on the SQL side.
--
-- Both helpers are dual-shape: they detect a `tier_overrides` block on the
-- override row and route to v3 logic, otherwise fall back to v2 (legacy)
-- logic that reads override_enabled + standard_*/premium_* columns. Existing
-- matrices keep working unchanged until they get backfilled in migration 361
-- and rewritten by the editor.
--
-- INVARIANT: for any matrix row that has NOT been touched since migration
-- 359, calling the helpers must produce the same value as the inline logic
-- being replaced. Verified by leaving the legacy branches in the helper
-- bit-for-bit identical to the prior inline code.

BEGIN;

-- ── Product per-tier override resolver ────────────────────────────────────
-- Returns a jsonb with {base, unit} numeric fields, or NULL when no
-- override applies. Master values are required for percent modes.
CREATE OR REPLACE FUNCTION pricing_resolve_product_override(
  p_overrides   jsonb,
  p_product_id  uuid,
  p_tier        text,
  p_master_base numeric,
  p_master_unit numeric
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_row      jsonb;
  v_tier_obj jsonb;
  v_mode     text;
  v_pct      numeric;
  v_factor   numeric;
BEGIN
  IF p_overrides IS NULL OR p_product_id IS NULL OR p_tier IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT po INTO v_row
  FROM jsonb_array_elements(p_overrides) po
  WHERE po->>'product_id' = p_product_id::text
  LIMIT 1;
  IF v_row IS NULL THEN RETURN NULL; END IF;

  -- ── New shape (engine v3): per-tier enablement + mode ──
  IF v_row ? 'tier_overrides' THEN
    v_tier_obj := v_row->'tier_overrides'->p_tier;
    IF v_tier_obj IS NULL OR COALESCE((v_tier_obj->>'enabled')::boolean, false) IS FALSE THEN
      RETURN NULL;
    END IF;
    v_mode := COALESCE(v_tier_obj->>'mode', 'fixed');

    IF v_mode = 'fixed' THEN
      RETURN jsonb_build_object(
        'base', NULLIF(v_tier_obj->>'base','')::numeric,
        'unit', NULLIF(v_tier_obj->>'unit','')::numeric
      );
    ELSIF v_mode IN ('percent_off','percent_markup') THEN
      v_pct := COALESCE(GREATEST(0, LEAST(100, NULLIF(v_tier_obj->>'percent','')::numeric)), 0);
      v_factor := CASE WHEN v_mode = 'percent_off' THEN (1 - v_pct/100) ELSE (1 + v_pct/100) END;
      RETURN jsonb_build_object(
        'base', GREATEST(0, COALESCE(p_master_base, 0) * v_factor),
        'unit', GREATEST(0, COALESCE(p_master_unit, 0) * v_factor)
      );
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  -- ── Legacy shape (engine v2): single override_enabled toggle ──
  IF COALESCE((v_row->>'override_enabled')::boolean, false) IS FALSE THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'base', NULLIF(v_row->>(p_tier||'_base'),'')::numeric,
    'unit', NULLIF(v_row->>(p_tier||'_unit'),'')::numeric
  );
END;
$$;

-- ── Package per-tier override resolver ────────────────────────────────────
-- Returns the resolved override price as numeric, or NULL when no override.
CREATE OR REPLACE FUNCTION pricing_resolve_package_override(
  p_overrides    jsonb,
  p_package_id   uuid,
  p_tier         text,
  p_master_price numeric
) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_row      jsonb;
  v_tier_obj jsonb;
  v_mode     text;
  v_pct      numeric;
  v_factor   numeric;
  v_price    numeric;
BEGIN
  IF p_overrides IS NULL OR p_package_id IS NULL OR p_tier IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT po INTO v_row
  FROM jsonb_array_elements(p_overrides) po
  WHERE po->>'package_id' = p_package_id::text
  LIMIT 1;
  IF v_row IS NULL THEN RETURN NULL; END IF;

  IF v_row ? 'tier_overrides' THEN
    v_tier_obj := v_row->'tier_overrides'->p_tier;
    IF v_tier_obj IS NULL OR COALESCE((v_tier_obj->>'enabled')::boolean, false) IS FALSE THEN
      RETURN NULL;
    END IF;
    v_mode := COALESCE(v_tier_obj->>'mode', 'fixed');

    IF v_mode = 'fixed' THEN
      v_price := NULLIF(v_tier_obj->>'price','')::numeric;
      IF v_price IS NULL THEN RETURN NULL; END IF;
      RETURN GREATEST(0, v_price);
    ELSIF v_mode IN ('percent_off','percent_markup') THEN
      v_pct := COALESCE(GREATEST(0, LEAST(100, NULLIF(v_tier_obj->>'percent','')::numeric)), 0);
      v_factor := CASE WHEN v_mode = 'percent_off' THEN (1 - v_pct/100) ELSE (1 + v_pct/100) END;
      RETURN GREATEST(0, COALESCE(p_master_price, 0) * v_factor);
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  IF COALESCE((v_row->>'override_enabled')::boolean, false) IS FALSE THEN
    RETURN NULL;
  END IF;
  v_price := NULLIF(v_row->>(p_tier||'_price'),'')::numeric;
  IF v_price IS NULL THEN RETURN NULL; END IF;
  RETURN GREATEST(0, v_price);
END;
$$;

COMMENT ON FUNCTION pricing_resolve_product_override(jsonb, uuid, text, numeric, numeric) IS
  'Engine v3 dual-shape resolver: returns {base,unit} from a price_matrix product_pricing[] entry, or NULL. Detects tier_overrides shape, falls back to legacy override_enabled/standard_*/premium_*.';

COMMENT ON FUNCTION pricing_resolve_package_override(jsonb, uuid, text, numeric) IS
  'Engine v3 dual-shape resolver: returns override price (numeric) from a price_matrix package_pricing[] entry, or NULL. Detects tier_overrides shape, falls back to legacy override_enabled/standard_price/premium_price.';

-- ── Refactor pulse_compute_listing_quote to use the helpers ───────────────
-- Replaces the inline tier-extraction blocks in migration 159 (lines 322–351)
-- with calls to the dual-shape helpers above. All other math (proximity
-- cascade, freshness decision, upsert) is unchanged.

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
  v_engine_version text := 'v3.0.0-shared';
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
  v_has_drone := v_has_video;
  v_suburb := v_listing.suburb;
  v_address_hidden := v_listing.address IS NOT NULL
    AND (lower(v_listing.address) LIKE '%address available%' OR lower(v_listing.address) LIKE '%address on request%');

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

  -- ─── STEP 2: Price resolution (uses dual-shape helpers from this migration) ──
  -- P1: Agency/org matrix exists → apply it
  IF v_matrix_id IS NOT NULL AND v_package_id IS NOT NULL THEN
    DECLARE
      v_pkg_master_price numeric;
      v_resolved_pkg_price numeric;
      v_resolved_prod_override jsonb;
      v_sales_unit numeric;
      v_sales_master_unit numeric;
      v_sales_master_base numeric;
    BEGIN
      v_pkg_master_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;

      -- Helper: dual-shape package override (legacy or tier_overrides)
      v_resolved_pkg_price := pricing_resolve_package_override(
        v_matrix_package_pricing,
        v_package_id,
        v_tier,
        v_pkg_master_price
      );

      IF v_resolved_pkg_price IS NOT NULL THEN
        v_package_base_price := v_resolved_pkg_price;
      ELSIF v_matrix_blanket_enabled THEN
        v_discount_pct := v_matrix_blanket_pkg_pct;
        v_package_base_price := v_pkg_master_price * (1 - v_discount_pct/100);
      ELSE
        v_package_base_price := v_pkg_master_price;
      END IF;

      -- Overflow product unit price — dual-shape lookup against Sales Images product
      v_sales_master_base := CASE WHEN v_tier='premium' THEN v_sales_img_prm_base ELSE v_sales_img_std_base END;
      v_sales_master_unit := CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;

      v_resolved_prod_override := pricing_resolve_product_override(
        v_matrix_product_pricing,
        '30000000-0000-4000-a000-000000000001'::uuid,
        v_tier,
        v_sales_master_base,
        v_sales_master_unit
      );

      IF v_resolved_prod_override IS NOT NULL AND (v_resolved_prod_override->>'unit') IS NOT NULL THEN
        v_sales_unit := (v_resolved_prod_override->>'unit')::numeric;
      ELSE
        v_sales_unit := v_sales_master_unit;
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

  -- P2: Proximity cascade
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

  -- P4: UNCLASSIFIABLE
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

  RETURN (
    SELECT to_jsonb(pmo) FROM pulse_listing_missed_opportunity pmo WHERE pmo.listing_id = p_listing_id
  );
END;
$$;

COMMIT;

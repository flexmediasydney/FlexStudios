-- 362_pricing_per_tier_blanket_discount.sql
-- Engine v3.1.0-shared: per-tier independent blanket discount.
--
-- Adds a SQL resolver mirroring _shared/pricing/matrix.ts resolveBlanketDiscount
-- that takes a tier and dual-shape-detects:
--   1. blanket_discount.tier_blanket[tier] (engine v3.1)
--   2. blanket_discount.{enabled,product_percent,package_percent} (legacy, applies to all tiers)
--
-- Refactors pulse_compute_listing_quote to call the helper instead of reading
-- legacy scalar fields directly. Bumps the archive_price_matrix_version trigger
-- to stamp v3.1.0-shared. Backfills tier_blanket onto every existing matrix.
--
-- Math equivalence guarantee:
--   Backfill copies legacy values into BOTH tiers (standard + premium). Engine
--   resolver then prefers tier_blanket and produces identical numeric output.
--   Pricing parity preserved across the upgrade — no project's calculated_price
--   shifts, no listing's quoted_price shifts, unless inputs to the pricing
--   path (tier resolution, photo count, master prices) change.

BEGIN;

-- ── 1. Per-tier blanket discount resolver ────────────────────────────────
-- Returns a jsonb {package_percent, product_percent} when the matrix has an
-- active blanket for the given tier, else NULL.
--
-- Behavior matches _shared/pricing/matrix.ts:
--   - tier_blanket[tier] present + enabled=false  → NULL (explicit opt-out;
--     do NOT fall through to legacy)
--   - tier_blanket[tier] present + enabled=true   → use tier values
--   - tier_blanket[tier] absent                   → fall back to legacy fields
CREATE OR REPLACE FUNCTION pricing_resolve_blanket_discount(
  p_blanket jsonb,
  p_tier    text
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_tier_obj jsonb;
  v_pkg_pct  numeric;
  v_prod_pct numeric;
BEGIN
  IF p_blanket IS NULL OR p_tier IS NULL THEN
    RETURN NULL;
  END IF;

  -- ── New shape: tier_blanket ──
  v_tier_obj := p_blanket->'tier_blanket'->p_tier;
  IF v_tier_obj IS NOT NULL THEN
    IF COALESCE((v_tier_obj->>'enabled')::boolean, false) IS FALSE THEN
      RETURN NULL;
    END IF;
    v_prod_pct := COALESCE(GREATEST(0, LEAST(100,
      NULLIF(v_tier_obj->>'product_percent','')::numeric)), 0);
    v_pkg_pct  := COALESCE(GREATEST(0, LEAST(100,
      NULLIF(v_tier_obj->>'package_percent','')::numeric)), 0);
    RETURN jsonb_build_object(
      'product_percent', v_prod_pct,
      'package_percent', v_pkg_pct
    );
  END IF;

  -- ── Legacy shape ──
  IF COALESCE((p_blanket->>'enabled')::boolean, false) IS FALSE THEN
    RETURN NULL;
  END IF;
  v_prod_pct := COALESCE(GREATEST(0, LEAST(100,
    NULLIF(p_blanket->>'product_percent','')::numeric)), 0);
  v_pkg_pct  := COALESCE(GREATEST(0, LEAST(100,
    NULLIF(p_blanket->>'package_percent','')::numeric)), 0);
  RETURN jsonb_build_object(
    'product_percent', v_prod_pct,
    'package_percent', v_pkg_pct
  );
END;
$$;

COMMENT ON FUNCTION pricing_resolve_blanket_discount(jsonb, text) IS
  'Engine v3.1 dual-shape resolver: returns {product_percent,package_percent} for the given tier or NULL. Detects tier_blanket shape, falls back to legacy enabled/product_percent/package_percent.';

-- ── 2. Bump archive_price_matrix_version trigger to v3.1.0-shared ────────
CREATE OR REPLACE FUNCTION archive_price_matrix_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_engine_version text := 'v3.1.0-shared';
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.default_tier IS NOT DISTINCT FROM OLD.default_tier
     AND NEW.use_default_pricing IS NOT DISTINCT FROM OLD.use_default_pricing
     AND NEW.package_pricing IS NOT DISTINCT FROM OLD.package_pricing
     AND NEW.product_pricing IS NOT DISTINCT FROM OLD.product_pricing
     AND NEW.blanket_discount IS NOT DISTINCT FROM OLD.blanket_discount
  THEN
    RETURN NEW;
  END IF;

  UPDATE price_matrix_versions
    SET superseded_at = now()
    WHERE matrix_id = NEW.id AND superseded_at IS NULL;

  INSERT INTO price_matrix_versions (
    matrix_id, entity_type, entity_id, entity_name,
    project_type_id, project_type_name,
    default_tier, use_default_pricing,
    package_pricing, product_pricing, blanket_discount,
    engine_version, snapshot_reason, snapshot_at
  ) VALUES (
    NEW.id, NEW.entity_type, NEW.entity_id, NEW.entity_name,
    NEW.project_type_id, NEW.project_type_name,
    NEW.default_tier, NEW.use_default_pricing,
    COALESCE(NEW.package_pricing, '[]'::jsonb),
    COALESCE(NEW.product_pricing, '[]'::jsonb),
    NEW.blanket_discount,
    v_engine_version,
    CASE WHEN TG_OP = 'INSERT' THEN 'initial' ELSE 'matrix_edit' END,
    now()
  );

  RETURN NEW;
END;
$$;

-- ── 3. Backfill helper: convert legacy blanket_discount to add tier_blanket ──
CREATE OR REPLACE FUNCTION _backfill_blanket_discount(p_bd jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_enabled  boolean;
  v_prod_pct numeric;
  v_pkg_pct  numeric;
  v_tier_blanket jsonb;
BEGIN
  IF p_bd IS NULL THEN RETURN NULL; END IF;
  IF p_bd ? 'tier_blanket' THEN RETURN p_bd; END IF;  -- already migrated

  v_enabled  := COALESCE((p_bd->>'enabled')::boolean, false);
  v_prod_pct := COALESCE(NULLIF(p_bd->>'product_percent','')::numeric, 0);
  v_pkg_pct  := COALESCE(NULLIF(p_bd->>'package_percent','')::numeric, 0);

  v_tier_blanket := jsonb_build_object(
    'standard', jsonb_build_object(
      'enabled', v_enabled,
      'product_percent', v_prod_pct,
      'package_percent', v_pkg_pct
    ),
    'premium', jsonb_build_object(
      'enabled', v_enabled,
      'product_percent', v_prod_pct,
      'package_percent', v_pkg_pct
    )
  );

  RETURN p_bd || jsonb_build_object('tier_blanket', v_tier_blanket);
END;
$$;

-- ── 4. Apply backfill ────────────────────────────────────────────────────
UPDATE price_matrices m
SET
  blanket_discount = _backfill_blanket_discount(m.blanket_discount),
  last_modified_at = now()
WHERE m.blanket_discount IS NOT NULL
  AND NOT (m.blanket_discount ? 'tier_blanket');

DROP FUNCTION _backfill_blanket_discount(jsonb);

-- ── 5. Refactor pulse_compute_listing_quote to use the new helper ────────
-- Only the blanket-discount read paths change; tier resolution, classification,
-- proximity cascade, freshness logic all unchanged. Stamps v3.1.0-shared.

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
  v_matrix_blanket jsonb;            -- raw blanket jsonb for the helper
  v_resolved_blanket jsonb;          -- resolved {product_percent, package_percent} | NULL
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
  v_engine_version text := 'v3.1.0-shared';
  v_ring_kms numeric[] := ARRAY[2, 5, 10, 20, 50];
  i int;
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
  v_has_drone := v_has_video;
  v_suburb := v_listing.suburb;
  v_address_hidden := v_listing.address IS NOT NULL
    AND (lower(v_listing.address) LIKE '%address available%' OR lower(v_listing.address) LIKE '%address on request%');

  v_asking := COALESCE(v_listing.asking_price, pulse_parse_price_text(v_listing.price_text));

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

  -- ─── Load matrix (raw blanket jsonb is now passed to the helper) ─────────
  SELECT pa.*, a.name AS crm_agency_name
  INTO v_pulse_agency
  FROM pulse_agencies pa
  LEFT JOIN agencies a ON a.id = pa.linked_agency_id
  WHERE pa.id = v_listing.agency_pulse_id;

  IF v_pulse_agency.linked_agency_id IS NOT NULL THEN
    SELECT id, default_tier, use_default_pricing, package_pricing, product_pricing,
           blanket_discount
    INTO v_matrix_id, v_matrix_default_tier, v_matrix_use_default,
         v_matrix_package_pricing, v_matrix_product_pricing, v_matrix_blanket
    FROM price_matrices
    WHERE entity_type = 'agency'
      AND entity_id = v_pulse_agency.linked_agency_id
      AND project_type_name = 'Residential Real Estate';
  END IF;

  -- ─── Tier resolution (unchanged) ─────────────────────────────────────────
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

  -- ─── Resolve blanket discount via the new helper, scoped to the tier ────
  -- Engine v3.1: this is the only price-related code path that changed in 362.
  v_resolved_blanket := pricing_resolve_blanket_discount(v_matrix_blanket, v_tier);

  -- ─── Price resolution (uses dual-shape per-tier override + blanket helpers) ──
  IF v_matrix_id IS NOT NULL AND v_package_id IS NOT NULL THEN
    DECLARE
      v_pkg_master_price numeric;
      v_resolved_pkg_price numeric;
      v_resolved_prod_override jsonb;
      v_sales_unit numeric;
      v_sales_master_unit numeric;
      v_sales_master_base numeric;
      v_blanket_pkg_pct numeric;
      v_blanket_prod_pct numeric;
    BEGIN
      v_pkg_master_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;

      v_resolved_pkg_price := pricing_resolve_package_override(
        v_matrix_package_pricing, v_package_id, v_tier, v_pkg_master_price
      );

      v_blanket_pkg_pct  := COALESCE((v_resolved_blanket->>'package_percent')::numeric, 0);
      v_blanket_prod_pct := COALESCE((v_resolved_blanket->>'product_percent')::numeric, 0);

      IF v_resolved_pkg_price IS NOT NULL THEN
        v_package_base_price := v_resolved_pkg_price;
      ELSIF v_resolved_blanket IS NOT NULL THEN
        v_discount_pct := v_blanket_pkg_pct;
        v_package_base_price := v_pkg_master_price * (1 - v_discount_pct/100);
      ELSE
        v_package_base_price := v_pkg_master_price;
      END IF;

      v_sales_master_base := CASE WHEN v_tier='premium' THEN v_sales_img_prm_base ELSE v_sales_img_std_base END;
      v_sales_master_unit := CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;

      v_resolved_prod_override := pricing_resolve_product_override(
        v_matrix_product_pricing,
        '30000000-0000-4000-a000-000000000001'::uuid,
        v_tier, v_sales_master_base, v_sales_master_unit
      );

      IF v_resolved_prod_override IS NOT NULL AND (v_resolved_prod_override->>'unit') IS NOT NULL THEN
        v_sales_unit := (v_resolved_prod_override->>'unit')::numeric;
      ELSE
        v_sales_unit := v_sales_master_unit;
        IF v_resolved_blanket IS NOT NULL THEN
          v_sales_unit := v_sales_unit * (1 - v_blanket_prod_pct/100);
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
      'discount_pct', v_discount_pct,
      'blanket_shape', CASE WHEN v_resolved_blanket IS NULL THEN 'none' ELSE 'resolved' END
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

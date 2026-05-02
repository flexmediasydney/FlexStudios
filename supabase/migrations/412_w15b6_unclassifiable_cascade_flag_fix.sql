-- Migration 412 — W15b.6 follow-up fix: UNCLASSIFIABLE / quoted_via inconsistency
--
-- Symptom: W15b.7 smoke surfaced rows with `classified_package_name = 'UNCLASSIFIABLE'`
-- but `quoted_via = 'crude_v1'`. Per the W15b.6 design spec, UNCLASSIFIABLE is a
-- V2-only verdict — when the cascade lands on UNCLASSIFIABLE the row must be
-- stamped with `quoted_via = 'vision_v2_unclassifiable'` and `data_gap_flag = TRUE`.
--
-- Root cause (not what the smoke ticket initially described): the V1 crude
-- classifier (`pulse_classify_listing_package`, migration 159) returns the
-- literal string `'UNCLASSIFIABLE'` as its own no-signal sentinel. The W15b.6
-- cascade routes V2's PENDING_VISION (no extract yet) → V1 fallback. When the
-- listing also has too few signals for V1 to pick a tier, V1's UNCLASSIFIABLE
-- string leaks into PMO under the V1 path, producing the inconsistent
-- (UNCLASSIFIABLE × crude_v1) shape.
--
-- Fix: in the V1 fallback branch, detect V1's UNCLASSIFIABLE sentinel and
-- promote the row into the cascade's V2-style UNCLASSIFIABLE shape:
--   - quoted_via = 'vision_v2_unclassifiable'
--   - data_gap_flag = TRUE
--   - package_name preserved as 'UNCLASSIFIABLE'
-- This keeps the cascade's invariant ("UNCLASSIFIABLE ⇒ vision_v2_unclassifiable
-- + data_gap_flag") clean, regardless of which classifier produced the verdict.
--
-- Backfill: per the smoke's literal WHERE clause, fix the 2,959 existing rows
-- (49 from v3.2.0-vision + 2,910 from earlier engines that inherited the
-- 'crude_v1' default when the column was added in mig 405). Aligning all
-- inconsistent rows to (vision_v2_unclassifiable + data_gap_flag=TRUE) lets
-- downstream dashboards rely on the invariant.
--
-- All other branches of the cascade are untouched. The V2-extract-present
-- UNCLASSIFIABLE path already worked correctly (migration 405 lines 170-189).

-- ─────────────────────────────────────────────────────────────────────────────
-- Function patch: pulse_compute_listing_quote v3.2.1-vision
-- Only the V1 fallback branch is modified. Everything else is identical to mig 405.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.pulse_compute_listing_quote(p_listing_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_listing record;
  v_pulse_agency record;
  v_matrix_id uuid;
  v_matrix_default_tier text;
  v_matrix_use_default boolean;
  v_matrix_package_pricing jsonb;
  v_matrix_product_pricing jsonb;
  v_matrix_blanket jsonb;
  v_resolved_blanket jsonb;
  v_classification jsonb;
  v_v2_classification jsonb;
  v_v2_name text;
  v_v2_package_id uuid;
  v_v2_confidence numeric;
  v_v2_addons jsonb := '[]'::jsonb;
  v_v2_used boolean := false;
  v_v2_unclassifiable boolean := false;
  v_quoted_via text := 'crude_v1';
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
  v_engine_version text := 'v3.2.1-vision';
  v_ring_kms numeric[] := ARRAY[2, 5, 10, 20, 50];
  i int;
BEGIN
  SELECT l.*,
    pulse_listing_photo_count(l.media_items, l.images) AS photo_count,
    pulse_listing_has_floorplan(l.media_items, l.floorplan_urls) AS fp,
    pulse_listing_has_video(l.has_video, l.video_url, l.media_items) AS hv
  INTO v_listing FROM pulse_listings l WHERE l.id = p_listing_id;
  IF v_listing.id IS NULL THEN RAISE EXCEPTION 'Listing % not found', p_listing_id; END IF;
  v_photos := v_listing.photo_count; v_has_fp := v_listing.fp; v_has_video := v_listing.hv;
  v_has_drone := v_has_video; v_suburb := v_listing.suburb;
  v_address_hidden := v_listing.address IS NOT NULL
    AND (lower(v_listing.address) LIKE '%address available%' OR lower(v_listing.address) LIKE '%address on request%');
  v_asking := COALESCE(v_listing.asking_price, pulse_parse_price_text(v_listing.price_text));

  BEGIN
    v_v2_classification := pulse_classify_listing_package_v2(p_listing_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pulse_classify_listing_package_v2(%) threw: % — falling back to V1 crude classifier', p_listing_id, SQLERRM;
    v_v2_classification := NULL;
  END;

  IF v_v2_classification IS NOT NULL THEN
    v_v2_name       := v_v2_classification->>'classified_package_name';
    v_v2_package_id := NULLIF(v_v2_classification->>'classified_package_id', '')::uuid;
    v_v2_confidence := COALESCE((v_v2_classification->>'classification_confidence')::numeric, 0.0);
    v_v2_addons     := COALESCE(v_v2_classification->'add_on_items', '[]'::jsonb);
  END IF;

  IF v_v2_classification IS NOT NULL
     AND v_v2_package_id IS NOT NULL
     AND v_v2_name IS NOT NULL
     AND v_v2_name NOT IN ('PENDING_VISION', 'UNCLASSIFIABLE') THEN
    v_package_id    := v_v2_package_id;
    v_package_name  := v_v2_name;
    v_quoted_via    := 'vision_v2';
    v_v2_used       := true;
    v_cascade := v_cascade || jsonb_build_object(
      'step', 'classify_v2_vision',
      'package_id', v_package_id,
      'package_name', v_package_name,
      'confidence', v_v2_confidence,
      'add_on_items', v_v2_addons,
      'reason', v_v2_classification->'classification_reason',
      'extract_id', v_v2_classification->>'extract_id',
      'extract_status', v_v2_classification->>'extract_status'
    );
  ELSIF v_v2_classification IS NOT NULL AND v_v2_name = 'UNCLASSIFIABLE' THEN
    v_package_id        := NULL;
    v_package_name      := 'UNCLASSIFIABLE';
    v_quoted_via        := 'vision_v2_unclassifiable';
    v_v2_unclassifiable := true;
    v_data_gap          := true;
    v_cascade := v_cascade || jsonb_build_object(
      'step', 'classify_v2_unclassifiable',
      'package_id', NULL,
      'package_name', 'UNCLASSIFIABLE',
      'confidence', v_v2_confidence,
      'reason', v_v2_classification->'classification_reason',
      'extract_id', v_v2_classification->>'extract_id',
      'extract_status', v_v2_classification->>'extract_status',
      'review_required', true
    );
  ELSE
    -- V2 returned PENDING_VISION (no extract) or threw — fall back to V1.
    v_classification := pulse_classify_listing_package(v_photos, v_has_fp, v_has_video, v_asking);
    v_package_id   := NULLIF(v_classification->>'package_id', '')::uuid;
    v_package_name := v_classification->>'package_name';

    -- W15b.6 follow-up fix: V1 returns the literal 'UNCLASSIFIABLE' sentinel
    -- when no rule matches. Per spec, UNCLASSIFIABLE must always coexist with
    -- quoted_via='vision_v2_unclassifiable' + data_gap_flag=TRUE — promote
    -- this V1 verdict into the unified UNCLASSIFIABLE shape so the invariant
    -- "UNCLASSIFIABLE ⇒ vision_v2_unclassifiable + data_gap_flag" holds
    -- regardless of which classifier produced it.
    IF v_package_name = 'UNCLASSIFIABLE' THEN
      v_quoted_via := 'vision_v2_unclassifiable';
      v_data_gap   := true;
      v_cascade := v_cascade || jsonb_build_object(
        'step', 'classify_v1_unclassifiable_promoted',
        'package_id', NULL,
        'package_name', 'UNCLASSIFIABLE',
        'photos', v_photos,
        'fp', v_has_fp,
        'video', v_has_video,
        'asking', v_asking,
        'reason', CASE
          WHEN v_v2_classification IS NULL THEN 'v2_threw_or_missing'
          WHEN v_v2_name = 'PENDING_VISION' THEN 'no_vision_extract'
          ELSE 'v2_returned_null_package'
        END,
        'note', 'V1 fallback produced UNCLASSIFIABLE — promoted to vision_v2_unclassifiable shape per spec invariant',
        'review_required', true
      );
    ELSE
      v_quoted_via := 'crude_v1';
      v_cascade := v_cascade || jsonb_build_object(
        'step', 'classify_v1_crude_fallback',
        'package_id', v_package_id,
        'package_name', v_package_name,
        'photos', v_photos,
        'fp', v_has_fp,
        'video', v_has_video,
        'asking', v_asking,
        'reason', CASE
          WHEN v_v2_classification IS NULL THEN 'v2_threw_or_missing'
          WHEN v_v2_name = 'PENDING_VISION' THEN 'no_vision_extract'
          ELSE 'v2_returned_null_package'
        END
      );
    END IF;
  END IF;

  IF v_package_id IS NOT NULL THEN
    SELECT (standard_tier->>'package_price')::numeric, (premium_tier->>'package_price')::numeric
    INTO v_package_std_price, v_package_prm_price FROM packages WHERE id = v_package_id;
    SELECT (COALESCE(
      (SELECT (p->>'quantity')::int FROM jsonb_array_elements(products) p
       WHERE p->>'product_id' = '30000000-0000-4000-a000-000000000001' LIMIT 1), 5))
    INTO v_package_base_qty FROM packages WHERE id = v_package_id;
  END IF;
  SELECT pa.*, a.name AS crm_agency_name INTO v_pulse_agency FROM pulse_agencies pa
  LEFT JOIN agencies a ON a.id = pa.linked_agency_id WHERE pa.id = v_listing.agency_pulse_id;
  IF v_pulse_agency.linked_agency_id IS NOT NULL THEN
    SELECT id, default_tier, use_default_pricing, package_pricing, product_pricing, blanket_discount
    INTO v_matrix_id, v_matrix_default_tier, v_matrix_use_default,
         v_matrix_package_pricing, v_matrix_product_pricing, v_matrix_blanket
    FROM price_matrices
    WHERE entity_type = 'agency' AND entity_id = v_pulse_agency.linked_agency_id
      AND project_type_name = 'Residential Real Estate';
  END IF;
  IF v_matrix_id IS NOT NULL AND v_matrix_default_tier IS NOT NULL THEN
    v_tier := v_matrix_default_tier; v_tier_source := 'matrix_agency'; v_tier_source_ref := v_matrix_id;
    v_cascade := v_cascade || jsonb_build_object('step','tier_t2_matrix','matched',true,'tier',v_tier);
  ELSE
    SELECT id, pricing_tier, property_address INTO v_proximity_match FROM projects
    WHERE property_key = v_listing.property_key AND NOT v_address_hidden
      AND status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pricing_tier IS NOT NULL LIMIT 1;
    IF v_proximity_match.id IS NOT NULL THEN
      v_tier := v_proximity_match.pricing_tier; v_tier_source := 'proximity_same_property';
      v_tier_source_ref := v_proximity_match.id;
    END IF;
    IF v_tier IS NULL AND v_listing.suburb IS NOT NULL THEN
      SELECT id, pricing_tier, property_address INTO v_proximity_match FROM projects
      WHERE pulse_extract_suburb(property_address) = v_listing.suburb
        AND status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        AND pricing_tier IS NOT NULL ORDER BY created_at DESC LIMIT 1;
      IF v_proximity_match.id IS NOT NULL THEN
        v_tier := v_proximity_match.pricing_tier; v_tier_source := 'proximity_same_suburb';
        v_tier_source_ref := v_proximity_match.id;
      END IF;
    END IF;
    IF v_tier IS NULL AND v_listing.latitude IS NOT NULL AND v_listing.longitude IS NOT NULL THEN
      FOR i IN 1..5 LOOP
        v_ring_km := v_ring_kms[i];
        SELECT id, pricing_tier, property_address, pulse_haversine_km(v_listing.latitude, v_listing.longitude, geocoded_lat, geocoded_lng) AS dist
        INTO v_proximity_match FROM projects
        WHERE geocoded_lat IS NOT NULL AND geocoded_lng IS NOT NULL
          AND status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
          AND pricing_tier IS NOT NULL
          AND pulse_haversine_km(v_listing.latitude, v_listing.longitude, geocoded_lat, geocoded_lng) <= v_ring_km
        ORDER BY pulse_haversine_km(v_listing.latitude, v_listing.longitude, geocoded_lat, geocoded_lng) ASC LIMIT 1;
        IF v_proximity_match.id IS NOT NULL THEN
          v_tier := v_proximity_match.pricing_tier;
          v_tier_source := 'proximity_radial_' || v_ring_km::text || 'km';
          v_tier_source_ref := v_proximity_match.id; EXIT;
        END IF;
      END LOOP;
    END IF;
    IF v_tier IS NULL THEN
      v_tier := 'standard'; v_tier_source := 'default_std'; v_data_gap := true;
    END IF;
    v_cascade := v_cascade || jsonb_build_object('step','tier_proximity','tier',v_tier,'source',v_tier_source,'source_ref',v_tier_source_ref);
  END IF;
  v_resolved_blanket := pricing_resolve_blanket_discount(v_matrix_blanket, v_tier);
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
      v_resolved_pkg_price := pricing_resolve_package_override(v_matrix_package_pricing, v_package_id, v_tier, v_pkg_master_price);
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
        v_matrix_product_pricing, '30000000-0000-4000-a000-000000000001'::uuid,
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
      v_pricing_source_ref := v_matrix_id; v_pricing_source_ref_type := 'price_matrix';
    END;
    v_cascade := v_cascade || jsonb_build_object(
      'step','pricing_p1_matrix','matrix_id',v_matrix_id,'package_base',v_package_base_price,
      'overflow_photos',v_overflow_photos,'overflow_charge',v_overflow_charge,'discount_pct',v_discount_pct,
      'blanket_shape', CASE WHEN v_resolved_blanket IS NULL THEN 'none' ELSE 'resolved' END
    );
  ELSIF v_package_id IS NOT NULL THEN
    IF v_listing.suburb IS NOT NULL THEN
      SELECT p.id, p.pricing_tier, p.calculated_price INTO v_proximity_match FROM projects p
      WHERE pulse_extract_suburb(p.property_address) = v_listing.suburb
        AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        AND p.calculated_price IS NOT NULL AND p.calculated_price > 0
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.packages,'[]'::jsonb)) pkg
                    WHERE pkg->>'package_id' = v_package_id::text)
      ORDER BY p.created_at DESC LIMIT 1;
      IF v_proximity_match.id IS NOT NULL THEN
        v_package_base_price := v_proximity_match.calculated_price;
        v_pricing_method := 'proximity_suburb_same_pkg';
        v_pricing_source_ref := v_proximity_match.id; v_pricing_source_ref_type := 'project';
      END IF;
    END IF;
    IF v_pricing_method IS NULL AND v_listing.suburb IS NOT NULL THEN
      SELECT p.id, p.pricing_tier INTO v_proximity_match FROM projects p
      WHERE pulse_extract_suburb(p.property_address) = v_listing.suburb
        AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ORDER BY p.created_at DESC LIMIT 1;
      IF v_proximity_match.id IS NOT NULL THEN
        v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
        v_pricing_method := 'proximity_suburb_any_pkg';
        v_pricing_source_ref := v_proximity_match.id; v_pricing_source_ref_type := 'project';
      END IF;
    END IF;
    IF v_pricing_method IS NULL THEN
      v_package_base_price := CASE WHEN v_tier='premium' THEN COALESCE(v_package_prm_price,0) ELSE COALESCE(v_package_std_price,0) END;
      v_pricing_method := 'global_default'; v_data_gap := true;
    END IF;
    v_overflow_photos := GREATEST(0, v_photos - v_package_base_qty);
    v_overflow_charge := v_overflow_photos * CASE WHEN v_tier='premium' THEN v_sales_img_prm_unit ELSE v_sales_img_std_unit END;
    v_cascade := v_cascade || jsonb_build_object(
      'step','pricing_p2_p3','method',v_pricing_method,'package_base',v_package_base_price,
      'overflow_photos',v_overflow_photos,'overflow_charge',v_overflow_charge
    );
  ELSE
    v_package_base_price := 0; v_overflow_photos := 0; v_overflow_charge := 0;
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
    v_cascade := v_cascade || jsonb_build_object('step','pricing_item_sum','total',v_package_base_price);
  END IF;
  v_quoted_price := v_package_base_price + v_overflow_charge;
  IF v_listing.detail_enriched_at IS NULL THEN v_quote_status := 'pending_enrichment';
  ELSIF v_data_gap THEN v_quote_status := 'data_gap';
  ELSE v_quote_status := 'fresh';
  END IF;

  INSERT INTO pulse_listing_missed_opportunity (
    listing_id, property_key, suburb, postcode, listing_type, listing_status, first_seen_at,
    photo_count, has_floorplan, has_video, has_drone_inferred, asking_price_numeric,
    classified_package_id, classified_package_name, resolved_tier, tier_source, tier_source_ref,
    pricing_method, pricing_source_ref, pricing_source_ref_type,
    package_base_price, overflow_photos, overflow_charge, discount_applied_pct, quoted_price,
    address_hidden, data_gap_flag, photos_capped_at_34,
    photo_count_at_quote, has_floorplan_at_quote, has_video_at_quote, price_text_at_quote,
    quote_status, computed_at, engine_version, raw_cascade_log,
    quoted_via
  ) VALUES (
    v_listing.id, v_listing.property_key, v_listing.suburb, v_listing.postcode, v_listing.listing_type, v_listing.status, v_listing.first_seen_at,
    v_photos, v_has_fp, v_has_video, v_has_drone, v_asking,
    v_package_id, v_package_name, v_tier, v_tier_source, v_tier_source_ref,
    v_pricing_method, v_pricing_source_ref, v_pricing_source_ref_type,
    v_package_base_price, v_overflow_photos, v_overflow_charge, v_discount_pct, v_quoted_price,
    v_address_hidden, v_data_gap, (v_photos = 34),
    v_photos, v_has_fp, v_has_video, v_listing.price_text,
    v_quote_status, now(), v_engine_version, v_cascade,
    v_quoted_via
  )
  ON CONFLICT (listing_id) DO UPDATE SET
    property_key = EXCLUDED.property_key, suburb = EXCLUDED.suburb, postcode = EXCLUDED.postcode,
    listing_type = EXCLUDED.listing_type, listing_status = EXCLUDED.listing_status, first_seen_at = EXCLUDED.first_seen_at,
    photo_count = EXCLUDED.photo_count, has_floorplan = EXCLUDED.has_floorplan, has_video = EXCLUDED.has_video,
    has_drone_inferred = EXCLUDED.has_drone_inferred, asking_price_numeric = EXCLUDED.asking_price_numeric,
    classified_package_id = EXCLUDED.classified_package_id, classified_package_name = EXCLUDED.classified_package_name,
    resolved_tier = EXCLUDED.resolved_tier, tier_source = EXCLUDED.tier_source, tier_source_ref = EXCLUDED.tier_source_ref,
    pricing_method = EXCLUDED.pricing_method, pricing_source_ref = EXCLUDED.pricing_source_ref, pricing_source_ref_type = EXCLUDED.pricing_source_ref_type,
    package_base_price = EXCLUDED.package_base_price, overflow_photos = EXCLUDED.overflow_photos,
    overflow_charge = EXCLUDED.overflow_charge, discount_applied_pct = EXCLUDED.discount_applied_pct, quoted_price = EXCLUDED.quoted_price,
    address_hidden = EXCLUDED.address_hidden, data_gap_flag = EXCLUDED.data_gap_flag, photos_capped_at_34 = EXCLUDED.photos_capped_at_34,
    photo_count_at_quote = EXCLUDED.photo_count_at_quote, has_floorplan_at_quote = EXCLUDED.has_floorplan_at_quote,
    has_video_at_quote = EXCLUDED.has_video_at_quote, price_text_at_quote = EXCLUDED.price_text_at_quote,
    quote_status = EXCLUDED.quote_status, computed_at = EXCLUDED.computed_at,
    engine_version = EXCLUDED.engine_version, raw_cascade_log = EXCLUDED.raw_cascade_log,
    quoted_via = EXCLUDED.quoted_via;
  RETURN (SELECT to_jsonb(pmo) FROM pulse_listing_missed_opportunity pmo WHERE pmo.listing_id = p_listing_id);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: realign existing inconsistent rows to the spec invariant.
-- Per the smoke ticket's literal WHERE clause, all rows where
-- (classified_package_name='UNCLASSIFIABLE' AND quoted_via='crude_v1') are
-- promoted to (vision_v2_unclassifiable + data_gap_flag=TRUE +
-- engine_version='v3.2.1-vision'). This affects ~2,959 rows across
-- mixed engine versions (49 v3.2.0-vision + 2,910 from v1.x/v3.0/v3.1
-- legacy that inherited the 'crude_v1' DEFAULT when mig 405 added the
-- column). All future runs will write the corrected shape directly.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.pulse_listing_missed_opportunity
   SET quoted_via     = 'vision_v2_unclassifiable',
       data_gap_flag  = TRUE,
       engine_version = 'v3.2.1-vision'
 WHERE classified_package_name = 'UNCLASSIFIABLE'
   AND quoted_via = 'crude_v1';

-- ─────────────────────────────────────────────────────────────────────────────
-- Self-test (run via execute_sql in BEGIN; ... ROLLBACK; — Supabase MCP
-- apply_migration rejects nested transactions, so this block is documented
-- here for traceability and is run manually post-apply).
--
-- Verifies:
--   (a) V1 fallback with V1=UNCLASSIFIABLE → quoted_via='vision_v2_unclassifiable',
--       data_gap_flag=TRUE, classified_package_name='UNCLASSIFIABLE'
--   (b) V1 fallback with V1=Silver Package → quoted_via='crude_v1',
--       classified_package_name='Silver Package' (regression guard:
--       happy-path V1 fallback still tagged crude_v1)
-- ─────────────────────────────────────────────────────────────────────────────

/*  Run via execute_sql (NOT inside apply_migration):

BEGIN;

DO $w15b6_followup_assertions$
DECLARE
  v_listing_id_a uuid := gen_random_uuid();
  v_listing_id_b uuid := gen_random_uuid();
  v_quoted_via text;
  v_package_name text;
  v_data_gap boolean;
BEGIN
  -- (a) V1=UNCLASSIFIABLE (no media, no extract)
  INSERT INTO pulse_listings (
    id, source_listing_id, source_url, listing_type, status,
    address, suburb, postcode, latitude, longitude,
    detail_enriched_at, last_synced_at,
    media_items, images, video_url, has_video, floorplan_urls,
    asking_price, price_text, first_seen_at
  ) VALUES (
    v_listing_id_a, 'w15b6_fix_a_' || v_listing_id_a::text,
    'https://example.test/' || v_listing_id_a::text,
    'for_sale', 'active',
    '1 Test St', 'Testsuburb', '2000', NULL, NULL,
    now(), now(),
    '[]'::jsonb, '[]'::jsonb, NULL, false, ARRAY[]::text[],
    750000, '$750,000', now()
  );

  PERFORM pulse_compute_listing_quote(v_listing_id_a);
  SELECT quoted_via, classified_package_name, data_gap_flag
    INTO v_quoted_via, v_package_name, v_data_gap
    FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id_a;

  IF v_quoted_via IS DISTINCT FROM 'vision_v2_unclassifiable' THEN
    RAISE EXCEPTION 'W15b.6 fix ASSERT (a) FAILED: expected quoted_via=vision_v2_unclassifiable, got %', v_quoted_via;
  END IF;
  IF v_data_gap IS NOT TRUE THEN
    RAISE EXCEPTION 'W15b.6 fix ASSERT (a) FAILED: expected data_gap_flag=TRUE, got %', v_data_gap;
  END IF;
  IF v_package_name IS DISTINCT FROM 'UNCLASSIFIABLE' THEN
    RAISE EXCEPTION 'W15b.6 fix ASSERT (a) FAILED: expected package_name=UNCLASSIFIABLE, got %', v_package_name;
  END IF;

  -- (b) V1=Silver (1 photo + floorplan, no extract → V1 path picks Silver)
  INSERT INTO pulse_listings (
    id, source_listing_id, source_url, listing_type, status,
    address, suburb, postcode, latitude, longitude,
    detail_enriched_at, last_synced_at,
    media_items, images, video_url, has_video, floorplan_urls,
    asking_price, price_text, first_seen_at
  ) VALUES (
    v_listing_id_b, 'w15b6_fix_b_' || v_listing_id_b::text,
    'https://example.test/' || v_listing_id_b::text,
    'for_sale', 'active',
    '2 Test St', 'Testsuburb', '2000', NULL, NULL,
    now(), now(),
    jsonb_build_array(jsonb_build_object('url','https://x/1.jpg','kind','photo')),
    jsonb_build_array('https://x/1.jpg'),
    NULL, false, ARRAY['https://x/fp.jpg'],
    750000, '$750,000', now()
  );

  PERFORM pulse_compute_listing_quote(v_listing_id_b);
  SELECT quoted_via, classified_package_name, data_gap_flag
    INTO v_quoted_via, v_package_name, v_data_gap
    FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id_b;

  IF v_quoted_via IS DISTINCT FROM 'crude_v1' THEN
    RAISE EXCEPTION 'W15b.6 fix ASSERT (b) FAILED: expected quoted_via=crude_v1 for V1 happy-path Silver, got % (pkg=%)', v_quoted_via, v_package_name;
  END IF;
  IF v_package_name = 'UNCLASSIFIABLE' THEN
    RAISE EXCEPTION 'W15b.6 fix ASSERT (b) FAILED: V1 happy-path should not produce UNCLASSIFIABLE';
  END IF;

  RAISE NOTICE 'W15b.6 follow-up — both assertions passed';
END
$w15b6_followup_assertions$;

ROLLBACK;

*/

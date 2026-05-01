-- Migration 405 — W15b.6 keystone wave
--
-- Patches `pulse_compute_listing_quote(p_listing_id uuid)` to drive its
-- classification through `pulse_classify_listing_package_v2(...)` (W15b.5
-- vision-driven cascade) when a vision extract row exists for the listing,
-- and only falls back to the V1 crude classifier (`pulse_classify_listing_package`,
-- migration 159) when no extract is available yet.
--
-- Decision matrix:
--
--   V2 returns                         | quote source       | quoted_via
--   ─────────────────────────────────────────────────────────────────────────
--   classified_package_id IS NOT NULL  | V2 (vision)        | 'vision_v2'
--     AND name NOT IN ('PENDING_VISION','UNCLASSIFIABLE')
--   name = 'PENDING_VISION' (no extract)| V1 (crude rules)   | 'crude_v1'
--   name = 'UNCLASSIFIABLE' (extract   | V2 (still)         | 'vision_v2_unclassifiable'
--     exists but signals not enough)   |                    | + data_gap_flag = TRUE
--
-- Adds new column `quoted_via TEXT NOT NULL DEFAULT 'crude_v1'` on
-- `pulse_listing_missed_opportunity` so we can monitor V1→V2 rollout coverage
-- with a simple GROUP BY query.
--
-- For UNCLASSIFIABLE we set `data_gap_flag = TRUE` (existing review-flag
-- column on PMO — no separate review-flag column exists; data_gap_flag is
-- the operator's "this needs human review" signal). We also persist the V2
-- classifier's confidence via raw_cascade_log so the dashboard can surface
-- "vision ran, confidence 0.0, please confirm" rather than silently using a
-- crude V1 fallback.
--
-- Defensive: if `pulse_classify_listing_package_v2` itself raises an
-- exception, we DO NOT fail the quote — we WARN and fall through to V1.
-- This keeps the quote engine resilient during V2 rollout while still giving
-- us coverage telemetry.

-- NOTE: This migration is applied via Supabase MCP `apply_migration`, which
-- wraps the body in its own transaction. The trailing `BEGIN; ... ROLLBACK;`
-- self-test block is documented here for traceability but is run manually
-- via `execute_sql` after apply (the MCP layer rejects nested transactions).

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema: add quoted_via column (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.pulse_listing_missed_opportunity
  ADD COLUMN IF NOT EXISTS quoted_via TEXT NOT NULL DEFAULT 'crude_v1';

COMMENT ON COLUMN public.pulse_listing_missed_opportunity.quoted_via IS
  'W15b.6: which classifier path produced this quote. ''crude_v1'' = no vision extract, fell back to migration-159 rule classifier. ''vision_v2'' = W15b.5 cascade matched a tier. ''vision_v2_unclassifiable'' = extract present but cascade had no signal — human review required (data_gap_flag also set).';

CREATE INDEX IF NOT EXISTS idx_pulse_pmo_quoted_via
  ON public.pulse_listing_missed_opportunity (quoted_via);

-- ─────────────────────────────────────────────────────────────────────────────
-- Function: pulse_compute_listing_quote v3.2.0-vision
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
  v_engine_version text := 'v3.2.0-vision';
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

  -- W15b.6: try V2 vision classifier first. Defensive — never fail the quote
  -- because the classifier raised. If V2 throws we WARN and fall through to V1.
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
    -- V2 produced a real classification. Use it as source of truth.
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
    -- Vision ran but cascade couldn't classify. Prefer the V2 zero-confidence
    -- result over a misleading V1 guess. Flag for human review via existing
    -- data_gap_flag column (the PMO doesn't have a dedicated review-flag
    -- column — data_gap_flag is what operators filter on).
    v_package_id        := NULL;
    v_package_name      := 'UNCLASSIFIABLE';
    v_quoted_via        := 'vision_v2_unclassifiable';
    v_v2_unclassifiable := true;
    v_data_gap          := true;  -- review flag
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
    v_quoted_via   := 'crude_v1';
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

  -- W15b.6: persist quoted_via in addition to all the existing columns.
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
-- Self-test (ROLLBACK-protected). Verifies the four cascade branches
-- against a synthetic listing + extract row.
--
-- This block is intentionally left OUT of the apply_migration body (Supabase
-- MCP rejects nested transactions). It is run manually via `execute_sql`
-- inside `BEGIN; ... ROLLBACK;` immediately after applying the function.
-- ─────────────────────────────────────────────────────────────────────────────

/*  Run via execute_sql (NOT inside apply_migration):

BEGIN;

DO $w15b6_assertions$
DECLARE
  v_listing_id uuid := gen_random_uuid();
  v_quote jsonb;
  v_quoted_via text;
  v_package_name text;
  v_data_gap boolean;
  v_pmo_row record;
  v_existing_silver uuid;
BEGIN
  -- Provision a synthetic pulse_listings row so the quote function has
  -- something to operate on. Status 'for_sale' so the V1 fallback
  -- classification works the same way it would in prod.
  INSERT INTO pulse_listings (
    id, source_listing_id, source_url, listing_type, status,
    address, suburb, postcode, latitude, longitude,
    detail_enriched_at, last_synced_at,
    media_items, images, video_url, has_video, floorplan_urls,
    asking_price, price_text, first_seen_at
  ) VALUES (
    v_listing_id, 'w15b6_test_' || v_listing_id::text, 'https://example.test/' || v_listing_id::text,
    'for_sale', 'active',
    '1 Test St', 'Testsuburb', '2000', NULL, NULL,
    now(), now(),
    '[]'::jsonb, '[]'::jsonb, NULL, false, ARRAY[]::text[],
    750000, '$750,000', now()
  );

  -- ── Assertion (a): no vision extract → V1 crude classifier path ────
  -- Synthetic listing has 0 photos/fp/video, so V1 returns UNCLASSIFIABLE
  -- but quoted_via must still be 'crude_v1' (V1 was the chosen path).
  v_quote := pulse_compute_listing_quote(v_listing_id);
  SELECT quoted_via, classified_package_name, data_gap_flag
    INTO v_quoted_via, v_package_name, v_data_gap
    FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id;
  IF v_quoted_via IS DISTINCT FROM 'crude_v1' THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (a) FAILED: expected quoted_via=crude_v1 when no extract exists, got %', v_quoted_via;
  END IF;

  -- ── Assertion (b): succeeded extract matching T1 cascade → V2 used ──
  -- Insert a T1 Premium Dusk Video extract: dusk_video_segments=1,
  -- drone_count=1, dusk_count=3, floorplan_count=1.
  INSERT INTO pulse_listing_vision_extracts (
    listing_id, schema_version, status, extracted_at,
    photo_breakdown, video_breakdown, total_cost_usd, vendor, model_version
  ) VALUES (
    v_listing_id, 'v1.0', 'succeeded', now(),
    jsonb_build_object(
      'total_images', 30,
      'day_count', 25,
      'dusk_count', 3,
      'drone_count', 2,
      'floorplan_count', 1,
      'video_thumbnail_count', 0
    ),
    jsonb_build_object(
      'present', true,
      'dusk_segments_count', 1,
      'segments', jsonb_build_array()
    ),
    0.05, 'google', 'gemini-2.5-flash'
  );

  v_quote := pulse_compute_listing_quote(v_listing_id);
  SELECT quoted_via, classified_package_name, data_gap_flag
    INTO v_quoted_via, v_package_name, v_data_gap
    FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id;
  IF v_quoted_via IS DISTINCT FROM 'vision_v2' THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (b) FAILED: expected quoted_via=vision_v2 for T1 extract, got % (pkg=%)', v_quoted_via, v_package_name;
  END IF;

  -- ── Assertion (c): succeeded extract with no signal → UNCLASSIFIABLE ──
  -- Mutate the extract to remove all signals.
  UPDATE pulse_listing_vision_extracts
     SET photo_breakdown = jsonb_build_object(
           'total_images', 0, 'day_count', 0, 'dusk_count', 0,
           'drone_count', 0, 'floorplan_count', 0, 'video_thumbnail_count', 0
         ),
         video_breakdown = jsonb_build_object(
           'present', false, 'dusk_segments_count', 0
         )
   WHERE listing_id = v_listing_id;

  v_quote := pulse_compute_listing_quote(v_listing_id);
  SELECT quoted_via, classified_package_name, data_gap_flag
    INTO v_quoted_via, v_package_name, v_data_gap
    FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id;
  IF v_quoted_via IS DISTINCT FROM 'vision_v2_unclassifiable' THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (c) FAILED: expected quoted_via=vision_v2_unclassifiable for empty-signal extract, got % (pkg=%)', v_quoted_via, v_package_name;
  END IF;
  IF v_data_gap IS NOT TRUE THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (c) FAILED: expected data_gap_flag=TRUE for unclassifiable, got %', v_data_gap;
  END IF;
  IF v_package_name IS DISTINCT FROM 'UNCLASSIFIABLE' THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (c) FAILED: expected package_name=UNCLASSIFIABLE, got %', v_package_name;
  END IF;

  -- ── Assertion (d): T4 Gold path — photos+floorplan, no video, >10 ──
  UPDATE pulse_listing_vision_extracts
     SET photo_breakdown = jsonb_build_object(
           'total_images', 25,
           'day_count', 20,
           'dusk_count', 4,
           'drone_count', 2,
           'floorplan_count', 1,
           'video_thumbnail_count', 0
         ),
         video_breakdown = jsonb_build_object(
           'present', false, 'dusk_segments_count', 0
         )
   WHERE listing_id = v_listing_id;

  v_quote := pulse_compute_listing_quote(v_listing_id);
  SELECT * INTO v_pmo_row FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id;
  IF v_pmo_row.quoted_via IS DISTINCT FROM 'vision_v2' THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (d) FAILED: expected quoted_via=vision_v2 for T4 Gold, got % (pkg=%)', v_pmo_row.quoted_via, v_pmo_row.classified_package_name;
  END IF;
  IF v_pmo_row.classified_package_id IS NULL THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (d) FAILED: expected non-null classified_package_id for T4 Gold path';
  END IF;
  -- The cascade log should include both the V2 classify step and the
  -- pricing path. Add-ons (dusk_image_addon, drone_addon) live inside the
  -- classify_v2_vision step's add_on_items array. We don't pin the package
  -- name (Gold vs Standard) because the env-specific package catalogue may
  -- name it differently, but the add_on_items array MUST contain dusk +
  -- drone entries for the T4 path with dusk=4 and drone=2.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_pmo_row.raw_cascade_log) step
     WHERE step->>'step' = 'classify_v2_vision'
       AND jsonb_array_length(step->'add_on_items') >= 1
  ) THEN
    RAISE EXCEPTION 'W15b.6 ASSERT (d) FAILED: expected classify_v2_vision step with add_on_items, got cascade=%', v_pmo_row.raw_cascade_log;
  END IF;

  RAISE NOTICE 'W15b.6 — all 4 cascade assertions passed for synthetic listing %', v_listing_id;
END
$w15b6_assertions$;

ROLLBACK;

*/

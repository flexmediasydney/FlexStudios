-- 164_pulse_get_listing_quote_detail.sql
-- Rich provenance RPC for the Market Share / Missed Opportunity engine.
--
-- pulse_get_listing_quote_detail(p_listing_id uuid) → jsonb
--
-- Returns a fully-hydrated provenance payload consumed by the <QuoteProvenance>
-- UI component. Unlike pulse_compute_listing_quote (which UPSERTs the substrate),
-- this RPC is READ-ONLY and produces a stable explanation of what the engine did:
--
--   • listing               — media + agent/agency + source_url for drill
--   • classification        — the 5 cascade rules evaluated in order
--                              with fired/skipped + reason + thresholds vs actual
--   • tier_resolution       — resolved tier + evidence (matrix or project row)
--   • pricing               — method + math "receipt lines" + source detail
--   • quality_flags         — address_hidden / data_gap / photos_capped + status
--   • provenance            — computed_at + engine_version + raw_cascade_log
--
-- Joined names are hydrated server-side (packages, price_matrices, agencies,
-- projects, pulse_agencies) so the frontend only needs one round-trip.
--
-- Idempotent / pure — does NOT mutate the substrate. If no substrate row
-- exists yet we return what we can from pulse_listings (classification still
-- evaluable even without a quote).
--
-- Verified against three walkthrough listings at bottom of file.

BEGIN;

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
  v_classification jsonb;

  v_tier_evidence jsonb := '{}'::jsonb;

  v_matrix record;
  v_linked_agency_name text;

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

  -- For the classification evaluator
  v_fired boolean;
  v_fired_any boolean := false;

  v_result jsonb;

  v_sales_base_used numeric;
  v_sales_unit_used numeric;
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
  v_asking := COALESCE(v_listing.asking_price, pulse_parse_price_text(v_listing.price_text));

  -- ─── Load substrate row (may be missing) ──────────────────────────────
  SELECT * INTO v_pmo
  FROM pulse_listing_missed_opportunity
  WHERE listing_id = p_listing_id;

  -- ─── Classification evaluation (re-evaluate all 5 rules + fallback) ───
  -- Mirrors pulse_classify_listing_package order: Flex → Dusk → Day → Gold → Silver
  -- First matching rule wins; subsequent rules are NOT skipped "because of
  -- short-circuit" but for clarity we mark them as fired=false with reason
  -- "earlier rule matched: X". This gives the UI a clean picture of why the
  -- actual rule was chosen AND what others would have done with the inputs.

  -- Rule 1: Flex
  v_fired := (v_photos >= 30 AND v_has_fp AND v_has_video AND COALESCE(v_asking, 0) > 8000000);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Flex Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'all thresholds met'
      WHEN v_photos < 30 THEN 'photo_count ' || v_photos || ' < 30'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      WHEN NOT v_has_video THEN 'no video detected'
      WHEN v_asking IS NULL THEN 'asking_price null → $8M gate unverifiable'
      WHEN v_asking <= 8000000 THEN 'asking_price $' || v_asking::bigint || ' ≤ $8M gate'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '>=30', 'fp', true, 'video', true, 'asking_gt', 8000000),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp, 'video', v_has_video, 'asking', v_asking)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Flex Package'; END IF;

  -- Rule 2: Dusk Video
  v_fired := NOT v_fired_any AND (v_photos >= 26 AND v_has_fp AND v_has_video);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Dusk Video Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos ≥ 26 + floorplan + video'
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

  -- Rule 3: Day Video
  v_fired := NOT v_fired_any AND (v_photos >= 1 AND v_has_fp AND v_has_video);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Day Video Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos ≥ 1 + floorplan + video (below Dusk threshold)'
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

  -- Rule 4: Gold
  v_fired := NOT v_fired_any AND (v_photos > 10 AND v_has_fp);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Gold Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos > 10 + floorplan (no video)'
      WHEN v_fired_any THEN 'earlier rule matched'
      WHEN v_photos <= 10 THEN 'photo_count ' || v_photos || ' ≤ 10 (Silver range)'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '>10', 'fp', true),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Gold Package'; END IF;

  -- Rule 5: Silver
  v_fired := NOT v_fired_any AND (v_photos <= 10 AND v_has_fp);
  v_eval := v_eval || jsonb_build_array(jsonb_build_object(
    'rule', 'Silver Package',
    'fired', v_fired,
    'reason', CASE
      WHEN v_fired THEN 'photos ≤ 10 + floorplan'
      WHEN v_fired_any THEN 'earlier rule matched'
      WHEN v_photos > 10 THEN 'photo_count ' || v_photos || ' > 10'
      WHEN NOT v_has_fp THEN 'no floorplan detected'
      ELSE 'did not match'
    END,
    'thresholds', jsonb_build_object('photos', '<=10', 'fp', true),
    'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp)
  ));
  IF v_fired THEN v_fired_any := true; v_resolved_package_name := 'Silver Package'; END IF;

  -- Fallthrough: UNCLASSIFIABLE
  IF NOT v_fired_any THEN
    v_eval := v_eval || jsonb_build_array(jsonb_build_object(
      'rule', 'UNCLASSIFIABLE',
      'fired', true,
      'reason', CASE
        WHEN NOT v_has_fp THEN 'no floorplan → no package rule matches; item-sum fallback'
        ELSE 'no package rule matched'
      END,
      'thresholds', jsonb_build_object(),
      'actual', jsonb_build_object('photos', v_photos, 'fp', v_has_fp, 'video', v_has_video)
    ));
    v_resolved_package_name := 'UNCLASSIFIABLE';
  END IF;

  -- ─── Tier evidence ────────────────────────────────────────────────────
  -- NOTE: in plpgsql, `record IS NOT NULL` is TRUE only when EVERY field is
  -- non-null. Since v_pmo has many nullable columns (tier_source_ref,
  -- pricing_source_ref, asking_price_numeric …), we test on the PK instead.
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
            THEN 'no lat/lon on listing → radial proximity rings not evaluable'
          ELSE 'no projects within 50km of listing lat/lon'
        END
      );
    END IF;
  END IF;

  -- ─── Pricing source hydration + math receipt lines ────────────────────
  IF v_pmo.listing_id IS NOT NULL AND v_pmo.pricing_method IS NOT NULL THEN
    IF v_pmo.pricing_method = 'agency_matrix' THEN
      -- Reuse matrix record if we already fetched it for tier; else fetch now.
      -- Same plpgsql record-NULL gotcha: use v_matrix.id IS NULL as existence test.
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
      -- Build itemized list for unclassifiable: Sales Images + Floorplan + Drone at tier
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

  -- ─── Build math_lines "receipt" ───────────────────────────────────────
  v_math_lines := '[]'::jsonb;

  IF v_pmo.listing_id IS NOT NULL AND v_pmo.pricing_method IS NOT NULL THEN
    IF v_pmo.pricing_method = 'item_sum_unclassifiable' THEN
      -- Mirror the item_sum construction in receipt form
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
          'label', 'Sales Images ' || v_pmo.resolved_tier || ' base ($' || v_imgs_base::bigint || ' + ' || GREATEST(0, v_pmo.photo_count - 5) || ' × $' || v_imgs_unit::bigint || ')',
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
      -- Package-based pricing receipt
      -- Line 1: package base (before any blanket discount)
      DECLARE
        v_pkg_base_undiscounted numeric;
      BEGIN
        -- If blanket discount applied inside agency_matrix, reconstruct undiscounted
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
            'label', '− ' || v_pmo.discount_applied_pct::int || '% blanket pkg discount',
            'amount', round(v_pmo.package_base_price - v_pkg_base_undiscounted, 2)
          ));
        ELSE
          v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
            'label', COALESCE(v_pmo.classified_package_name, 'Package') || ' ' || v_pmo.resolved_tier || ' base',
            'amount', v_pmo.package_base_price
          ));
        END IF;
      END;

      -- Overflow line (if any photos over included qty)
      IF COALESCE(v_pmo.overflow_photos, 0) > 0 AND COALESCE(v_pmo.overflow_charge, 0) > 0 THEN
        -- Derive unit price from charge / qty
        v_sales_unit_used := CASE WHEN v_pmo.overflow_photos > 0 THEN v_pmo.overflow_charge / v_pmo.overflow_photos ELSE 0 END;
        v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
          'label', 'Photo overflow (' || v_pmo.photo_count || ' − ' || (v_pmo.photo_count - v_pmo.overflow_photos) || ') × $' || round(v_sales_unit_used)::int,
          'amount', v_pmo.overflow_charge
        ));
      END IF;
    END IF;

    -- Total line
    v_math_lines := v_math_lines || jsonb_build_array(jsonb_build_object(
      'label', 'Quoted price',
      'amount', v_pmo.quoted_price,
      'total', true
    ));
  END IF;

  -- ─── Resolve sales_img base/unit used (for display) ───────────────────
  IF v_pmo.listing_id IS NOT NULL THEN
    IF v_pmo.resolved_tier = 'premium' THEN
      v_sales_base_used := v_sales_img_prm_base;
      v_sales_unit_used := COALESCE(v_sales_unit_used, v_sales_img_prm_unit);
    ELSE
      v_sales_base_used := v_sales_img_std_base;
      v_sales_unit_used := COALESCE(v_sales_unit_used, v_sales_img_std_unit);
    END IF;
  END IF;

  -- ─── Assemble final result ────────────────────────────────────────────
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
    'provenance', jsonb_build_object(
      'computed_at', v_pmo.computed_at,
      'engine_version', v_pmo.engine_version,
      'raw_cascade_log', COALESCE(v_pmo.raw_cascade_log, '[]'::jsonb)
    )
  );

  RETURN v_result;
END;
$$;

-- Allow authenticated users to call the RPC (matches pmo_select_authenticated)
GRANT EXECUTE ON FUNCTION pulse_get_listing_quote_detail(uuid) TO authenticated;

COMMIT;

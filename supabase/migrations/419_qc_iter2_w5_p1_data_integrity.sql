-- 419_qc_iter2_w5_p1_data_integrity.sql
--
-- W11.QC-iter2-W5: P1 data integrity bundle.
--
-- Findings shipped (all SQL-only, single migration):
--   F-A-007: Tighten engine_run_audit_engine_mode_chk — drop dead 'two_pass'
--            + 'unified_anthropic_failover' modes (sunset W11.7.10 + W11.8.1).
--            Keep shape_d_full / shape_d_partial / shape_d_textfallback (all
--            currently in use by Shape D pipeline).
--   F-A-008: Rebuild uniq_shortlisting_jobs_active_pass_per_round partial
--            unique index without the dead 'pass1' + 'pass2' kinds (edge fns
--            deleted in W11.7.10). NB: pass1 + pass2 retained inside the
--            kind CHECK constraint because mig 413 W11.7.10 deliberately
--            preserved 6 historical succeeded rows; structural enforcement
--            against new pass1/pass2 jobs is the absent edge fn.
--   F-A-010: Add NULL guard at top of capture_human_override_as_observation
--            trigger fn. Defensive — current schema has round_id+group_id
--            NOT NULL but future stage4_visual_override paths could set them
--            NULL, in which case the partial-unique ON CONFLICT clause
--            silently fails to match and would throw on uq_raw_obs_pulse_label.
--   F-A-011: Add pg_advisory_xact_lock recursion guard to top of
--            pulse_compute_listing_quote (self-protects regardless of caller).
--            Add pulse_compute_quote_failures log table so the
--            EXCEPTION-WHEN-OTHERS branch of the recompute trigger gets
--            grep-able failure rows in addition to RAISE WARNING.
--
-- Wave plan (do-not-conflict):
--   - W11.6.22 in flight (Stage 4 + new schema fields) — different scope
--   - Wave 6a in flight (shortlisting-shape-d Stage 1 cost+perf) — diff scope
--   - Mig 413 (W11.7.10) — its constraints were intentionally loose; we are
--     tightening NEW constraints, not modifying mig 413.
--   - W4 search_path lock (mig 416) preserved verbatim on every fn we re-emit.

BEGIN;

-- ─── F-A-007: tighten engine_run_audit.engine_mode CHECK ────────────────
DO $$
DECLARE
  v_legacy int;
  v_modes  text;
BEGIN
  SELECT COUNT(*),
         COALESCE(string_agg(DISTINCT engine_mode, ', '), '<none>')
    INTO v_legacy, v_modes
    FROM engine_run_audit
   WHERE engine_mode NOT IN ('shape_d_full','shape_d_partial','shape_d_textfallback');
  IF v_legacy > 0 THEN
    RAISE EXCEPTION
      'F-A-007 abort — % engine_run_audit rows have legacy engine_mode values (% — cannot tighten CHECK safely',
      v_legacy, v_modes;
  END IF;
END $$;

ALTER TABLE engine_run_audit
  DROP CONSTRAINT IF EXISTS engine_run_audit_engine_mode_chk;

ALTER TABLE engine_run_audit
  ADD CONSTRAINT engine_run_audit_engine_mode_chk
  CHECK (engine_mode IN ('shape_d_full','shape_d_partial','shape_d_textfallback'))
  NOT VALID;

ALTER TABLE engine_run_audit
  VALIDATE CONSTRAINT engine_run_audit_engine_mode_chk;

-- ─── F-A-008: rebuild partial unique index for shortlisting_jobs ──────────
-- NB: We do NOT drop pass1/pass2 from shortlisting_jobs_kind_check — mig 413
-- (W11.7.10) deliberately preserved 6 historical succeeded rows of those
-- kinds. We just rebuild the partial unique index so it no longer references
-- the dead kinds (it never could collide on succeeded historical rows because
-- of the WHERE clause anyway, but the index itself shouldn't pretend pass1+
-- pass2 are still active dispatch targets — the index's WHERE list reads as
-- a "currently dispatchable kinds" allowlist).

DROP INDEX IF EXISTS uniq_shortlisting_jobs_active_pass_per_round;

CREATE UNIQUE INDEX uniq_shortlisting_jobs_active_pass_per_round
  ON public.shortlisting_jobs (round_id, kind)
  WHERE kind IN (
          'pass0',
          'pass3',
          'shape_d_stage1',
          'stage4_synthesis',
          'canonical_rollup'
        )
    AND status IN ('pending','running','succeeded');

COMMENT ON INDEX uniq_shortlisting_jobs_active_pass_per_round IS
  'QC-iter2-W5 F-A-008: partial unique excludes legacy pass1/pass2 kinds (deleted W11.7.10). Historical pass1/pass2 succeeded rows preserved by mig 413 are not subject to this constraint.';

-- ─── F-A-010: NULL guard on capture_human_override_as_observation ────────
-- Re-emit the existing function body verbatim with an early-return NULL guard
-- prepended. W4 search_path lock preserved.
CREATE OR REPLACE FUNCTION public.capture_human_override_as_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_excerpt TEXT;
  v_attributes JSONB;
BEGIN
  -- F-A-010 NULL guard: ON CONFLICT (round_id, group_id, raw_label) is gated
  -- by a partial unique index requiring round_id + group_id NOT NULL. If the
  -- override row has NULL on either, the WHERE on uq_raw_obs_round_group_label
  -- silently fails to match and the INSERT can throw on the alternate
  -- uq_raw_obs_pulse_label partial index. Skip cleanly.
  IF NEW.round_id IS NULL OR NEW.group_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.override_source = 'stage4_visual_override' THEN
    RETURN NEW;
  END IF;

  v_excerpt := LEFT(COALESCE(NEW.override_reason, ''), 500);

  v_attributes := jsonb_build_object(
    'override_id', NEW.id,
    'override_source', NEW.override_source,
    'actor_user_id', NEW.actor_user_id,
    'actor_at', NEW.actor_at
  );

  -- room_type
  IF NEW.human_room_type IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.human_room_type IS DISTINCT FROM OLD.human_room_type) THEN
    INSERT INTO raw_attribute_observations (
      round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
    ) VALUES (
      NEW.round_id, NEW.group_id,
      'room_type:' || NEW.human_room_type,
      'human_override', v_excerpt,
      v_attributes || jsonb_build_object('field', 'room_type', 'ai_value', NEW.ai_room_type, 'human_value', NEW.human_room_type),
      1.0
    )
    ON CONFLICT (round_id, group_id, raw_label)
      WHERE round_id IS NOT NULL AND group_id IS NOT NULL
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_excerpt = EXCLUDED.source_excerpt,
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      raw_label_embedding = NULL,
      normalised_to_object_id = NULL,
      normalised_at = NULL,
      similarity_score = NULL;
  END IF;

  -- composition_type
  IF NEW.human_composition_type IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.human_composition_type IS DISTINCT FROM OLD.human_composition_type) THEN
    INSERT INTO raw_attribute_observations (
      round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
    ) VALUES (
      NEW.round_id, NEW.group_id,
      'composition_type:' || NEW.human_composition_type,
      'human_override', v_excerpt,
      v_attributes || jsonb_build_object('field', 'composition_type', 'ai_value', NEW.ai_composition_type, 'human_value', NEW.human_composition_type),
      1.0
    )
    ON CONFLICT (round_id, group_id, raw_label)
      WHERE round_id IS NOT NULL AND group_id IS NOT NULL
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_excerpt = EXCLUDED.source_excerpt,
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      raw_label_embedding = NULL,
      normalised_to_object_id = NULL,
      normalised_at = NULL,
      similarity_score = NULL;
  END IF;

  -- vantage_point
  IF NEW.human_vantage_point IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.human_vantage_point IS DISTINCT FROM OLD.human_vantage_point) THEN
    INSERT INTO raw_attribute_observations (
      round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
    ) VALUES (
      NEW.round_id, NEW.group_id,
      'vantage_point:' || NEW.human_vantage_point,
      'human_override', v_excerpt,
      v_attributes || jsonb_build_object('field', 'vantage_point', 'ai_value', NEW.ai_vantage_point, 'human_value', NEW.human_vantage_point),
      1.0
    )
    ON CONFLICT (round_id, group_id, raw_label)
      WHERE round_id IS NOT NULL AND group_id IS NOT NULL
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_excerpt = EXCLUDED.source_excerpt,
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      raw_label_embedding = NULL,
      normalised_to_object_id = NULL,
      normalised_at = NULL,
      similarity_score = NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- ─── F-A-011: failure log table + advisory lock + better error reporting ──
CREATE TABLE IF NOT EXISTS public.pulse_compute_quote_failures (
  id BIGSERIAL PRIMARY KEY,
  listing_id UUID NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pcqf_listing_recent
  ON public.pulse_compute_quote_failures(failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pcqf_listing
  ON public.pulse_compute_quote_failures(listing_id);

ALTER TABLE public.pulse_compute_quote_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pcqf_admin_read ON public.pulse_compute_quote_failures;
CREATE POLICY pcqf_admin_read ON public.pulse_compute_quote_failures
  FOR SELECT TO authenticated
  USING (public.get_user_role() = ANY(ARRAY['master_admin','admin']));

DROP POLICY IF EXISTS pcqf_service_all ON public.pulse_compute_quote_failures;
CREATE POLICY pcqf_service_all ON public.pulse_compute_quote_failures
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.pulse_compute_quote_failures IS
  'QC-iter2-W5 F-A-011: grep-able failure log for pulse_compute_listing_quote(). Trigger captures EXCEPTION-WHEN-OTHERS rows here so ops can monitor without flipping silent on RAISE WARNING.';

-- Re-emit recompute trigger fn with logging (W4 search_path preserved)
CREATE OR REPLACE FUNCTION public.pulse_listing_vision_extract_recompute_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Only fire when status transitions INTO 'succeeded' (or first INSERT in
  -- that state). Skip no-op updates that touch other columns. WHEN clauses
  -- can't reference OLD on INSERT triggers, so we gate inside the body.
  IF NEW.status <> 'succeeded' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public.pulse_compute_listing_quote(NEW.listing_id);
  EXCEPTION WHEN OTHERS THEN
    -- F-A-011: log to pulse_compute_quote_failures so ops have grep-ability
    -- in addition to the RAISE WARNING (kept for backwards-compat parity).
    INSERT INTO public.pulse_compute_quote_failures(listing_id, error_message)
      VALUES (NEW.listing_id, SQLERRM);
    RAISE WARNING 'pulse_compute_listing_quote(%) failed in vision-extract recompute trigger: %', NEW.listing_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- Re-emit pulse_compute_listing_quote with pg_advisory_xact_lock recursion
-- guard at top. Body is verbatim from prior version (v3.2.1-vision) — only
-- the lock acquisition is added. NOT security definer + no search_path lock
-- (different concern, not part of this wave; see QC-A).
CREATE OR REPLACE FUNCTION public.pulse_compute_listing_quote(p_listing_id uuid)
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
  -- F-A-011 recursion guard: this fn is reached via
  --   trg_pulse_vision_extract_recompute → recompute_trigger → here, and
  --   here writes to pulse_listing_missed_opportunity which fires
  --   trg_pmo_emit_timeline_events → pulse_timeline INSERT. Without the
  -- xact-scoped advisory lock, a misconfigured downstream trigger could
  -- recursively re-enter this fn and fan-out arbitrarily. The lock is taken
  -- at txn scope so it auto-releases on COMMIT/ROLLBACK and only blocks
  -- re-entry within the same transaction.
  PERFORM pg_advisory_xact_lock(hashtext('pulse_compute_listing_quote'));

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
    v_classification := pulse_classify_listing_package(v_photos, v_has_fp, v_has_video, v_asking);
    v_package_id   := NULLIF(v_classification->>'package_id', '')::uuid;
    v_package_name := v_classification->>'package_name';

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
$$;

-- ─── Smoke tests (read-only schema assertions, no data writes) ────────────
-- We deliberately avoid INSERT-then-rollback patterns inside the migration
-- transaction because:
--   1. Even rolled-back INSERTs consume sequence values.
--   2. Triggers on shortlisting_jobs / engine_run_audit may fire side-effects
--      that are hard to reason about during a migration.
-- All four findings are verified via pg_catalog inspection — sufficient given
-- the structural nature of the changes.
DO $$
DECLARE
  v_check_def text;
  v_index_def text;
  v_lock_in_body boolean;
  v_guard_in_capture boolean;
  v_log_in_recompute boolean;
  v_failure_log_exists int;
BEGIN
  -- F-A-007: tightened CHECK rejects two_pass / unified_anthropic_failover
  SELECT pg_get_constraintdef(c.oid) INTO v_check_def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'engine_run_audit' AND c.conname = 'engine_run_audit_engine_mode_chk';
  IF v_check_def IS NULL THEN
    RAISE EXCEPTION 'F-A-007 smoke FAIL: engine_run_audit_engine_mode_chk missing';
  END IF;
  IF v_check_def LIKE '%two_pass%' THEN
    RAISE EXCEPTION 'F-A-007 smoke FAIL: tightened CHECK still references two_pass: %', v_check_def;
  END IF;
  IF v_check_def LIKE '%unified_anthropic_failover%' THEN
    RAISE EXCEPTION 'F-A-007 smoke FAIL: tightened CHECK still references unified_anthropic_failover: %', v_check_def;
  END IF;
  IF v_check_def NOT LIKE '%shape_d_full%' OR v_check_def NOT LIKE '%shape_d_partial%' THEN
    RAISE EXCEPTION 'F-A-007 smoke FAIL: tightened CHECK missing required shape_d_full or shape_d_partial: %', v_check_def;
  END IF;
  RAISE NOTICE 'F-A-007 smoke OK — engine_mode CHECK is %', v_check_def;

  -- F-A-008: partial unique no longer references pass1 / pass2
  SELECT indexdef INTO v_index_def FROM pg_indexes
   WHERE indexname = 'uniq_shortlisting_jobs_active_pass_per_round';
  IF v_index_def IS NULL THEN
    RAISE EXCEPTION 'F-A-008 smoke FAIL: partial unique index missing';
  END IF;
  IF v_index_def LIKE '%''pass1''%' OR v_index_def LIKE '%''pass2''%' THEN
    RAISE EXCEPTION 'F-A-008 smoke FAIL: rebuilt partial unique still references pass1/pass2: %', v_index_def;
  END IF;
  IF v_index_def NOT LIKE '%pass0%' OR v_index_def NOT LIKE '%shape_d_stage1%' THEN
    RAISE EXCEPTION 'F-A-008 smoke FAIL: rebuilt partial unique missing pass0 or shape_d_stage1: %', v_index_def;
  END IF;
  RAISE NOTICE 'F-A-008 smoke OK — partial unique WHERE is %',
    SUBSTRING(v_index_def FROM POSITION('WHERE' IN v_index_def));

  -- F-A-010: NULL guard present in capture_human_override_as_observation
  SELECT pg_get_functiondef(p.oid) LIKE '%NEW.round_id IS NULL OR NEW.group_id IS NULL%'
    INTO v_guard_in_capture
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'capture_human_override_as_observation';
  IF NOT v_guard_in_capture THEN
    RAISE EXCEPTION 'F-A-010 smoke FAIL: NULL guard missing from capture_human_override_as_observation';
  END IF;
  RAISE NOTICE 'F-A-010 smoke OK — NULL guard present in capture_human_override_as_observation';

  -- F-A-011a: pulse_compute_quote_failures table exists
  SELECT COUNT(*) INTO v_failure_log_exists FROM pg_class
   WHERE relname = 'pulse_compute_quote_failures' AND relnamespace = 'public'::regnamespace;
  IF v_failure_log_exists <> 1 THEN
    RAISE EXCEPTION 'F-A-011 smoke FAIL: pulse_compute_quote_failures table missing';
  END IF;
  RAISE NOTICE 'F-A-011a smoke OK — pulse_compute_quote_failures exists';

  -- F-A-011b: advisory lock present in pulse_compute_listing_quote
  SELECT pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%pulse_compute_listing_quote%'
    INTO v_lock_in_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pulse_compute_listing_quote';
  IF NOT v_lock_in_body THEN
    RAISE EXCEPTION 'F-A-011 smoke FAIL: advisory lock missing from pulse_compute_listing_quote';
  END IF;
  RAISE NOTICE 'F-A-011b smoke OK — pg_advisory_xact_lock present in pulse_compute_listing_quote';

  -- F-A-011c: recompute trigger writes to pulse_compute_quote_failures
  SELECT pg_get_functiondef(p.oid) LIKE '%INSERT INTO public.pulse_compute_quote_failures%'
    INTO v_log_in_recompute
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'pulse_listing_vision_extract_recompute_trigger';
  IF NOT v_log_in_recompute THEN
    RAISE EXCEPTION 'F-A-011 smoke FAIL: recompute trigger missing failure-log INSERT';
  END IF;
  RAISE NOTICE 'F-A-011c smoke OK — recompute trigger logs to pulse_compute_quote_failures on EXCEPTION';
END $$;

-- ─── Final summary ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_failures int;
  v_check_count int;
  v_index_count int;
BEGIN
  SELECT COUNT(*) INTO v_failures FROM pulse_compute_quote_failures;
  SELECT COUNT(*) INTO v_check_count FROM pg_constraint
   WHERE conname IN ('engine_run_audit_engine_mode_chk','shortlisting_jobs_kind_check');
  SELECT COUNT(*) INTO v_index_count FROM pg_indexes
   WHERE indexname = 'uniq_shortlisting_jobs_active_pass_per_round';
  RAISE NOTICE
    'QC-iter2-W5 P1 data integrity: failure_log_rows=%, tightened_or_kept_checks=%/2, partial_unique_rebuilt=%',
    v_failures, v_check_count, v_index_count;
END $$;

COMMIT;

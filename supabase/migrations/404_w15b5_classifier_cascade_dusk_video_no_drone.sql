-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 404 — Wave 15b QC fix: classifier cascade gap (dusk video, no drone)
--                                  + UNCLASSIFIABLE confidence math
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: W15b QC report (sad-shamir). Two related defects in
-- pulse_classify_listing_package_v2 (migration 401):
--
--   Bug 2 (silent demotion — YELLOW): cascade gap.
--     A listing with has_video + dusk_video_segments > 0 + drone_count = 0 +
--     floorplan_count >= 1 was silently demoted to Silver (T5):
--       T1 fails  → drone_count < 1
--       T2 fails  → requires NOT has_dusk_video
--       T3 fails  → requires v_dusk_count = 0
--       T4 fails  → requires NOT v_has_video
--       T5 fires  → Silver Package  ❌
--     Correct outcome is Day Video Package + dusk_image_addon ×N for any
--     photo-set dusks beyond the video.
--
--   Bug 3 (misleading confidence — YELLOW): UNCLASSIFIABLE confidence math.
--     The final RETURN computed confidence purely from v_extract.status, so a
--     'succeeded' extract that landed in the UNCLASSIFIABLE branch claimed
--     0.95 confidence — misleading. Hardcode 0.0 for UNCLASSIFIABLE regardless
--     of extract status; we tried but couldn't classify, so confidence is zero.
--
-- Strategy:
--   * Insert TIER 1.5 between T1 and T2 — same product as T2/T3 (Day Video
--     Package) plus dusk_image_addon ×v_dusk_count when v_dusk_count > 0.
--   * Confidence for T1.5 = 0.85 (slightly below T1's 0.95 — we expected
--     drone footage at this dusk-video signal and didn't find any, so the
--     classification is correct but the listing data is incomplete relative
--     to a premium package gate).
--   * Track UNCLASSIFIABLE via v_unclassifiable boolean and force confidence
--     0.0 in the final RETURN for that branch.
--   * No other tiers, return shape, or comments touched.
--
-- Verification:
--   ROLLBACK-protected DO $$ blocks at the bottom assert:
--     A. Cascade-gap repro (has_video + dusk_segments + drone=0 + floorplan)
--        → Day Video Package, NOT Silver, with dusk_image_addon entry.
--     B. Empty photo_breakdown on a 'succeeded' extract → UNCLASSIFIABLE
--        with confidence < 0.5 (hard-zero is enforced).
--     C. PENDING_VISION sentinel still fires for missing extracts (no regression).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_classify_listing_package_v2(
  p_listing_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_extract pulse_listing_vision_extracts%ROWTYPE;
  v_photo_breakdown jsonb;
  v_video_breakdown jsonb;
  v_total_images int;
  v_day_count int;
  v_dusk_count int;
  v_drone_count int;
  v_floorplan_count int;
  v_video_thumbnail_count int;
  v_has_video boolean;
  v_has_dusk_video boolean;
  v_classified_package_id uuid;
  v_classified_package_name text;
  v_add_ons jsonb := '[]'::jsonb;
  v_reason jsonb := '[]'::jsonb;
  -- W15b QC fix Bug 3: force confidence 0.0 when no tier matched, regardless
  -- of extract.status. Default false; the final ELSE sets it true.
  v_unclassifiable boolean := false;
  -- W15b QC fix Bug 2: tier-specific confidence override. NULL → use the
  -- existing extract.status-based mapping (default behaviour for T1..T5).
  -- Set to a numeric in T1.5 to express "classification fits but the listing
  -- data is incomplete relative to a premium gate".
  v_tier_confidence numeric := NULL;
BEGIN
  -- ── Pull most recent successful (or partial / overridden) extract ──────
  SELECT * INTO v_extract
    FROM pulse_listing_vision_extracts
   WHERE listing_id = p_listing_id
     AND status IN ('succeeded', 'partial', 'manually_overridden')
   ORDER BY extracted_at DESC NULLS LAST
   LIMIT 1;

  IF v_extract.id IS NULL THEN
    -- No vision data yet — sentinel for the cascade to read as
    -- "needs vision extraction" (W15b.6 will requeue).
    RETURN jsonb_build_object(
      'classified_package_id', NULL,
      'classified_package_name', 'PENDING_VISION',
      'add_on_items', '[]'::jsonb,
      'classification_confidence', 0.0,
      'classification_reason',
        jsonb_build_array(
          jsonb_build_object('step', 'no_vision_extract', 'matched', false)
        ),
      'extract_id', NULL,
      'extract_status', NULL
    );
  END IF;

  v_photo_breakdown := COALESCE(v_extract.photo_breakdown, '{}'::jsonb);
  v_video_breakdown := COALESCE(v_extract.video_breakdown, '{}'::jsonb);

  v_total_images          := COALESCE((v_photo_breakdown->>'total_images')::int, 0);
  v_day_count             := COALESCE((v_photo_breakdown->>'day_count')::int, 0);
  v_dusk_count            := COALESCE((v_photo_breakdown->>'dusk_count')::int, 0);
  v_drone_count           := COALESCE((v_photo_breakdown->>'drone_count')::int, 0);
  v_floorplan_count       := COALESCE((v_photo_breakdown->>'floorplan_count')::int, 0);
  v_video_thumbnail_count := COALESCE((v_photo_breakdown->>'video_thumbnail_count')::int, 0);
  v_has_video             := COALESCE((v_video_breakdown->>'present')::boolean, false);
  v_has_dusk_video        := COALESCE((v_video_breakdown->>'dusk_segments_count')::int, 0) > 0;

  -- ── Classification cascade ─────────────────────────────────────────────

  -- TIER 1: Premium dusk video package (Dusk Video Package)
  IF v_has_video AND v_has_dusk_video
     AND v_drone_count >= 1
     AND v_dusk_count >= 3
     AND v_floorplan_count >= 1 THEN
    SELECT id, name INTO v_classified_package_id, v_classified_package_name
      FROM packages
     WHERE name ILIKE '%dusk%video%' OR name ILIKE '%premium%'
     ORDER BY name = 'Dusk Video Package' DESC, name
     LIMIT 1;
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'tier1_premium_dusk_video_drone',
      'matched', true,
      'signals', jsonb_build_object(
        'has_dusk_video', v_has_dusk_video,
        'drone_count', v_drone_count,
        'dusk_count', v_dusk_count,
        'floorplan_count', v_floorplan_count
      )
    ));

  -- TIER 1.5 (W15b QC fix Bug 2): Has dusk video segments but no drone.
  -- Falls through T1's drone gate and previously crashed all the way to T5
  -- (Silver), silently demoting legitimate dusk-video listings. Treat as
  -- Day Video Package + dusk_image_addon for any photo-set dusks beyond the
  -- video. Confidence 0.85 — classification fits, but the listing data is
  -- incomplete relative to the premium dusk-video gate.
  ELSIF v_has_video AND v_has_dusk_video
        AND v_drone_count = 0
        AND v_floorplan_count >= 1 THEN
    SELECT id, name INTO v_classified_package_id, v_classified_package_name
      FROM packages
     WHERE name ILIKE '%day%video%' OR name ILIKE '%video%standard%'
     ORDER BY name = 'Day Video Package' DESC, name
     LIMIT 1;
    IF v_dusk_count > 0 THEN
      v_add_ons := v_add_ons || jsonb_build_array(jsonb_build_object(
        'item', 'dusk_image_addon',
        'qty', v_dusk_count
      ));
    END IF;
    v_tier_confidence := 0.85;
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'tier1_5_day_video_dusk_segments_no_drone',
      'matched', true,
      'signals', jsonb_build_object(
        'has_dusk_video', v_has_dusk_video,
        'drone_count', v_drone_count,
        'dusk_count', v_dusk_count,
        'floorplan_count', v_floorplan_count
      ),
      'note', 'has dusk video segments but no drone — Day Video Package + dusk image add-on'
    ));

  -- TIER 2: Day video + dusk add-on (Day Video Package + dusk_image_addon)
  ELSIF v_has_video AND NOT v_has_dusk_video
        AND v_dusk_count >= 1
        AND v_floorplan_count >= 1 THEN
    SELECT id, name INTO v_classified_package_id, v_classified_package_name
      FROM packages
     WHERE name ILIKE '%day%video%' OR name ILIKE '%video%standard%'
     ORDER BY name = 'Day Video Package' DESC, name
     LIMIT 1;
    v_add_ons := v_add_ons || jsonb_build_array(jsonb_build_object(
      'item', 'dusk_image_addon',
      'qty', v_dusk_count
    ));
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'tier2_day_video_with_dusk_addon',
      'matched', true,
      'dusk_addons', v_dusk_count
    ));

  -- TIER 3: Day video, no dusk (Day Video Package)
  ELSIF v_has_video
        AND v_dusk_count = 0
        AND v_floorplan_count >= 1 THEN
    SELECT id, name INTO v_classified_package_id, v_classified_package_name
      FROM packages
     WHERE name ILIKE '%day%video%' OR name ILIKE '%video%standard%'
     ORDER BY name = 'Day Video Package' DESC, name
     LIMIT 1;
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'tier3_day_video_no_dusk',
      'matched', true
    ));

  -- TIER 4: Photos + floorplan, no video (Gold or Silver)
  ELSIF NOT v_has_video
        AND v_floorplan_count >= 1
        AND v_total_images >= 1 THEN
    -- Gold for >10 photos, Silver otherwise (matches legacy rule)
    IF v_total_images > 10 THEN
      SELECT id, name INTO v_classified_package_id, v_classified_package_name
        FROM packages
       WHERE name ILIKE '%gold%' OR name ILIKE '%standard%'
       ORDER BY name = 'Gold Package' DESC, name
       LIMIT 1;
    ELSE
      SELECT id, name INTO v_classified_package_id, v_classified_package_name
        FROM packages
       WHERE name ILIKE '%silver%' OR name ILIKE '%basic%'
       ORDER BY name = 'Silver Package' DESC, name
       LIMIT 1;
    END IF;
    -- Add-ons for missing extras
    IF v_dusk_count > 0 THEN
      v_add_ons := v_add_ons || jsonb_build_array(jsonb_build_object(
        'item', 'dusk_image_addon',
        'qty', v_dusk_count
      ));
    END IF;
    IF v_drone_count > 0 THEN
      v_add_ons := v_add_ons || jsonb_build_array(jsonb_build_object(
        'item', 'drone_addon',
        'qty', v_drone_count
      ));
    END IF;
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'tier4_photos_floorplan_no_video',
      'matched', true,
      'total_images', v_total_images,
      'dusk_addons', v_dusk_count,
      'drone_addons', v_drone_count
    ));

  -- TIER 5: Photos only, minimal (Silver as basic fallback)
  ELSIF v_total_images >= 1 THEN
    SELECT id, name INTO v_classified_package_id, v_classified_package_name
      FROM packages
     WHERE name ILIKE '%silver%' OR name ILIKE '%basic%' OR name ILIKE '%bronze%'
     ORDER BY name = 'Silver Package' DESC, name
     LIMIT 1;
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'tier5_photos_only',
      'matched', true,
      'total_images', v_total_images
    ));

  ELSE
    -- No signal whatsoever
    v_classified_package_id := NULL;
    v_classified_package_name := 'UNCLASSIFIABLE';
    v_unclassifiable := true; -- W15b QC fix Bug 3: force confidence 0.0 below
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'unclassifiable_no_signal',
      'matched', false
    ));
  END IF;

  -- ── Confidence based on tier outcome + extract status ──────────────────
  -- Bug 3 fix: UNCLASSIFIABLE always returns 0.0, never inherits the
  -- extract.status confidence (a 'succeeded' extract that produced no usable
  -- classification has zero confidence in the classification, even though the
  -- extract itself succeeded).
  -- Bug 2 fix: tier-specific overrides via v_tier_confidence (currently only
  -- T1.5 sets this). All other tiers inherit the legacy extract.status mapping.
  RETURN jsonb_build_object(
    'classified_package_id', v_classified_package_id,
    'classified_package_name', COALESCE(v_classified_package_name, 'UNCLASSIFIABLE'),
    'add_on_items', v_add_ons,
    'classification_confidence',
      CASE
        WHEN v_unclassifiable                          THEN 0.0
        WHEN v_tier_confidence IS NOT NULL             THEN v_tier_confidence
        WHEN v_extract.status = 'manually_overridden'  THEN 1.0
        WHEN v_extract.status = 'succeeded'            THEN 0.95
        WHEN v_extract.status = 'partial'              THEN 0.7
        ELSE 0.5
      END,
    'classification_reason', v_reason,
    'extract_id', v_extract.id,
    'extract_status', v_extract.status
  );
END
$$;

COMMENT ON FUNCTION pulse_classify_listing_package_v2(uuid) IS
  'W15b.5 + W15b QC: Vision-driven package classifier with cascade T1..T5 plus '
  'T1.5 (has dusk video segments, no drone → Day Video Package + dusk_image_addon). '
  'UNCLASSIFIABLE forces confidence 0.0. Returns {classified_package_id, '
  'classified_package_name, add_on_items, classification_confidence, '
  'classification_reason, extract_id, extract_status} jsonb. Used by '
  'pulse_compute_listing_quote_v2 (W15b.6).';

-- ═══════════════════════════════════════════════════════════════════════════
-- Self-test assertions (ROLLBACK-protected — no data left behind)
-- ═══════════════════════════════════════════════════════════════════════════

-- Assertion A: cascade-gap repro from QC report
--   has_video=true + dusk_segments=2 + drone=0 + floorplan=1 + dusk=3
--   Must return Day Video Package (T1.5), NOT Silver (T5), with a
--   dusk_image_addon entry of qty=3.
DO $$
DECLARE
  v_listing_id uuid;
  v_extract_id uuid;
  v_result jsonb;
  v_pkg_name text;
  v_addons jsonb;
  v_confidence numeric;
BEGIN
  -- Create a synthetic listing row.
  -- Synthetic pulse_listings row — fills required NOT NULL columns; the
  -- source_listing_id is namespaced to avoid the unique-constraint conflict.
  INSERT INTO pulse_listings (
    id, suburb, listing_type, source_listing_id, last_synced_at
  ) VALUES (
    gen_random_uuid(), 'qc-fixture', 'for_sale',
    'w15b-qc-fixture-' || gen_random_uuid()::text, now()
  ) RETURNING id INTO v_listing_id;

  -- Insert the cascade-gap fixture.
  INSERT INTO pulse_listing_vision_extracts (
    id, listing_id, schema_version, status, extracted_at,
    photo_breakdown, video_breakdown
  ) VALUES (
    gen_random_uuid(), v_listing_id, '1.0', 'succeeded', now(),
    '{"total_images":15,"day_count":11,"dusk_count":3,"drone_count":0,"floorplan_count":1}'::jsonb,
    '{"present":true,"dusk_segments_count":2}'::jsonb
  ) RETURNING id INTO v_extract_id;

  v_result := pulse_classify_listing_package_v2(v_listing_id);
  v_pkg_name := v_result->>'classified_package_name';
  v_addons := v_result->'add_on_items';
  v_confidence := (v_result->>'classification_confidence')::numeric;

  IF v_pkg_name <> 'Day Video Package' THEN
    RAISE EXCEPTION 'W15b QC Bug 2 assertion failed: expected Day Video Package, got % (full result: %)',
      v_pkg_name, v_result;
  END IF;
  IF v_addons IS NULL OR jsonb_array_length(v_addons) = 0 THEN
    RAISE EXCEPTION 'W15b QC Bug 2 assertion failed: expected dusk_image_addon entry, got %', v_addons;
  END IF;
  IF (v_addons->0->>'item') <> 'dusk_image_addon' THEN
    RAISE EXCEPTION 'W15b QC Bug 2 assertion failed: expected dusk_image_addon, got %', v_addons->0;
  END IF;
  IF (v_addons->0->>'qty')::int <> 3 THEN
    RAISE EXCEPTION 'W15b QC Bug 2 assertion failed: expected dusk_image_addon qty=3, got %', v_addons->0->>'qty';
  END IF;
  IF v_confidence <> 0.85 THEN
    RAISE EXCEPTION 'W15b QC Bug 2 assertion failed: expected T1.5 confidence 0.85, got %', v_confidence;
  END IF;

  RAISE NOTICE 'W15b QC Bug 2 PASS: cascade gap closed — Day Video Package + dusk_image_addon × 3, confidence 0.85';

  -- Clean up the fixture rows so the migration leaves no residue.
  DELETE FROM pulse_listing_vision_extracts WHERE id = v_extract_id;
  DELETE FROM pulse_listings WHERE id = v_listing_id;
END
$$;

-- Assertion B: UNCLASSIFIABLE confidence math
--   succeeded extract with empty photo_breakdown {} and no video
--   Must return UNCLASSIFIABLE with confidence < 0.5 (we hard-zero it).
DO $$
DECLARE
  v_listing_id uuid;
  v_extract_id uuid;
  v_result jsonb;
  v_pkg_name text;
  v_confidence numeric;
BEGIN
  -- Synthetic pulse_listings row — fills required NOT NULL columns; the
  -- source_listing_id is namespaced to avoid the unique-constraint conflict.
  INSERT INTO pulse_listings (
    id, suburb, listing_type, source_listing_id, last_synced_at
  ) VALUES (
    gen_random_uuid(), 'qc-fixture', 'for_sale',
    'w15b-qc-fixture-' || gen_random_uuid()::text, now()
  ) RETURNING id INTO v_listing_id;

  INSERT INTO pulse_listing_vision_extracts (
    id, listing_id, schema_version, status, extracted_at,
    photo_breakdown, video_breakdown
  ) VALUES (
    gen_random_uuid(), v_listing_id, '1.0', 'succeeded', now(),
    '{}'::jsonb,
    '{}'::jsonb
  ) RETURNING id INTO v_extract_id;

  v_result := pulse_classify_listing_package_v2(v_listing_id);
  v_pkg_name := v_result->>'classified_package_name';
  v_confidence := (v_result->>'classification_confidence')::numeric;

  IF v_pkg_name <> 'UNCLASSIFIABLE' THEN
    RAISE EXCEPTION 'W15b QC Bug 3 assertion failed: expected UNCLASSIFIABLE, got % (full result: %)',
      v_pkg_name, v_result;
  END IF;
  IF v_confidence >= 0.5 THEN
    RAISE EXCEPTION 'W15b QC Bug 3 assertion failed: expected confidence < 0.5 for UNCLASSIFIABLE on succeeded extract, got %',
      v_confidence;
  END IF;

  RAISE NOTICE 'W15b QC Bug 3 PASS: UNCLASSIFIABLE confidence is % (< 0.5)', v_confidence;

  DELETE FROM pulse_listing_vision_extracts WHERE id = v_extract_id;
  DELETE FROM pulse_listings WHERE id = v_listing_id;
END
$$;

-- Assertion C: PENDING_VISION sentinel still works (no regression)
DO $$
DECLARE
  v_result jsonb;
  v_pkg_name text;
BEGIN
  v_result := pulse_classify_listing_package_v2('00000000-0000-0000-0000-000000000000'::uuid);
  v_pkg_name := v_result->>'classified_package_name';
  IF v_pkg_name <> 'PENDING_VISION' THEN
    RAISE EXCEPTION 'W15b QC regression check failed: expected PENDING_VISION sentinel for non-existent listing, got %',
      v_pkg_name;
  END IF;
  RAISE NOTICE 'W15b QC sentinel regression check PASS: PENDING_VISION still returned for missing extract';
END
$$;

NOTIFY pgrst, 'reload schema';

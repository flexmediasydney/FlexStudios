-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 401 — Wave 15b.5: pulse_classify_listing_package_v2
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md (W15b.5)
--
-- Purpose:
--   Vision-driven package classifier. Replaces the crude rule-based
--   pulse_classify_listing_package(p_photos, p_has_fp, p_has_video,
--   p_asking_price) with a cascade that reads the per-listing aggregate from
--   pulse_listing_vision_extracts (W15b.2) and maps the rich product mix
--   (day/dusk/drone counts, floorplan presence, video segments) to the
--   closest base package + add-on items via the existing overflow_charge
--   pattern (Option A).
--
-- Inputs:
--   * p_listing_id uuid — the pulse_listings row to classify.
--
-- Output (jsonb):
--   {
--     classified_package_id    : uuid | null,
--     classified_package_name  : text   ('Silver Package' | 'Gold Package' |
--                                        'Day Video Package' | 'Dusk Video Package' |
--                                        'Flex Package' | 'PENDING_VISION' |
--                                        'UNCLASSIFIABLE'),
--     add_on_items             : jsonb  ([{item, qty}, ...]),
--     classification_confidence: numeric(0..1),
--     classification_reason    : jsonb  (cascade trace),
--     extract_id               : uuid | null,
--     extract_status           : text  | null
--   }
--
-- Cascade tiers (top-down — first match wins):
--   T1 Premium Dusk Video — has_video + dusk video segments + drone≥1 +
--                           dusk≥3 + floorplan≥1 → Dusk Video Package
--   T2 Day Video + Dusk addon — has_video + dusk≥1 + floorplan≥1 (no dusk vid)
--                               → Day Video Package + dusk_image_addon ×N
--   T3 Day Video Standard — has_video + dusk=0 + floorplan≥1
--                           → Day Video Package
--   T4 Photos + Floorplan — no_video + floorplan≥1 + total_images≥10
--                           → Gold Package (>10 photos) | Silver (≤10)
--                           Add-ons: dusk_image_addon ×N, drone_addon ×N
--   T5 Photos only — total_images≥1 → Silver Package (basic)
--   else UNCLASSIFIABLE
--
-- Sentinel: when no successful extract exists for the listing, returns
--   classified_package_name = 'PENDING_VISION' so the pulse_compute_listing_quote
--   cascade (W15b.6) can short-circuit and queue a vision extract.
--
-- Confidence:
--   succeeded               → 0.95
--   partial                 → 0.7
--   manually_overridden     → 1.0
--   any other status / no extract → 0.5 / 0.0 (PENDING_VISION)
--
-- Constraints:
--   * STABLE — reads pulse_listing_vision_extracts and packages but does not
--     mutate. Safe to call from SELECT / RPC.
--   * Does NOT modify the existing pulse_classify_listing_package — W15b.10
--     drops it after smoke validation of v2.
--   * Does NOT modify pulse_compute_listing_quote — W15b.6 wires it to v2.
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
    v_reason := v_reason || jsonb_build_array(jsonb_build_object(
      'step', 'unclassifiable_no_signal',
      'matched', false
    ));
  END IF;

  -- ── Confidence based on extract status ─────────────────────────────────
  RETURN jsonb_build_object(
    'classified_package_id', v_classified_package_id,
    'classified_package_name', COALESCE(v_classified_package_name, 'UNCLASSIFIABLE'),
    'add_on_items', v_add_ons,
    'classification_confidence',
      CASE
        WHEN v_extract.status = 'manually_overridden' THEN 1.0
        WHEN v_extract.status = 'succeeded'           THEN 0.95
        WHEN v_extract.status = 'partial'             THEN 0.7
        ELSE 0.5
      END,
    'classification_reason', v_reason,
    'extract_id', v_extract.id,
    'extract_status', v_extract.status
  );
END
$$;

COMMENT ON FUNCTION pulse_classify_listing_package_v2(uuid) IS
  'W15b.5: Vision-driven package classifier. Replaces pulse_classify_listing_package (rule-based) '
  'with a vision-evidence cascade reading pulse_listing_vision_extracts. Returns '
  '{classified_package_id, classified_package_name, add_on_items, classification_confidence, '
  'classification_reason, extract_id, extract_status} jsonb. Used by '
  'pulse_compute_listing_quote_v2 (W15b.6).';

-- ── Self-test: verify SQL syntax + sentinel return for a non-existent listing
DO $$
DECLARE
  v_result jsonb;
  v_pkg_name text;
BEGIN
  v_result := pulse_classify_listing_package_v2('00000000-0000-0000-0000-000000000000'::uuid);
  v_pkg_name := v_result->>'classified_package_name';
  IF v_pkg_name <> 'PENDING_VISION' THEN
    RAISE EXCEPTION 'W15b.5 self-test failed: expected PENDING_VISION sentinel for non-existent listing, got %',
      v_pkg_name;
  END IF;
  RAISE NOTICE 'W15b.5 self-test passed: PENDING_VISION sentinel returned for missing extract';
END
$$;

NOTIFY pgrst, 'reload schema';

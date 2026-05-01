-- Migration 406 — W15b.6 keystone wave (Piece 2)
--
-- Auto-trigger `pulse_compute_listing_quote(listing_id)` whenever a row in
-- `pulse_listing_vision_extracts` transitions to status='succeeded'. This
-- closes the loop: when W15b.1 / W15b.3 finish writing an extract, the quote
-- engine re-runs without anyone needing to invoke pulseRecomputeLegacy.
--
-- Defensive: the trigger function wraps the recompute in BEGIN/EXCEPTION/END
-- so a quote-engine error never blocks the extract write itself. The whole
-- chain is best-effort observability — if recompute fails, the extract row
-- still lands and an operator can re-run quote computation manually.
--
-- Trigger fires on AFTER INSERT OR AFTER UPDATE OF status when:
--   - NEW.status = 'succeeded'
--   - AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'succeeded')
-- This avoids re-firing on no-op updates that touch other columns.
--
-- NOTE: This migration is applied via Supabase MCP `apply_migration` (the body
-- runs in MCP's own transaction). The trailing self-test block is run via
-- `execute_sql` afterward inside its own BEGIN; ... ROLLBACK; — kept here for
-- traceability.

CREATE OR REPLACE FUNCTION public.pulse_listing_vision_extract_recompute_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only fire when status transitions INTO 'succeeded' (or the first INSERT
  -- already lands in that state). Skip no-op updates that touch other
  -- columns. PostgreSQL forbids OLD references in INSERT-trigger WHEN
  -- clauses, so we gate inside the function body instead of the WHEN clause.
  IF NEW.status <> 'succeeded' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM pulse_compute_listing_quote(NEW.listing_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pulse_compute_listing_quote(%) failed in vision-extract recompute trigger: %', NEW.listing_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pulse_listing_vision_extract_recompute_trigger() IS
  'W15b.6: AFTER INSERT/UPDATE on pulse_listing_vision_extracts → calls pulse_compute_listing_quote(listing_id) when status flips to succeeded. Wrapped in EXCEPTION block so quote-engine errors never block the extract write.';

DROP TRIGGER IF EXISTS trg_pulse_vision_extract_recompute
  ON public.pulse_listing_vision_extracts;

CREATE TRIGGER trg_pulse_vision_extract_recompute
  AFTER INSERT OR UPDATE OF status ON public.pulse_listing_vision_extracts
  FOR EACH ROW
  EXECUTE FUNCTION public.pulse_listing_vision_extract_recompute_trigger();

/*  Run via execute_sql (NOT inside apply_migration) — wrapped in
    BEGIN; ... ROLLBACK; so the synthetic listing/extract get cleaned up:

BEGIN;

DO $w15b6_trigger_test$
DECLARE
  v_listing_id uuid := gen_random_uuid();
  v_quoted_via text;
BEGIN
  INSERT INTO pulse_listings (
    id, source_listing_id, source_url, listing_type, status, suburb, postcode,
    detail_enriched_at, last_synced_at,
    media_items, images, video_url, has_video, floorplan_urls,
    asking_price, price_text, first_seen_at
  ) VALUES (
    v_listing_id, 'w15b6_trigger_' || v_listing_id::text, 'https://example.test/trigger/' || v_listing_id::text,
    'for_sale', 'active', 'Trigsuburb', '2000',
    now(), now(),
    '[]'::jsonb, '[]'::jsonb, NULL, false, ARRAY[]::text[],
    600000, '$600,000', now()
  );

  -- Insert a succeeded extract row → trigger should fire and recompute quote
  INSERT INTO pulse_listing_vision_extracts (
    listing_id, schema_version, status, extracted_at,
    photo_breakdown, video_breakdown, total_cost_usd, vendor, model_version
  ) VALUES (
    v_listing_id, 'v1.0', 'succeeded', now(),
    jsonb_build_object('total_images', 30, 'day_count', 25, 'dusk_count', 3,
                       'drone_count', 2, 'floorplan_count', 1, 'video_thumbnail_count', 0),
    jsonb_build_object('present', true, 'dusk_segments_count', 1, 'segments', jsonb_build_array()),
    0.05, 'google', 'gemini-2.5-flash'
  );

  -- The trigger should have fired and produced a quote with quoted_via='vision_v2'
  SELECT quoted_via INTO v_quoted_via
    FROM pulse_listing_missed_opportunity WHERE listing_id = v_listing_id;
  IF v_quoted_via IS DISTINCT FROM 'vision_v2' THEN
    RAISE EXCEPTION 'W15b.6 TRIGGER ASSERT FAILED: expected quoted_via=vision_v2 after trigger fired, got %', v_quoted_via;
  END IF;
  RAISE NOTICE 'W15b.6 trigger PASS: quoted_via=% for listing %', v_quoted_via, v_listing_id;
END
$w15b6_trigger_test$;

ROLLBACK;

*/

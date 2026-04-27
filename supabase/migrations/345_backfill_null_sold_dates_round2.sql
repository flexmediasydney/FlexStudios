-- Migration 345: second-round backfill of NULL sold_date on pulse_listings.
--
-- Migration 217 (2026-04-24) ran a one-time backfill that filled 2,025 rows.
-- pulseDataSync also gained a fallback for INSERT and for_sale→sold paths.
-- A third gap remained: rows that were ALREADY listing_type='sold' on first
-- ingest but with no soldDate from the Apify actor, then re-touched on every
-- subsequent scrape without entering either fallback branch.
--
-- Audit at the time of writing this migration: 1,838 rows with
-- listing_type='sold' AND sold_date IS NULL. Of those, ~1,455 had a
-- first_seen_at in April 2026 — almost certainly April sales currently
-- invisible to the Industry Pulse > Market Share dashboard, which dragged
-- the "this month" sold count down to 962 versus a true ~2,400.
--
-- Same backfill strategy as 217: COALESCE through the best-available
-- timestamp proxy. Tag every backfilled row with sold_date_inferred=true
-- so the UI can caveat aggregations and so a later authoritative sold_date
-- (if Apify ever returns one) can overwrite without losing context.
--
-- The matching code-side prevention shipped to pulseDataSync alongside this
-- migration (see the "2026-04-28 follow-up" block in the sold_date fallback).

BEGIN;

DO $$
DECLARE
  v_before_null int;
  v_after_null int;
  v_updated int;
BEGIN
  SELECT count(*) INTO v_before_null FROM pulse_listings
    WHERE listing_type='sold' AND sold_date IS NULL;

  UPDATE pulse_listings
  SET sold_date = COALESCE(
        status_changed_at::date,
        first_seen_at::date,
        last_synced_at::date,
        created_at::date
      ),
      sold_date_inferred = true
  WHERE listing_type = 'sold'
    AND sold_date IS NULL
    AND COALESCE(status_changed_at, first_seen_at, last_synced_at, created_at) IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(*) INTO v_after_null FROM pulse_listings
    WHERE listing_type='sold' AND sold_date IS NULL;

  RAISE NOTICE 'Migration 345: sold_date backfill round 2 — before_null=%, updated=%, after_null=% (remaining are rows with no usable timestamp at all)',
    v_before_null, v_updated, v_after_null;
END $$;

COMMIT;

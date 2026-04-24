-- Migration 217: backfill sold_date on pulse_listings rows that transitioned
-- to listing_type='sold' via an UPDATE path, where pulseDataSync's fallback
-- (which only fires on INSERT of a brand-new row) did not populate sold_date.
--
-- Audit (captured before running): 2,025 rows with listing_type='sold' and
-- sold_date IS NULL. Breakdown by first_seen_at:
--   • 1,524 rows with first_seen_at in April 2026 (recent for_sale → sold
--     transitions that leaked past the INSERT-only fallback)
--   • 501 rows with first_seen_at IS NULL (legacy migration orphans)
--
-- Fix strategy: populate sold_date with the best-available proxy in this
-- priority order (first non-null wins):
--   1. status_changed_at::date  — the moment we detected the sold transition
--   2. first_seen_at::date      — when we first scraped the listing
--   3. last_synced_at::date     — when the listing was last touched by sync
--   4. created_at::date         — row birth date
--
-- All backfilled rows get sold_date_inferred = true so the UI can caveat
-- aggregations and so a future, authoritative sold_date (if Apify ever
-- returns one) can overwrite these without losing the "this was inferred"
-- context.

BEGIN;

-- Audit-friendly: write the counts BEFORE and AFTER the UPDATE so the
-- migration log records the delta.
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

  RAISE NOTICE 'Migration 217: sold_date backfill — before_null=%, updated=%, after_null=% (remaining are rows with no usable timestamp at all)',
    v_before_null, v_updated, v_after_null;
END $$;

COMMIT;

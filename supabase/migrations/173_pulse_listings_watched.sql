-- 173_pulse_listings_watched.sql
-- Adds a per-listing "watched" marker so operators can flag listings to follow
-- from the Industry Pulse Listings tab. Bulk action "Mark all as watched" sets
-- watched_at = now() on selected ids; the chip/filter surfaces in the Listings
-- UI so staff can revisit the subset without a saved view.
--
-- Safe to re-run: IF NOT EXISTS guard on the column + index.

BEGIN;

ALTER TABLE pulse_listings
  ADD COLUMN IF NOT EXISTS watched_at timestamptz;

COMMENT ON COLUMN pulse_listings.watched_at IS
  'Operator-flagged "watching this listing" marker. Bulk-settable from the Listings tab; NULL = not watched. No business logic depends on this yet — purely a filter dimension for the operator.';

-- Partial index: only a tiny fraction of listings will ever be watched, so
-- indexing just the non-null subset keeps the index small and fast for the
-- "watched = yes" filter.
CREATE INDEX IF NOT EXISTS idx_pulse_listings_watched_at
  ON pulse_listings (watched_at DESC)
  WHERE watched_at IS NOT NULL;

COMMIT;

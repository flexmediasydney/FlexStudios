-- 115_auction_time_known_plus.sql
-- Fixes:
--   B15  formatAuctionDateTime drops midnight-UTC auctions. Add an explicit
--        boolean column `auction_time_known` so the UI doesn't have to infer
--        from hh:mm == 00:00 (which is ambiguous — 10am AEST is also 00:00 UTC).
--   B32  pulseDataSync upsert might clobber first_seen_at. Add a BEFORE
--        UPDATE trigger that preserves non-null first_seen_at across writes.
--   B44  agency.address shape: detail-enrich now populates address_street with
--        just the street portion. Nothing to fix at the DB level but backfill
--        where the existing address column has only street-level data.

BEGIN;

-- ── B15: auction_time_known ──────────────────────────────────────────────
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS auction_time_known BOOLEAN DEFAULT FALSE;

-- Heuristic backfill: auctions with non-zero minute portion definitely have a
-- real time. Auctions at exactly 00:00 UTC are ambiguous (could be 10am AEST).
-- Default to FALSE so UI falls back to date-only rendering; detail-enrich
-- will stamp TRUE going forward.
UPDATE pulse_listings
SET auction_time_known = TRUE
WHERE auction_date IS NOT NULL
  AND (
    EXTRACT(MINUTE FROM auction_date) != 0
    OR EXTRACT(SECOND FROM auction_date) != 0
    OR EXTRACT(HOUR FROM auction_date) NOT IN (0)  -- midnight UTC only ambiguous one
  );

COMMENT ON COLUMN pulse_listings.auction_time_known IS
  'TRUE when auction_date has a meaningful time-of-day (not a legacy date-only '
  'value cast to midnight UTC). Written by pulseDetailEnrich; legacy rows '
  'backfilled from hh:mm:ss heuristic (non-midnight = known).';

-- ── B32: first_seen_at preservation trigger ─────────────────────────────
-- If an UPDATE tries to overwrite an existing non-null first_seen_at with a
-- newer value, preserve the old one. Protects against upserts that naively
-- re-stamp first_seen_at on every sync.
CREATE OR REPLACE FUNCTION pulse_preserve_first_seen_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.first_seen_at IS NOT NULL THEN
    NEW.first_seen_at := OLD.first_seen_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_agents_preserve_first_seen ON pulse_agents;
CREATE TRIGGER pulse_agents_preserve_first_seen
  BEFORE UPDATE ON pulse_agents
  FOR EACH ROW EXECUTE FUNCTION pulse_preserve_first_seen_at();

DROP TRIGGER IF EXISTS pulse_listings_preserve_first_seen ON pulse_listings;
CREATE TRIGGER pulse_listings_preserve_first_seen
  BEFORE UPDATE ON pulse_listings
  FOR EACH ROW EXECUTE FUNCTION pulse_preserve_first_seen_at();

COMMENT ON FUNCTION pulse_preserve_first_seen_at IS
  'Protects first_seen_at from being overwritten by upserts. pulse_agencies '
  'does not have first_seen_at and is unaffected.';

COMMIT;

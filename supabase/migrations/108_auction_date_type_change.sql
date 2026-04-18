-- 108_auction_date_type_change.sql
-- NO-OP: pulse_listings.auction_date was declared TIMESTAMPTZ by the original
-- Base44-era schema import, not DATE as the audit assumed. Detail-enrich can
-- write full ISO datetimes directly with no column-type change required.
--
-- Kept as a placeholder file so the 103-109 migration sequence stays contiguous
-- and the audit-trail documentation (pointed to by the architecture plan)
-- remains valid.
--
-- If a future migration ever needs to alter auction_date (e.g., drop/rename),
-- it must first DROP VIEW property_prospects_v since that view captures the
-- column type.

-- Just the comment update
BEGIN;

COMMENT ON COLUMN pulse_listings.auction_date IS
  'Exact auction datetime (from listing.auctionTime.startTime on the detail page). TIMESTAMPTZ — preserves time-of-day. Written by pulseDetailEnrich with full ISO UTC datetimes.';

COMMIT;

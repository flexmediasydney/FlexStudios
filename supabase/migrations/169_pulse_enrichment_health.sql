-- 169_pulse_enrichment_health.sql
-- Adds pulse_get_enrichment_health() → jsonb with enrichment coverage,
-- throughput, backlog, and staleness counters for the DataFreshnessCard
-- widget that now appears across every Industry Pulse surface.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_get_enrichment_health()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH totals AS (
    SELECT
      -- For the headline coverage metric, focus on for_sale — that's what
      -- drives Market Share. Rentals and sold listings are tracked
      -- separately but less time-sensitive.
      count(*) FILTER (WHERE listing_type = 'for_sale') AS for_sale_total,
      count(*) FILTER (WHERE listing_type = 'for_sale' AND detail_enriched_at IS NOT NULL) AS for_sale_enriched,
      count(*) FILTER (WHERE listing_type = 'for_sale' AND detail_enriched_at IS NULL) AS for_sale_pending,
      count(*) FILTER (WHERE listing_type = 'for_sale' AND detail_enriched_at < now() - interval '14 days') AS stale_enriched_gt_14d,
      count(*) AS all_listings_total,
      count(*) FILTER (WHERE detail_enriched_at IS NOT NULL) AS all_enriched,
      count(*) FILTER (WHERE detail_enriched_at > now() - interval '5 minutes') AS enriched_last_5min,
      count(*) FILTER (WHERE detail_enriched_at > now() - interval '1 hour') AS enriched_last_1h,
      count(*) FILTER (WHERE detail_enriched_at > now() - interval '24 hours') AS enriched_last_24h
    FROM pulse_listings
  )
  SELECT jsonb_build_object(
    'for_sale_total',         for_sale_total,
    'for_sale_enriched',      for_sale_enriched,
    'for_sale_pending',       for_sale_pending,
    'all_listings_total',     all_listings_total,
    'all_enriched',           all_enriched,
    'enriched_last_5min',     enriched_last_5min,
    'enriched_last_1h',       enriched_last_1h,
    'enriched_last_24h',      enriched_last_24h,
    'stale_enriched_gt_14d',  stale_enriched_gt_14d,
    'snapshot_at',            now()
  )
  FROM totals;
$$;

-- Also add pulse_get_listing_queue_position(listing_id) so the force-enrich
-- UI can say "this listing is #3,124 in the queue" before the user clicks.
CREATE OR REPLACE FUNCTION pulse_get_listing_queue_position(p_listing_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH target AS (
    SELECT id, first_seen_at, listing_type, detail_enriched_at
    FROM pulse_listings WHERE id = p_listing_id
  ),
  queue AS (
    SELECT count(*) AS ahead
    FROM pulse_listings l, target t
    WHERE l.listing_type = 'for_sale'
      AND l.detail_enriched_at IS NULL
      AND l.first_seen_at <= t.first_seen_at
      AND t.detail_enriched_at IS NULL
  ),
  throughput AS (
    SELECT count(*)::numeric / 60.0 AS per_min
    FROM pulse_listings
    WHERE detail_enriched_at > now() - interval '1 hour'
  )
  SELECT jsonb_build_object(
    'listing_id', (SELECT id FROM target),
    'enriched', (SELECT detail_enriched_at IS NOT NULL FROM target),
    'queue_ahead', (SELECT ahead FROM queue),
    'throughput_per_min', (SELECT per_min FROM throughput),
    'eta_minutes',
      CASE
        WHEN (SELECT per_min FROM throughput) > 0
        THEN ((SELECT ahead FROM queue) / (SELECT per_min FROM throughput))::int
        ELSE NULL
      END
  );
$$;

COMMIT;

-- 160_pulse_market_share_aggregations.sql
-- Batch compute + aggregation RPCs for the Market Share dashboard and
-- Client Retention page. Reads from pulse_listing_missed_opportunity
-- (populated by pulse_compute_listing_quote).
--
-- Contains:
--   pulse_compute_stale_quotes(p_batch_size int)   → batch worker (cron-driven)
--   pulse_get_market_share(p_from, p_to, p_suburb) → window rollup
--   pulse_get_missed_top_n(p_from, p_to, p_limit)  → top missed opportunities
--   pulse_get_agent_retention(p_agent_rea_id, p_from, p_to) → per-agent for Client Retention
--   pulse_get_quote_source_mix(p_from, p_to)       → Legend subtab — which
--                                                     cascade step fired how often
--
-- All aggregation RPCs:
--   • accept date range (first_seen_at window)
--   • filter to listing_type = 'for_sale' only
--   • exclude quote_status = 'pending_enrichment' from $ totals (but include in listing counts)

BEGIN;

-- ── 1. Batch compute worker ────────────────────────────────────────────────
-- Processes up to p_batch_size listings where:
--   • listing_type = 'for_sale' AND
--   • (no quote exists) OR (quote is stale — media/price changed)
-- Prioritizes: no-quote first, then oldest-stale first.
-- Returns run summary as jsonb.

CREATE OR REPLACE FUNCTION pulse_compute_stale_quotes(p_batch_size int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_start timestamptz := now();
  v_processed int := 0;
  v_errors int := 0;
  v_rec record;
  v_err text;
BEGIN
  -- Find candidates: for_sale listings with no quote OR with stale quote
  FOR v_rec IN
    SELECT l.id
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND (
        q.listing_id IS NULL
        OR q.quote_status = 'stale'
        OR q.photo_count_at_quote IS DISTINCT FROM pulse_listing_photo_count(l.media_items, l.images)
        OR q.has_floorplan_at_quote IS DISTINCT FROM pulse_listing_has_floorplan(l.media_items, l.floorplan_urls)
        OR q.has_video_at_quote IS DISTINCT FROM pulse_listing_has_video(l.has_video, l.video_url, l.media_items)
        OR q.price_text_at_quote IS DISTINCT FROM l.price_text
      )
    ORDER BY
      CASE WHEN q.listing_id IS NULL THEN 0 ELSE 1 END,   -- new first
      COALESCE(q.computed_at, '1970-01-01'::timestamptz) ASC -- oldest stale next
    LIMIT p_batch_size
  LOOP
    BEGIN
      PERFORM pulse_compute_listing_quote(v_rec.id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RAISE WARNING 'compute failed for listing %: %', v_rec.id, v_err;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'errors', v_errors,
    'elapsed_ms', extract(milliseconds FROM (now() - v_start))::int,
    'batch_size', p_batch_size,
    'completed_at', now()
  );
END;
$$;

-- ── 2. Market Share aggregation ────────────────────────────────────────────
-- Returns the headline metrics for the dashboard:
--   • total listings in window
--   • captured listings (matched to a delivered/scheduled project at same property_key)
--   • missed listings (not captured)
--   • capture rate (%)
--   • total market value (sum of asking prices, null-safe)
--   • captured market value
--   • missed opportunity $ (sum of quoted_price across missed listings)
--   • quote coverage stats (pending_enrichment/data_gap counts)

CREATE OR REPLACE FUNCTION pulse_get_market_share(
  p_from timestamptz,
  p_to timestamptz,
  p_suburb text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH in_window AS (
    SELECT q.*,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM pulse_listing_missed_opportunity q
    WHERE q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
      AND (p_suburb IS NULL OR q.suburb = p_suburb)
  ),
  totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE is_captured) AS captured_listings,
      count(*) FILTER (WHERE NOT is_captured) AS missed_listings,
      count(*) FILTER (WHERE quote_status = 'pending_enrichment') AS pending_enrichment,
      count(*) FILTER (WHERE quote_status = 'data_gap') AS data_gap,
      count(*) FILTER (WHERE quote_status = 'fresh') AS fresh,
      COALESCE(sum(asking_price_numeric), 0) AS total_market_value,
      COALESCE(sum(asking_price_numeric) FILTER (WHERE is_captured), 0) AS captured_market_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0) AS missed_opportunity_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured), 0) AS missed_opportunity_value_including_pending
    FROM in_window
  ),
  by_package AS (
    SELECT classified_package_name, count(*) AS n, COALESCE(sum(quoted_price), 0) AS value
    FROM in_window
    WHERE NOT is_captured
    GROUP BY classified_package_name
  ),
  by_tier AS (
    SELECT resolved_tier, count(*) AS n, COALESCE(sum(quoted_price), 0) AS value
    FROM in_window
    WHERE NOT is_captured
    GROUP BY resolved_tier
  )
  SELECT jsonb_build_object(
    'window_from', p_from,
    'window_to', p_to,
    'suburb_filter', p_suburb,
    'total_listings', (SELECT total_listings FROM totals),
    'captured_listings', (SELECT captured_listings FROM totals),
    'missed_listings', (SELECT missed_listings FROM totals),
    'capture_rate_pct', CASE WHEN (SELECT total_listings FROM totals) = 0 THEN 0 ELSE round(100.0 * (SELECT captured_listings FROM totals) / (SELECT total_listings FROM totals), 2) END,
    'total_market_value', (SELECT total_market_value FROM totals),
    'captured_market_value', (SELECT captured_market_value FROM totals),
    'missed_opportunity_value', (SELECT missed_opportunity_value FROM totals),
    'missed_opportunity_including_pending', (SELECT missed_opportunity_value_including_pending FROM totals),
    'quote_quality', jsonb_build_object(
      'fresh', (SELECT fresh FROM totals),
      'pending_enrichment', (SELECT pending_enrichment FROM totals),
      'data_gap', (SELECT data_gap FROM totals)
    ),
    'by_package', (SELECT jsonb_agg(jsonb_build_object('package', classified_package_name, 'listings', n, 'value', value)) FROM by_package),
    'by_tier', (SELECT jsonb_agg(jsonb_build_object('tier', resolved_tier, 'listings', n, 'value', value)) FROM by_tier)
  );
$$;

-- ── 3. Top N missed opportunities ──────────────────────────────────────────
-- Drill-through from the headline dashboard to see which specific listings
-- contributed the most missed $. Joins pulse_listings for display.

CREATE OR REPLACE FUNCTION pulse_get_missed_top_n(
  p_from timestamptz,
  p_to timestamptz,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  listing_id uuid,
  address text,
  suburb text,
  first_seen_at timestamptz,
  asking_price numeric,
  classified_package_name text,
  resolved_tier text,
  pricing_method text,
  quoted_price numeric,
  photo_count int,
  has_video boolean,
  agency_name text,
  agent_name text,
  agent_rea_id text,
  source_url text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    q.listing_id,
    l.address,
    q.suburb,
    q.first_seen_at,
    q.asking_price_numeric,
    q.classified_package_name,
    q.resolved_tier,
    q.pricing_method,
    q.quoted_price,
    q.photo_count,
    q.has_video,
    l.agency_name,
    l.agent_name,
    l.agent_rea_id,
    l.source_url
  FROM pulse_listing_missed_opportunity q
  JOIN pulse_listings l ON l.id = q.listing_id
  WHERE q.listing_type = 'for_sale'
    AND q.first_seen_at >= p_from
    AND q.first_seen_at < p_to
    AND q.quote_status IN ('fresh','data_gap')
    AND NOT EXISTS (
      SELECT 1 FROM projects pr
      WHERE pr.property_key = q.property_key
        AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
    )
  ORDER BY q.quoted_price DESC NULLS LAST, q.first_seen_at DESC
  LIMIT p_limit;
$$;

-- ── 4. Agent retention (Client Retention page) ─────────────────────────────
-- For a specific agent, show their active-listings-to-project mapping. Flags
-- listings that should become projects but haven't been booked yet.

CREATE OR REPLACE FUNCTION pulse_get_agent_retention(
  p_agent_rea_id text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agent_listings AS (
    SELECT q.*, l.agent_name, l.agent_rea_id, l.address, l.source_url, l.agency_name,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agent_rea_id = p_agent_rea_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  )
  SELECT jsonb_build_object(
    'agent_rea_id', p_agent_rea_id,
    'window_from', p_from,
    'window_to', p_to,
    'total_listings', (SELECT count(*) FROM agent_listings),
    'captured', (SELECT count(*) FROM agent_listings WHERE is_captured),
    'missed', (SELECT count(*) FROM agent_listings WHERE NOT is_captured),
    'retention_rate_pct', CASE WHEN (SELECT count(*) FROM agent_listings) = 0 THEN 0 ELSE round(100.0 * (SELECT count(*) FROM agent_listings WHERE is_captured) / (SELECT count(*) FROM agent_listings), 2) END,
    'missed_opportunity_value', COALESCE((SELECT sum(quoted_price) FROM agent_listings WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0),
    'missed_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'package', classified_package_name,
        'tier', resolved_tier,
        'quoted_price', quoted_price,
        'source_url', source_url,
        'quote_status', quote_status
      ) ORDER BY quoted_price DESC NULLS LAST)
      FROM agent_listings WHERE NOT is_captured
    ), '[]'::jsonb),
    'captured_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'package', classified_package_name
      ) ORDER BY first_seen_at DESC)
      FROM agent_listings WHERE is_captured
    ), '[]'::jsonb)
  );
$$;

-- ── 5. Quote source mix (Legend subtab) ────────────────────────────────────
-- Shows the distribution of cascade steps that fired across all quotes in
-- the window. Powers the "where the numbers come from" chart in the Legend.

CREATE OR REPLACE FUNCTION pulse_get_quote_source_mix(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH in_window AS (
    SELECT * FROM pulse_listing_missed_opportunity
    WHERE listing_type = 'for_sale'
      AND first_seen_at >= p_from
      AND first_seen_at < p_to
  ),
  tier_mix AS (
    SELECT tier_source, count(*) AS n FROM in_window GROUP BY tier_source
  ),
  pricing_mix AS (
    SELECT pricing_method, count(*) AS n FROM in_window GROUP BY pricing_method
  ),
  status_mix AS (
    SELECT quote_status, count(*) AS n FROM in_window GROUP BY quote_status
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM in_window),
    'tier_source', (SELECT jsonb_object_agg(tier_source, n) FROM tier_mix),
    'pricing_method', (SELECT jsonb_object_agg(pricing_method, n) FROM pricing_mix),
    'quote_status', (SELECT jsonb_object_agg(quote_status, n) FROM status_mix)
  );
$$;

-- ── 6. Mark-stale trigger on pulse_listings updates ────────────────────────
-- When a listing's media or price changes, mark its existing quote as stale
-- so the next compute_stale_quotes run picks it up.

CREATE OR REPLACE FUNCTION pulse_mark_quote_stale_on_listing_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.media_items IS DISTINCT FROM OLD.media_items
     OR NEW.floorplan_urls IS DISTINCT FROM OLD.floorplan_urls
     OR NEW.has_video IS DISTINCT FROM OLD.has_video
     OR NEW.video_url IS DISTINCT FROM OLD.video_url
     OR NEW.price_text IS DISTINCT FROM OLD.price_text
     OR NEW.asking_price IS DISTINCT FROM OLD.asking_price
     OR NEW.detail_enriched_at IS DISTINCT FROM OLD.detail_enriched_at
  THEN
    UPDATE pulse_listing_missed_opportunity
    SET quote_status = 'stale'
    WHERE listing_id = NEW.id
      AND quote_status <> 'stale';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pulse_listings_mark_stale ON pulse_listings;
CREATE TRIGGER pulse_listings_mark_stale
  AFTER UPDATE OF media_items, floorplan_urls, has_video, video_url, price_text, asking_price, detail_enriched_at
  ON pulse_listings
  FOR EACH ROW
  EXECUTE FUNCTION pulse_mark_quote_stale_on_listing_change();

COMMIT;

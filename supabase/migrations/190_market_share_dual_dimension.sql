-- 190_market_share_dual_dimension.sql
-- Extends pulse_get_market_share to mirror Retention's dual-dimension model:
--   current  = listing_type='for_sale', first_seen_at in window
--   sold     = listing_type='sold',     sold_date in window
--
-- Top-level back-compat fields (total_listings, captured_listings, etc)
-- continue to reflect the "current" dimension so no existing consumer breaks.
-- New `current` + `sold` sub-objects carry the per-dimension detail.
--
-- Also extends pulse_get_missed_top_n with an optional p_dimension arg
-- ('current' | 'sold') so the dashboard can drill into either side.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_get_market_share(
  p_from timestamptz,
  p_to   timestamptz,
  p_suburb text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  -- ── CURRENT dimension (for_sale, first_seen_at in window) ─────────────
  WITH cur_win AS (
    SELECT q.*,
      q.captured_by_active AS cap_active,
      q.captured_by_legacy AS cap_legacy,
      (q.captured_by_active OR q.captured_by_legacy) AS is_captured
    FROM pulse_listing_missed_opportunity q
    WHERE q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
      AND (p_suburb IS NULL OR q.suburb = p_suburb)
  ),
  cur_totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE is_captured) AS captured_listings,
      count(*) FILTER (WHERE cap_active)                    AS captured_active,
      count(*) FILTER (WHERE cap_legacy)                    AS captured_legacy,
      count(*) FILTER (WHERE cap_active AND cap_legacy)     AS captured_both,
      count(*) FILTER (WHERE cap_active AND NOT cap_legacy) AS active_only,
      count(*) FILTER (WHERE cap_legacy AND NOT cap_active) AS legacy_only,
      count(*) FILTER (WHERE NOT is_captured) AS missed_listings,
      count(*) FILTER (WHERE quote_status = 'pending_enrichment') AS pending_enrichment,
      count(*) FILTER (WHERE quote_status = 'data_gap')           AS data_gap,
      count(*) FILTER (WHERE quote_status = 'fresh')              AS fresh,
      COALESCE(sum(asking_price_numeric), 0) AS total_market_value,
      COALESCE(sum(asking_price_numeric) FILTER (WHERE is_captured), 0) AS captured_market_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0) AS missed_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured), 0) AS missed_value_including_pending
    FROM cur_win
  ),
  cur_by_package AS (
    SELECT classified_package_name AS label, count(*) AS n, COALESCE(sum(quoted_price), 0) AS value
    FROM cur_win WHERE NOT is_captured GROUP BY classified_package_name
  ),
  cur_by_tier AS (
    SELECT resolved_tier AS label, count(*) AS n, COALESCE(sum(quoted_price), 0) AS value
    FROM cur_win WHERE NOT is_captured GROUP BY resolved_tier
  ),

  -- ── SOLD dimension (listing_type='sold', sold_date in window) ─────────
  sold_win AS (
    SELECT
      l.id AS listing_id,
      l.property_key,
      l.suburb,
      l.agent_rea_id,
      l.agency_rea_id,
      l.sold_price,
      l.sold_date,
      -- Capture: property_key matches a qualifying project OR a legacy_project.
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp WHERE lp.property_key = l.property_key
      ) AS cap_legacy
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= p_from::date
      AND l.sold_date <  p_to::date
      AND (p_suburb IS NULL OR l.suburb = p_suburb)
  ),
  sold_totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE cap_active OR cap_legacy) AS captured_listings,
      count(*) FILTER (WHERE cap_active) AS captured_active,
      count(*) FILTER (WHERE cap_legacy) AS captured_legacy,
      count(*) FILTER (WHERE cap_active AND cap_legacy) AS captured_both,
      count(*) FILTER (WHERE cap_active AND NOT cap_legacy) AS active_only,
      count(*) FILTER (WHERE cap_legacy AND NOT cap_active) AS legacy_only,
      count(*) FILTER (WHERE NOT (cap_active OR cap_legacy)) AS missed_listings,
      COALESCE(sum(sold_price), 0) AS total_sold_value,
      COALESCE(sum(sold_price) FILTER (WHERE cap_active OR cap_legacy), 0) AS captured_sold_value,
      COALESCE(sum(sold_price) FILTER (WHERE NOT (cap_active OR cap_legacy)), 0) AS missed_sold_value
    FROM sold_win
  )

  SELECT jsonb_build_object(
    'window_from', p_from,
    'window_to', p_to,
    'suburb_filter', p_suburb,

    -- ── Back-compat top-level fields — mirror the "current" dimension ───
    'total_listings',                     (SELECT total_listings FROM cur_totals),
    'captured_listings',                  (SELECT captured_listings FROM cur_totals),
    'captured_listings_active',           (SELECT captured_active FROM cur_totals),
    'captured_listings_legacy',           (SELECT captured_legacy FROM cur_totals),
    'captured_listings_total',            (SELECT captured_listings FROM cur_totals),
    'captured_by_source_breakdown',       jsonb_build_object(
      'active', (SELECT active_only FROM cur_totals),
      'legacy', (SELECT legacy_only FROM cur_totals),
      'both',   (SELECT captured_both FROM cur_totals)
    ),
    'missed_listings',                    (SELECT missed_listings FROM cur_totals),
    'capture_rate_pct',                   CASE WHEN (SELECT total_listings FROM cur_totals) = 0 THEN 0
                                               ELSE round(100.0 * (SELECT captured_listings FROM cur_totals) / (SELECT total_listings FROM cur_totals), 2) END,
    'total_market_value',                 (SELECT total_market_value FROM cur_totals),
    'captured_market_value',              (SELECT captured_market_value FROM cur_totals),
    'missed_opportunity_value',           (SELECT missed_value FROM cur_totals),
    'missed_opportunity_including_pending', (SELECT missed_value_including_pending FROM cur_totals),
    'quote_quality', jsonb_build_object(
      'fresh',              (SELECT fresh FROM cur_totals),
      'pending_enrichment', (SELECT pending_enrichment FROM cur_totals),
      'data_gap',           (SELECT data_gap FROM cur_totals)
    ),
    'by_package', COALESCE((SELECT jsonb_agg(jsonb_build_object('package', label, 'listings', n, 'value', value)) FROM cur_by_package), '[]'::jsonb),
    'by_tier',    COALESCE((SELECT jsonb_agg(jsonb_build_object('tier', label, 'listings', n, 'value', value))    FROM cur_by_tier),    '[]'::jsonb),

    -- ── New: explicit "current" sub-object mirroring back-compat ────────
    'current', jsonb_build_object(
      'total_listings',           (SELECT total_listings FROM cur_totals),
      'captured_listings',        (SELECT captured_listings FROM cur_totals),
      'captured_active',          (SELECT captured_active FROM cur_totals),
      'captured_legacy',          (SELECT captured_legacy FROM cur_totals),
      'captured_both',            (SELECT captured_both FROM cur_totals),
      'missed_listings',          (SELECT missed_listings FROM cur_totals),
      'capture_rate_pct',         CASE WHEN (SELECT total_listings FROM cur_totals) = 0 THEN 0
                                       ELSE round(100.0 * (SELECT captured_listings FROM cur_totals) / (SELECT total_listings FROM cur_totals), 2) END,
      'total_market_value',       (SELECT total_market_value FROM cur_totals),
      'captured_market_value',    (SELECT captured_market_value FROM cur_totals),
      'missed_opportunity_value', (SELECT missed_value FROM cur_totals),
      'missed_value_including_pending', (SELECT missed_value_including_pending FROM cur_totals),
      'by_package', COALESCE((SELECT jsonb_agg(jsonb_build_object('package', label, 'listings', n, 'value', value)) FROM cur_by_package), '[]'::jsonb),
      'by_tier',    COALESCE((SELECT jsonb_agg(jsonb_build_object('tier', label, 'listings', n, 'value', value))    FROM cur_by_tier),    '[]'::jsonb)
    ),

    -- ── New: "sold" sub-object, parallel shape ─────────────────────────
    'sold', jsonb_build_object(
      'total_listings',        (SELECT total_listings FROM sold_totals),
      'captured_listings',     (SELECT captured_listings FROM sold_totals),
      'captured_active',       (SELECT captured_active FROM sold_totals),
      'captured_legacy',       (SELECT captured_legacy FROM sold_totals),
      'captured_both',         (SELECT captured_both FROM sold_totals),
      'captured_by_source_breakdown', jsonb_build_object(
        'active', (SELECT active_only FROM sold_totals),
        'legacy', (SELECT legacy_only FROM sold_totals),
        'both',   (SELECT captured_both FROM sold_totals)
      ),
      'missed_listings',       (SELECT missed_listings FROM sold_totals),
      'capture_rate_pct',      CASE WHEN (SELECT total_listings FROM sold_totals) = 0 THEN 0
                                    ELSE round(100.0 * (SELECT captured_listings FROM sold_totals) / (SELECT total_listings FROM sold_totals), 2) END,
      'total_sold_value',      (SELECT total_sold_value FROM sold_totals),
      'captured_sold_value',   (SELECT captured_sold_value FROM sold_totals),
      'missed_sold_value',     (SELECT missed_sold_value FROM sold_totals)
    )
  );
$$;

-- Extend pulse_get_missed_top_n with a dimension argument.
-- Default 'current' = existing behavior (for_sale, first_seen_at window).

DROP FUNCTION IF EXISTS pulse_get_missed_top_n(timestamptz, timestamptz, int);

CREATE OR REPLACE FUNCTION pulse_get_missed_top_n(
  p_from timestamptz,
  p_to timestamptz,
  p_limit int DEFAULT 50,
  p_dimension text DEFAULT 'current'
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
  agent_pulse_id uuid,
  agency_pulse_id uuid,
  source_url text,
  data_gap_flag boolean,
  detail_enriched_at timestamptz,
  quote_status text,
  sold_date date,
  sold_price numeric
)
LANGUAGE sql
STABLE
AS $$
  -- CURRENT dimension: use the substrate (has quotes + all fields)
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
    l.agent_pulse_id,
    l.agency_pulse_id,
    l.source_url,
    q.data_gap_flag,
    l.detail_enriched_at,
    q.quote_status,
    NULL::date AS sold_date,
    NULL::numeric AS sold_price
  FROM pulse_listing_missed_opportunity q
  JOIN pulse_listings l ON l.id = q.listing_id
  WHERE p_dimension = 'current'
    AND q.listing_type = 'for_sale'
    AND q.first_seen_at >= p_from
    AND q.first_seen_at < p_to
    AND q.quote_status IN ('fresh','data_gap')
    AND NOT q.captured_by_active AND NOT q.captured_by_legacy
  UNION ALL
  -- SOLD dimension: pulse_listings directly, no quote substrate for sold
  SELECT
    l.id AS listing_id,
    l.address,
    l.suburb,
    l.first_seen_at,
    l.asking_price AS asking_price,
    NULL::text AS classified_package_name,
    NULL::text AS resolved_tier,
    NULL::text AS pricing_method,
    NULL::numeric AS quoted_price,
    NULL::int AS photo_count,
    l.has_video,
    l.agency_name,
    l.agent_name,
    l.agent_rea_id,
    l.agent_pulse_id,
    l.agency_pulse_id,
    l.source_url,
    false AS data_gap_flag,
    l.detail_enriched_at,
    NULL::text AS quote_status,
    l.sold_date,
    l.sold_price
  FROM pulse_listings l
  WHERE p_dimension = 'sold'
    AND l.listing_type = 'sold'
    AND l.sold_date >= p_from::date
    AND l.sold_date <  p_to::date
    AND NOT EXISTS (SELECT 1 FROM projects pr WHERE pr.property_key = l.property_key AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
    AND NOT EXISTS (SELECT 1 FROM legacy_projects lp WHERE lp.property_key = l.property_key)
  ORDER BY 9 DESC NULLS LAST, 15 DESC NULLS LAST, 4 DESC
  LIMIT p_limit;
$$;

COMMIT;

-- 163_pulse_market_share_drill_ids.sql
-- Adds agent_pulse_id + agency_pulse_id to the Market Share / Retention
-- RPC result rows so the dashboard drill-throughs can push the correct
-- UUID onto IndustryPulse's openEntity stack (which requires { type, id }
-- where id is the pulse_agents.id / pulse_agencies.id UUID).
--
-- All 3 affected RPCs are re-created (CREATE OR REPLACE) with the added
-- columns appended to the end of the signature.

BEGIN;

-- ── pulse_get_missed_top_n — add agent_pulse_id, agency_pulse_id ───────────

DROP FUNCTION IF EXISTS pulse_get_missed_top_n(timestamptz, timestamptz, int);

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
  agent_pulse_id uuid,
  agency_pulse_id uuid,
  source_url text,
  data_gap_flag boolean
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
    l.agent_pulse_id,
    l.agency_pulse_id,
    l.source_url,
    q.data_gap_flag
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

-- ── pulse_get_top_agents_retention — add agent_pulse_id, agency_pulse_id ───

DROP FUNCTION IF EXISTS pulse_get_top_agents_retention(timestamptz, timestamptz, int, int);

CREATE OR REPLACE FUNCTION pulse_get_top_agents_retention(
  p_from timestamptz,
  p_to timestamptz,
  p_limit int DEFAULT 100,
  p_min_listings int DEFAULT 3
)
RETURNS TABLE (
  agent_rea_id text,
  agent_pulse_id uuid,
  agency_pulse_id uuid,
  agent_name text,
  agency_name text,
  total_listings bigint,
  captured bigint,
  missed bigint,
  retention_rate_pct numeric,
  missed_opportunity_value numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH agent_rollup AS (
    SELECT
      l.agent_rea_id,
      -- Take any sample of the UUIDs — agent_rea_id is the natural key; all
      -- rows for the same rea_id should resolve to the same pulse entity.
      max(l.agent_pulse_id::text)::uuid AS agent_pulse_id,
      max(l.agency_pulse_id::text)::uuid AS agency_pulse_id,
      l.agent_name,
      l.agency_name,
      count(*) AS total_listings,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM projects pr
          WHERE pr.property_key = q.property_key
            AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
        )
      ) AS captured,
      COALESCE(sum(q.quoted_price) FILTER (
        WHERE q.quote_status IN ('fresh','data_gap')
          AND NOT EXISTS (
            SELECT 1 FROM projects pr
            WHERE pr.property_key = q.property_key
              AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
          )
      ), 0) AS missed_opportunity_value
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE q.listing_type = 'for_sale'
      AND l.agent_rea_id IS NOT NULL
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
    GROUP BY l.agent_rea_id, l.agent_name, l.agency_name
    HAVING count(*) >= p_min_listings
  )
  SELECT
    agent_rea_id,
    agent_pulse_id,
    agency_pulse_id,
    agent_name,
    agency_name,
    total_listings,
    captured,
    (total_listings - captured) AS missed,
    CASE WHEN total_listings = 0 THEN 0
         ELSE round(100.0 * captured / total_listings, 2) END AS retention_rate_pct,
    missed_opportunity_value
  FROM agent_rollup
  ORDER BY missed_opportunity_value DESC, total_listings DESC
  LIMIT p_limit;
$$;

-- ── pulse_get_agent_retention — add agent_pulse_id/agency_pulse_id on each listing ──

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
    SELECT q.*,
      l.agent_name, l.agent_rea_id, l.agent_pulse_id, l.agency_pulse_id,
      l.address, l.source_url, l.agency_name,
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
    'agent_pulse_id', (SELECT max(agent_pulse_id::text)::uuid FROM agent_listings),
    'agency_pulse_id', (SELECT max(agency_pulse_id::text)::uuid FROM agent_listings),
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
        'quote_status', quote_status,
        'agent_pulse_id', agent_pulse_id,
        'agency_pulse_id', agency_pulse_id
      ) ORDER BY quoted_price DESC NULLS LAST)
      FROM agent_listings WHERE NOT is_captured
    ), '[]'::jsonb),
    'captured_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'package', classified_package_name,
        'agent_pulse_id', agent_pulse_id,
        'agency_pulse_id', agency_pulse_id
      ) ORDER BY first_seen_at DESC)
      FROM agent_listings WHERE is_captured
    ), '[]'::jsonb)
  );
$$;

COMMIT;

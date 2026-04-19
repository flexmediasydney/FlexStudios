-- 162_pulse_top_agents_retention.sql
-- Adds pulse_get_top_agents_retention — aggregates the Market Share substrate
-- by agent for the Retention tab (ordered by missed opportunity $ desc).
--
-- Used as the top-level drill feed for the Client Retention dashboard.
-- Per-agent detail then loads via pulse_get_agent_retention.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_get_top_agents_retention(
  p_from timestamptz,
  p_to timestamptz,
  p_limit int DEFAULT 100,
  p_min_listings int DEFAULT 3
)
RETURNS TABLE (
  agent_rea_id text,
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

COMMIT;

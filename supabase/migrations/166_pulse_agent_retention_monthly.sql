-- 166_pulse_agent_retention_monthly.sql
-- Adds pulse_get_agent_retention_monthly — 12-month-sparkline feed for the
-- per-agent Market Share card surfaced inside PersonDetails + AgentSlideout.
--
-- Returns one row per calendar month between [p_from, p_to), with captured /
-- missed counts and missed-$ for that agent. Used to render a 12-month capture
-- rate sparkline alongside the stat row.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_get_agent_retention_monthly(
  p_agent_rea_id text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  month timestamptz,
  total_listings bigint,
  captured bigint,
  missed bigint,
  missed_value numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', p_from),
      date_trunc('month', p_to) - interval '1 month',
      interval '1 month'
    ) AS month
  ),
  agent_listings AS (
    SELECT
      date_trunc('month', q.first_seen_at) AS month,
      q.quoted_price,
      q.quote_status,
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
  SELECT
    m.month,
    COALESCE(count(al.*), 0)::bigint AS total_listings,
    COALESCE(count(al.*) FILTER (WHERE al.is_captured), 0)::bigint AS captured,
    COALESCE(count(al.*) FILTER (WHERE NOT al.is_captured), 0)::bigint AS missed,
    COALESCE(sum(al.quoted_price) FILTER (
      WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
    ), 0)::numeric AS missed_value
  FROM months m
  LEFT JOIN agent_listings al ON al.month = m.month
  GROUP BY m.month
  ORDER BY m.month;
$$;

COMMENT ON FUNCTION pulse_get_agent_retention_monthly IS
  '12-month sparkline feed for the per-agent Market Share card. One row per month between [p_from, p_to) with captured/missed counts and missed-$.';

COMMIT;

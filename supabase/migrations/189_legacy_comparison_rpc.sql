-- 189_legacy_comparison_rpc.sql
--
-- RPC: pulse_get_legacy_market_share_comparison(p_from, p_to) RETURNS jsonb
--
-- Returns two full market-share snapshots of the same window side-by-side:
--   • active_only   — "captured" predicate matches projects table only
--                     (pre-legacy-import reality)
--   • active_plus_legacy — "captured" predicate matches projects OR
--                     legacy_projects.property_key (post-import reality)
--
-- Frontend: pages/LegacyMarketShareReport.jsx renders delta cards + a dual-line
-- monthly timeline of capture rate using the `timeline` array.
-- Top-N "only-captured-by-legacy" rollups per-agent / per-agency let the user
-- spot past relationships worth re-engaging.
--
-- Implementation notes:
--   • The function is STABLE, no side effects. Safe to call repeatedly.
--   • We compute both snapshots in one pass over pulse_listing_missed_opportunity
--     using two separate EXISTS checks against their respective tables.
--   • Agent / agency rollups join back to pulse_listings for the realtime
--     agent_name / agency_name (the substrate table itself does not carry
--     those columns — same pattern pulse_get_missed_top_n uses).

BEGIN;

CREATE OR REPLACE FUNCTION public.pulse_get_legacy_market_share_comparison(
  p_from timestamptz,
  p_to   timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
WITH in_window AS (
  SELECT
    q.listing_id,
    q.property_key,
    q.suburb,
    q.asking_price_numeric,
    q.quoted_price,
    q.quote_status,
    q.first_seen_at,
    EXISTS (
      SELECT 1 FROM projects pr
      WHERE pr.property_key = q.property_key
        AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
    ) AS captured_by_active,
    EXISTS (
      SELECT 1 FROM legacy_projects lp
      WHERE lp.property_key = q.property_key
    ) AS captured_by_legacy
  FROM pulse_listing_missed_opportunity q
  WHERE q.listing_type = 'for_sale'
    AND q.first_seen_at >= p_from
    AND q.first_seen_at < p_to
),
totals AS (
  SELECT
    count(*) AS total_listings,

    -- active-only view (projects)
    count(*) FILTER (WHERE captured_by_active) AS active_captured,
    count(*) FILTER (WHERE NOT captured_by_active) AS active_missed,
    COALESCE(sum(quoted_price) FILTER (WHERE NOT captured_by_active AND quote_status IN ('fresh','data_gap')), 0) AS active_missed_value,

    -- active + legacy view
    count(*) FILTER (WHERE captured_by_active OR captured_by_legacy) AS both_captured,
    count(*) FILTER (WHERE NOT (captured_by_active OR captured_by_legacy)) AS both_missed,
    COALESCE(sum(quoted_price) FILTER (WHERE NOT (captured_by_active OR captured_by_legacy) AND quote_status IN ('fresh','data_gap')), 0) AS both_missed_value,

    -- legacy-only carve-out (not captured by active, is captured by legacy)
    count(*) FILTER (WHERE NOT captured_by_active AND captured_by_legacy) AS legacy_only_captured,
    COALESCE(sum(quoted_price) FILTER (WHERE NOT captured_by_active AND captured_by_legacy), 0) AS legacy_only_value
  FROM in_window
),
monthly AS (
  SELECT
    date_trunc('month', first_seen_at) AS month,
    count(*) AS listings,
    count(*) FILTER (WHERE captured_by_active) AS active_captured,
    count(*) FILTER (WHERE captured_by_active OR captured_by_legacy) AS both_captured
  FROM in_window
  GROUP BY 1
  ORDER BY 1
),
legacy_only_agents AS (
  -- listings newly captured only via legacy (not active) → group by agent_rea_id
  SELECT
    pl.agent_rea_id,
    pl.agent_name,
    pl.agency_name,
    count(*) AS legacy_captures,
    COALESCE(sum(iw.quoted_price), 0) AS legacy_capture_value
  FROM in_window iw
  JOIN pulse_listings pl ON pl.id = iw.listing_id
  WHERE NOT iw.captured_by_active
    AND iw.captured_by_legacy
    AND pl.agent_rea_id IS NOT NULL
  GROUP BY pl.agent_rea_id, pl.agent_name, pl.agency_name
  ORDER BY legacy_captures DESC
  LIMIT 25
),
legacy_only_agencies AS (
  SELECT
    pl.agency_rea_id,
    pl.agency_name,
    count(*) AS legacy_captures,
    COALESCE(sum(iw.quoted_price), 0) AS legacy_capture_value
  FROM in_window iw
  JOIN pulse_listings pl ON pl.id = iw.listing_id
  WHERE NOT iw.captured_by_active
    AND iw.captured_by_legacy
    AND pl.agency_rea_id IS NOT NULL
  GROUP BY pl.agency_rea_id, pl.agency_name
  ORDER BY legacy_captures DESC
  LIMIT 25
)
SELECT jsonb_build_object(
  'window_from', p_from,
  'window_to',   p_to,

  'active_only', jsonb_build_object(
    'total_listings',          (SELECT total_listings   FROM totals),
    'captured_listings',       (SELECT active_captured  FROM totals),
    'missed_listings',         (SELECT active_missed    FROM totals),
    'capture_rate_pct', CASE WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * (SELECT active_captured FROM totals) / (SELECT total_listings FROM totals), 2) END,
    'missed_opportunity_value',(SELECT active_missed_value FROM totals)
  ),

  'active_plus_legacy', jsonb_build_object(
    'total_listings',          (SELECT total_listings FROM totals),
    'captured_listings',       (SELECT both_captured  FROM totals),
    'missed_listings',         (SELECT both_missed    FROM totals),
    'capture_rate_pct', CASE WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * (SELECT both_captured FROM totals) / (SELECT total_listings FROM totals), 2) END,
    'missed_opportunity_value',(SELECT both_missed_value FROM totals)
  ),

  'delta', jsonb_build_object(
    'captured_delta',          (SELECT both_captured - active_captured FROM totals),
    'missed_listings_delta',   (SELECT active_missed - both_missed     FROM totals),
    'missed_value_delta',      (SELECT active_missed_value - both_missed_value FROM totals),
    'capture_rate_delta_pct',  CASE WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * ((SELECT both_captured FROM totals) - (SELECT active_captured FROM totals)) / (SELECT total_listings FROM totals), 2) END,
    'legacy_only_captured',    (SELECT legacy_only_captured FROM totals),
    'legacy_only_value',       (SELECT legacy_only_value FROM totals)
  ),

  'timeline', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'month', to_char(month, 'YYYY-MM'),
      'listings', listings,
      'active_captured', active_captured,
      'both_captured',   both_captured,
      'active_rate_pct', CASE WHEN listings = 0 THEN 0 ELSE round(100.0 * active_captured / listings, 2) END,
      'both_rate_pct',   CASE WHEN listings = 0 THEN 0 ELSE round(100.0 * both_captured   / listings, 2) END
    ) ORDER BY month)
    FROM monthly
  ), '[]'::jsonb),

  'top_legacy_only_agents', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agent_rea_id',          agent_rea_id,
      'agent_name',            agent_name,
      'agency_name',           agency_name,
      'legacy_captures',       legacy_captures,
      'legacy_capture_value',  legacy_capture_value
    ) ORDER BY legacy_captures DESC)
    FROM legacy_only_agents
  ), '[]'::jsonb),

  'top_legacy_only_agencies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'agency_rea_id',         agency_rea_id,
      'agency_name',           agency_name,
      'legacy_captures',       legacy_captures,
      'legacy_capture_value',  legacy_capture_value
    ) ORDER BY legacy_captures DESC)
    FROM legacy_only_agencies
  ), '[]'::jsonb)
);
$function$;

GRANT EXECUTE ON FUNCTION public.pulse_get_legacy_market_share_comparison(timestamptz, timestamptz) TO anon, authenticated, service_role;

COMMIT;

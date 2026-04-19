-- Migration 175: pulse_get_header_stats_with_trends RPC
-- ======================================================
-- Why: the Industry Pulse top stat strip needs current + 7-day-prior counts
-- AND a 30-day sparkline per metric, in a single round-trip, so the strip
-- can render delta arrows + inline sparklines without a flood of client
-- aggregates. Replaces scattered ad-hoc counts + trend baselines previously
-- exposed piecemeal by pulse_get_dashboard_stats.
--
-- What: returns jsonb:
--   {
--     "current":  { agents, agencies, for_sale, for_rent, avg_dom,
--                   upcoming_events, new_signals, market_share_pct },
--     "prior_7d": { ...same keys... },
--     "sparklines": {
--        agents:   [ { d: date, v: int }, ... 30 entries ],
--        agencies: [...],
--        for_sale: [...],
--        for_rent: [...],
--        upcoming_events: [...],
--        new_signals: [...]
--     },
--     "generated_at": timestamp
--   }
--
-- Sparklines are cumulative-up-to-day counts (i.e. how many total rows existed
-- at end-of-day for that date), so each series trends naturally and renders
-- nicely as a monotonic area chart behind the KPI tile.

CREATE OR REPLACE FUNCTION pulse_get_header_stats_with_trends()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  days_series date[];
BEGIN
  -- Precompute the 30-day date series once
  SELECT array_agg(d::date ORDER BY d)
    INTO days_series
    FROM generate_series(
      (now() - interval '29 days')::date,
      now()::date,
      interval '1 day'
    ) AS g(d);

  WITH
    -- Current snapshots
    cur AS (
      SELECT
        (SELECT count(*) FROM pulse_agents)                                                     AS agents,
        (SELECT count(*) FROM pulse_agencies)                                                   AS agencies,
        (SELECT count(*) FROM pulse_listings WHERE listing_type = 'for_sale')                   AS for_sale,
        (SELECT count(*) FROM pulse_listings WHERE listing_type = 'for_rent')                   AS for_rent,
        (SELECT COALESCE(round(avg(days_on_market))::int, 0) FROM pulse_listings WHERE days_on_market > 0) AS avg_dom,
        (SELECT count(*) FROM pulse_events
          WHERE event_date > now() AND coalesce(status,'') <> 'skipped')                        AS upcoming_events,
        (SELECT count(*) FROM pulse_signals WHERE status = 'new')                               AS new_signals,
        (SELECT count(*) FROM pulse_listings WHERE listed_date > now() - interval '30 days')    AS recent_listings_30d,
        (SELECT count(*) FROM projects       WHERE created_at  > now() - interval '30 days')    AS recent_projects_30d
    ),
    -- 7-day-ago snapshots
    prior AS (
      SELECT
        (SELECT count(*) FROM pulse_agents    WHERE created_at < now() - interval '7 days')    AS agents,
        (SELECT count(*) FROM pulse_agencies  WHERE created_at < now() - interval '7 days')    AS agencies,
        (SELECT count(*) FROM pulse_listings
          WHERE listing_type = 'for_sale' AND created_at < now() - interval '7 days')           AS for_sale,
        (SELECT count(*) FROM pulse_listings
          WHERE listing_type = 'for_rent' AND created_at < now() - interval '7 days')           AS for_rent,
        (SELECT COALESCE(round(avg(days_on_market))::int, 0)
           FROM pulse_listings
          WHERE days_on_market > 0 AND created_at < now() - interval '7 days')                  AS avg_dom,
        (SELECT count(*) FROM pulse_events
          WHERE event_date > now() - interval '7 days'
            AND event_date <= now() + interval '14 days'
            AND coalesce(status,'') <> 'skipped')                                               AS upcoming_events,
        (SELECT count(*) FROM pulse_signals
          WHERE status = 'new' AND created_at < now() - interval '7 days')                      AS new_signals,
        (SELECT count(*) FROM pulse_listings
          WHERE listed_date BETWEEN now() - interval '37 days' AND now() - interval '7 days')   AS recent_listings_30d,
        (SELECT count(*) FROM projects
          WHERE created_at BETWEEN now() - interval '37 days' AND now() - interval '7 days')    AS recent_projects_30d
    )
  SELECT jsonb_build_object(
    'current', (
      SELECT jsonb_build_object(
        'agents',           c.agents,
        'agencies',         c.agencies,
        'for_sale',         c.for_sale,
        'for_rent',         c.for_rent,
        'avg_dom',          c.avg_dom,
        'upcoming_events',  c.upcoming_events,
        'new_signals',      c.new_signals,
        'market_share_pct', CASE WHEN c.recent_listings_30d > 0
                                 THEN round((c.recent_projects_30d::numeric / c.recent_listings_30d::numeric) * 100)
                                 ELSE 0 END,
        'recent_listings_30d', c.recent_listings_30d,
        'recent_projects_30d', c.recent_projects_30d
      ) FROM cur c
    ),
    'prior_7d', (
      SELECT jsonb_build_object(
        'agents',           p.agents,
        'agencies',         p.agencies,
        'for_sale',         p.for_sale,
        'for_rent',         p.for_rent,
        'avg_dom',          p.avg_dom,
        'upcoming_events',  p.upcoming_events,
        'new_signals',      p.new_signals,
        'market_share_pct', CASE WHEN p.recent_listings_30d > 0
                                 THEN round((p.recent_projects_30d::numeric / p.recent_listings_30d::numeric) * 100)
                                 ELSE 0 END
      ) FROM prior p
    ),
    -- Sparklines: cumulative row count at end of each day for the last 30 days
    'sparklines', jsonb_build_object(
      'agents', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) ORDER BY d), '[]'::jsonb)
        FROM (
          SELECT d, (SELECT count(*) FROM pulse_agents WHERE created_at <= d + interval '1 day')::int AS v
          FROM unnest(days_series) AS d
        ) s
      ),
      'agencies', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) ORDER BY d), '[]'::jsonb)
        FROM (
          SELECT d, (SELECT count(*) FROM pulse_agencies WHERE created_at <= d + interval '1 day')::int AS v
          FROM unnest(days_series) AS d
        ) s
      ),
      'for_sale', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) ORDER BY d), '[]'::jsonb)
        FROM (
          SELECT d,
            (SELECT count(*) FROM pulse_listings
              WHERE listing_type = 'for_sale' AND created_at <= d + interval '1 day')::int AS v
          FROM unnest(days_series) AS d
        ) s
      ),
      'for_rent', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) ORDER BY d), '[]'::jsonb)
        FROM (
          SELECT d,
            (SELECT count(*) FROM pulse_listings
              WHERE listing_type = 'for_rent' AND created_at <= d + interval '1 day')::int AS v
          FROM unnest(days_series) AS d
        ) s
      ),
      'upcoming_events', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) ORDER BY d), '[]'::jsonb)
        FROM (
          SELECT d,
            (SELECT count(*) FROM pulse_events
              WHERE event_date > d
                AND event_date <= d + interval '14 days'
                AND coalesce(status,'') <> 'skipped')::int AS v
          FROM unnest(days_series) AS d
        ) s
      ),
      'new_signals', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'v', v) ORDER BY d), '[]'::jsonb)
        FROM (
          SELECT d,
            (SELECT count(*) FROM pulse_signals
              WHERE created_at >= d AND created_at < d + interval '1 day')::int AS v
          FROM unnest(days_series) AS d
        ) s
      )
    ),
    'generated_at', to_jsonb(now())
  ) INTO result;

  RETURN result;
END
$$;

GRANT EXECUTE ON FUNCTION pulse_get_header_stats_with_trends() TO authenticated, anon, service_role;

COMMENT ON FUNCTION pulse_get_header_stats_with_trends() IS
  'Stat-strip payload for the Industry Pulse header: current + 7-day-prior metrics + 30-day sparkline series per KPI. See migration 175.';

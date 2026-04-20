-- 214_pulse_agency_derived_stats.sql
-- Populate pulse_agencies aggregates by deriving them from the linked
-- pulse_agents rows. Zero-cost alternative to the (currently blocked by
-- REA anti-bot) pulseAgencyEnrich scrape — see migration 210 + the
-- pulseAgencyEnrich edge function for the scrape path that will eventually
-- fill the scrape-only fields (franchise_brand, about_text, testimonials,
-- office_photo_urls, declared_suburbs_served).
--
-- What this fills (from agents):
--   team_size, agent_count      = count of linked agents
--   total_sold_12m              = sum(agent.total_sold_12m)
--   total_sold_volume_aud       = team total sales × agency median price
--                                  (robust to agents with NULL medians; the
--                                  sum-of-(sold × median) approach silently
--                                  undercounts when some agents don't have
--                                  medians, so we use the aggregate median
--                                  instead)
--   avg_sold_price              = weighted avg of agents' medians
--                                  (weight = agent.total_sold_12m, filter-
--                                  consistent on both num and denom)
--   median_sold_price           = median of agents' rea_median_sold_price
--   avg_days_on_market          = weighted avg of agents' DOM by sold count
--   median_days_on_market       = median of agents' avg_days_on_market
--   avg_agent_rating            = avg of agents' rea_rating, weighted by
--                                  rea_review_count
--   total_reviews               = sum(agent.rea_review_count)
--   suburbs_active              = top-N most-common suburbs across the
--                                  agency's agents (jsonb array of strings)
--
-- What this does NOT fill (scrape-only, waits for pulseAgencyEnrich):
--   awards, franchise_brand, about_text, agency_testimonials,
--   office_photo_urls, declared_suburbs_served, trading_name, abn.
--
-- Weighted-avg gotcha: if `sum(weight)` includes agents with NULL value for
-- the metric, and the numerator `sum(weight × value)` silently drops those
-- agents (NULL arithmetic), the average is biased low. Every weighted avg
-- here uses a matching FILTER on the denominator so the ratio is honest.

BEGIN;

CREATE OR REPLACE FUNCTION refresh_pulse_agency_derived_stats()
RETURNS TABLE (
  agencies_updated int,
  agencies_skipped_no_agents int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated int := 0;
  v_skipped int := 0;
BEGIN
  WITH per_agency AS (
    SELECT
      pa.linked_agency_pulse_id AS agency_id,
      count(*) AS team_size,
      coalesce(sum(pa.total_sold_12m), 0) AS total_sold_12m,
      CASE WHEN sum(pa.total_sold_12m) FILTER (WHERE pa.rea_median_sold_price IS NOT NULL AND pa.total_sold_12m > 0) > 0
           THEN (sum(pa.total_sold_12m * pa.rea_median_sold_price) FILTER (WHERE pa.rea_median_sold_price IS NOT NULL)::numeric
                 / sum(pa.total_sold_12m) FILTER (WHERE pa.rea_median_sold_price IS NOT NULL AND pa.total_sold_12m > 0))
           ELSE NULL END AS avg_sold_price,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY pa.rea_median_sold_price) FILTER (WHERE pa.rea_median_sold_price IS NOT NULL) AS median_sold_price,
      CASE WHEN sum(pa.total_sold_12m) FILTER (WHERE pa.avg_days_on_market IS NOT NULL AND pa.total_sold_12m > 0) > 0
           THEN (sum(pa.total_sold_12m * pa.avg_days_on_market) FILTER (WHERE pa.avg_days_on_market IS NOT NULL)::numeric
                 / sum(pa.total_sold_12m) FILTER (WHERE pa.avg_days_on_market IS NOT NULL AND pa.total_sold_12m > 0))::int
           ELSE NULL END AS avg_days_on_market,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY pa.avg_days_on_market) FILTER (WHERE pa.avg_days_on_market IS NOT NULL)::int AS median_days_on_market,
      CASE WHEN sum(pa.rea_review_count) FILTER (WHERE pa.rea_rating IS NOT NULL) > 0
           THEN (sum(pa.rea_rating * pa.rea_review_count) FILTER (WHERE pa.rea_rating IS NOT NULL)::numeric
                 / sum(pa.rea_review_count) FILTER (WHERE pa.rea_rating IS NOT NULL))
           ELSE NULL END AS avg_agent_rating,
      coalesce(sum(pa.rea_review_count), 0) AS total_reviews
    FROM pulse_agents pa
    WHERE pa.linked_agency_pulse_id IS NOT NULL
    GROUP BY pa.linked_agency_pulse_id
  ),
  suburb_top AS (
    SELECT s.agency_id, jsonb_agg(s.suburb ORDER BY s.cnt DESC) AS suburbs_active
    FROM (
      SELECT linked_agency_pulse_id AS agency_id, suburb, count(*) AS cnt FROM (
        SELECT
          pa.linked_agency_pulse_id,
          jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(pa.suburbs_active) = 'array' THEN pa.suburbs_active ELSE '[]'::jsonb END
          ) AS suburb
        FROM pulse_agents pa
        WHERE pa.linked_agency_pulse_id IS NOT NULL
          AND pa.suburbs_active IS NOT NULL
      ) x
      WHERE suburb IS NOT NULL AND suburb <> ''
      GROUP BY linked_agency_pulse_id, suburb
      ORDER BY linked_agency_pulse_id, count(*) DESC
    ) s
    GROUP BY s.agency_id
  )
  UPDATE pulse_agencies ag
  SET
    team_size             = pa.team_size,
    agent_count           = pa.team_size,
    total_sold_12m        = pa.total_sold_12m,
    total_sold_volume_aud = CASE WHEN pa.median_sold_price IS NULL OR pa.total_sold_12m = 0 THEN 0
                                 ELSE (pa.total_sold_12m * pa.median_sold_price)::bigint END,
    avg_sold_price        = pa.avg_sold_price,
    median_sold_price     = pa.median_sold_price,
    avg_days_on_market    = pa.avg_days_on_market,
    median_days_on_market = pa.median_days_on_market,
    avg_agent_rating      = pa.avg_agent_rating,
    total_reviews         = pa.total_reviews,
    suburbs_active        = coalesce(st.suburbs_active, ag.suburbs_active),
    updated_at            = now()
  FROM per_agency pa
  LEFT JOIN suburb_top st ON st.agency_id = pa.agency_id
  WHERE ag.id = pa.agency_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Zero out stats on agencies with zero linked agents so stale data from
  -- prior rosters (closed agency, agents all moved) doesn't linger.
  UPDATE pulse_agencies ag
  SET
    team_size = 0, agent_count = 0,
    total_sold_12m = 0, total_sold_volume_aud = 0,
    avg_sold_price = NULL, median_sold_price = NULL,
    avg_days_on_market = NULL, median_days_on_market = NULL,
    avg_agent_rating = NULL, total_reviews = 0,
    updated_at = now()
  WHERE NOT EXISTS (SELECT 1 FROM pulse_agents pa2 WHERE pa2.linked_agency_pulse_id = ag.id)
    AND (ag.team_size > 0 OR ag.total_sold_12m > 0 OR ag.total_reviews > 0);

  GET DIAGNOSTICS v_skipped = ROW_COUNT;
  RETURN QUERY SELECT v_updated, v_skipped;
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_pulse_agency_derived_stats() TO service_role, authenticated;

COMMENT ON FUNCTION refresh_pulse_agency_derived_stats IS
  'Aggregates stats from pulse_agents onto pulse_agencies. Idempotent; safe to run any time. Called from pulseDataSync after agent upsert. See migration 214.';

COMMIT;

-- 102_pulse_agency_rea_id_backfill.sql
-- Fixes pulse_agencies rows with rea_agency_id = NULL even though the
-- canonical ID is present on every related pulse_agents.agency_rea_id and
-- pulse_listings.agency_rea_id.
--
-- Observed via Belle Property Strathfield:
--   pulse_agencies.rea_agency_id   = NULL       ← broken
--   pulse_agents.agency_rea_id     = "CQKNYM"   (9+ rows)
--   pulse_listings.agency_rea_id   = "CQKNYM"   (39+ rows)
--   → Aggregation reconciler (migration 101) can't match rows with NULL IDs,
--     so agent_count stays 0, active_listings stays stale, and default
--     sort pushes the agency to the bottom of the Agencies tab.
--
-- Root cause: pulseDataSync's agency_merge step populated rea_agency_ids ONLY
-- from agent data, never from listing data — even though listings carry
-- agency_rea_id in their agencyProfileUrl. Fixed in pulseDataSync (ships same
-- commit as this migration). This migration backfills the historical damage
-- + extends the reconciler with a name-fallback path so future NULL
-- rea_agency_id rows still get aggregates.

BEGIN;

-- ── (1) Backfill rea_agency_id from agents + listings ───────────────────
-- Strategy: for each agency with NULL rea_agency_id, find the most common
-- non-null rea_agency_id seen across pulse_agents + pulse_listings with the
-- same normalized name. Majority vote ensures a typo'd single row doesn't
-- trump the canonical value.
WITH agent_votes AS (
  SELECT lower(trim(agency_name)) AS name_key, agency_rea_id, count(*)::int AS votes
  FROM pulse_agents
  WHERE agency_name IS NOT NULL AND agency_rea_id IS NOT NULL
  GROUP BY lower(trim(agency_name)), agency_rea_id
),
listing_votes AS (
  SELECT lower(trim(agency_name)) AS name_key, agency_rea_id, count(*)::int AS votes
  FROM pulse_listings
  WHERE agency_name IS NOT NULL AND agency_rea_id IS NOT NULL
  GROUP BY lower(trim(agency_name)), agency_rea_id
),
combined AS (
  SELECT name_key, agency_rea_id, sum(votes)::int AS votes
  FROM (SELECT * FROM agent_votes UNION ALL SELECT * FROM listing_votes) u
  GROUP BY name_key, agency_rea_id
),
winner AS (
  SELECT DISTINCT ON (name_key) name_key, agency_rea_id, votes
  FROM combined
  ORDER BY name_key, votes DESC
)
UPDATE pulse_agencies g
   SET rea_agency_id = w.agency_rea_id
  FROM winner w
 WHERE lower(trim(g.name)) = w.name_key
   AND g.rea_agency_id IS NULL;

-- ── (2) Reconciler v2 with NULL-rea_agency_id fallback ──────────────────
-- Extends pulse_reconcile_aggregates() to also handle agencies with
-- rea_agency_id = NULL by joining listings on lower(trim(agency_name))
-- instead. Belt-and-braces for the Belle-Property-Strathfield class of
-- bug surviving future migrations.
CREATE OR REPLACE FUNCTION pulse_reconcile_aggregates()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  agents_updated       INT;
  agencies_updated     INT;
  agencies_name_path   INT;
BEGIN
  -- ── Agents: total_listings_active + total_sold_12m (unchanged) ─────
  WITH agent_truth AS (
    SELECT
      agent_rea_id,
      count(*) FILTER (WHERE listing_type IN ('for_sale', 'under_contract'))::int AS active,
      count(*) FILTER (
        WHERE listing_type = 'sold'
          AND (sold_date IS NULL OR sold_date > (CURRENT_DATE - INTERVAL '12 months'))
      )::int AS sold_12m
    FROM pulse_listings
    WHERE agent_rea_id IS NOT NULL
    GROUP BY agent_rea_id
  ),
  updated_agents AS (
    UPDATE pulse_agents a
       SET total_listings_active = COALESCE(t.active, 0),
           total_sold_12m        = COALESCE(t.sold_12m, a.total_sold_12m)
      FROM agent_truth t
     WHERE a.rea_agent_id = t.agent_rea_id
       AND (
         COALESCE(a.total_listings_active, -1) != COALESCE(t.active, 0)
         OR COALESCE(a.total_sold_12m, -1)        != COALESCE(t.sold_12m, a.total_sold_12m)
       )
    RETURNING 1
  )
  SELECT count(*) INTO agents_updated FROM updated_agents;

  -- ── Agencies: PRIMARY path (JOIN on rea_agency_id) ─────────────────
  WITH agency_truth AS (
    SELECT
      agency_rea_id,
      count(*) FILTER (WHERE listing_type IN ('for_sale', 'under_contract'))::int AS active,
      count(*) FILTER (
        WHERE listing_type = 'sold'
          AND (sold_date IS NULL OR sold_date > (CURRENT_DATE - INTERVAL '12 months'))
      )::int AS sold_12m,
      avg(asking_price) FILTER (WHERE listing_type IN ('for_sale', 'under_contract') AND asking_price IS NOT NULL)::numeric AS avg_asking,
      avg(sold_price)   FILTER (WHERE listing_type = 'sold' AND sold_price IS NOT NULL)::numeric AS avg_sold
    FROM pulse_listings
    WHERE agency_rea_id IS NOT NULL
    GROUP BY agency_rea_id
  ),
  updated_agencies AS (
    UPDATE pulse_agencies g
       SET active_listings   = COALESCE(t.active, 0),
           total_sold_12m    = COALESCE(t.sold_12m, g.total_sold_12m),
           avg_listing_price = COALESCE(t.avg_asking::int, g.avg_listing_price),
           avg_sold_price    = COALESCE(t.avg_sold::int, g.avg_sold_price)
      FROM agency_truth t
     WHERE g.rea_agency_id = t.agency_rea_id
       AND (
         COALESCE(g.active_listings, -1) != COALESCE(t.active, 0)
         OR COALESCE(g.total_sold_12m, -1)    != COALESCE(t.sold_12m, g.total_sold_12m)
       )
    RETURNING 1
  )
  SELECT count(*) INTO agencies_updated FROM updated_agencies;

  -- ── Agencies: FALLBACK path (NAME match for NULL rea_agency_id) ────
  -- Agencies with rea_agency_id NULL can't match the primary JOIN. Fall
  -- back to normalized-name match against listings' agency_name.
  WITH agency_truth_by_name AS (
    SELECT
      lower(trim(agency_name)) AS name_key,
      count(*) FILTER (WHERE listing_type IN ('for_sale', 'under_contract'))::int AS active,
      count(*) FILTER (
        WHERE listing_type = 'sold'
          AND (sold_date IS NULL OR sold_date > (CURRENT_DATE - INTERVAL '12 months'))
      )::int AS sold_12m,
      avg(asking_price) FILTER (WHERE listing_type IN ('for_sale', 'under_contract') AND asking_price IS NOT NULL)::numeric AS avg_asking,
      avg(sold_price)   FILTER (WHERE listing_type = 'sold' AND sold_price IS NOT NULL)::numeric AS avg_sold
    FROM pulse_listings
    WHERE agency_name IS NOT NULL
    GROUP BY lower(trim(agency_name))
  ),
  agent_count_by_name AS (
    SELECT lower(trim(agency_name)) AS name_key, count(*)::int AS cnt
    FROM pulse_agents
    WHERE agency_name IS NOT NULL
    GROUP BY lower(trim(agency_name))
  ),
  updated_fallback AS (
    UPDATE pulse_agencies g
       SET active_listings   = COALESCE(t.active, 0),
           total_sold_12m    = COALESCE(t.sold_12m, g.total_sold_12m),
           avg_listing_price = COALESCE(t.avg_asking::int, g.avg_listing_price),
           avg_sold_price    = COALESCE(t.avg_sold::int, g.avg_sold_price),
           agent_count       = COALESCE(ac.cnt, 0)
      FROM agency_truth_by_name t
      LEFT JOIN agent_count_by_name ac ON ac.name_key = t.name_key
     WHERE lower(trim(g.name)) = t.name_key
       AND g.rea_agency_id IS NULL
       AND (
         COALESCE(g.active_listings, -1) != COALESCE(t.active, 0)
         OR COALESCE(g.total_sold_12m, -1) != COALESCE(t.sold_12m, g.total_sold_12m)
         OR COALESCE(g.agent_count, -1) != COALESCE(ac.cnt, 0)
       )
    RETURNING 1
  )
  SELECT count(*) INTO agencies_name_path FROM updated_fallback;

  -- ── Also refresh agent_count on ALL agencies (not just NULL-id fallback) ──
  -- Reason: primary path above doesn't touch agent_count — and agent_count drifts
  -- when agents switch agencies. Compute from canonical JOIN against pulse_agents.
  WITH agent_truth_all AS (
    SELECT agency_rea_id, count(*)::int AS cnt
    FROM pulse_agents
    WHERE agency_rea_id IS NOT NULL
    GROUP BY agency_rea_id
  )
  UPDATE pulse_agencies g
     SET agent_count = COALESCE(t.cnt, 0)
    FROM agent_truth_all t
   WHERE g.rea_agency_id = t.agency_rea_id
     AND COALESCE(g.agent_count, -1) != COALESCE(t.cnt, 0);

  RETURN jsonb_build_object(
    'agents_updated',         agents_updated,
    'agencies_updated',       agencies_updated,
    'agencies_name_fallback', agencies_name_path,
    'ran_at',                 NOW()
  );
END;
$func$;

-- ── Run the new reconciler immediately to correct all existing drift ─────
SELECT pulse_reconcile_aggregates();

COMMIT;

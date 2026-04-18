-- 101_pulse_aggregate_reconciler.sql
-- Fix: pulse_agents.total_listings_active / total_sold_12m and
-- pulse_agencies.active_listings / total_sold_12m drift over time.
-- These counters are materialized at sync time but never recomputed when
-- the underlying pulse_listings table changes (new listings arrive,
-- sold/for_sale status flips, agents switch agencies).
--
-- Observed drift: ~60% of agents have stale total_listings_active; ~81%
-- have stale total_sold_12m; 100% of agencies have stale active_listings.
-- See the data-integrity audit for full numbers.
--
-- ── Fix ────────────────────────────────────────────────────────────────
-- A SECURITY DEFINER function that recomputes all four counters from the
-- JOIN truth, plus a nightly pg_cron job that runs it. One-shot backfill
-- happens as part of the migration.
--
-- Design choice: recompute ALL rows nightly, not just "changed" ones.
-- Reason: 847 agents × 6,542 listings is a cheap JOIN (< 1s). Smart delta
-- would add complexity without real savings at our scale.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_reconcile_aggregates()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  agents_updated  INT;
  agencies_updated INT;
BEGIN
  -- ── Agents: total_listings_active + total_sold_12m ──────────────────
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

  -- ── Agencies: active_listings + total_sold_12m ──────────────────────
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
       SET active_listings = COALESCE(t.active, 0),
           total_sold_12m  = COALESCE(t.sold_12m, g.total_sold_12m),
           avg_listing_price = COALESCE(t.avg_asking::int, g.avg_listing_price),
           avg_sold_price   = COALESCE(t.avg_sold::int, g.avg_sold_price)
      FROM agency_truth t
     WHERE g.rea_agency_id = t.agency_rea_id
       AND (
         COALESCE(g.active_listings, -1) != COALESCE(t.active, 0)
         OR COALESCE(g.total_sold_12m, -1)    != COALESCE(t.sold_12m, g.total_sold_12m)
       )
    RETURNING 1
  )
  SELECT count(*) INTO agencies_updated FROM updated_agencies;

  RETURN jsonb_build_object(
    'agents_updated',   agents_updated,
    'agencies_updated', agencies_updated,
    'ran_at',           NOW()
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION pulse_reconcile_aggregates TO authenticated, service_role;

COMMENT ON FUNCTION pulse_reconcile_aggregates IS
  'Recomputes pulse_agents.total_listings_active / total_sold_12m and '
  'pulse_agencies.active_listings / total_sold_12m / avg_*_price from the '
  'JOIN truth against pulse_listings. Nightly via pg_cron job '
  'pulse-aggregate-reconciler. Also callable on-demand for backfills.';

-- ── Schedule nightly (3:35am UTC = 1:35pm AEST — off-peak) ─────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-aggregate-reconciler') THEN
    PERFORM cron.unschedule('pulse-aggregate-reconciler');
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-aggregate-reconciler',
  '35 3 * * *',
  $cron$SELECT pulse_reconcile_aggregates()$cron$
);

-- ── One-time backfill now ──────────────────────────────────────────────
-- Runs in the same transaction as the migration.
SELECT pulse_reconcile_aggregates();

COMMIT;

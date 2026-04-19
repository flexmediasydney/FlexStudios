-- Migration 155: Rebuild stale Pulse aggregate caches + self-healing RPC + cron
--
-- Q2 audit found 4 aggregate columns drifting from ground truth:
--   pulse_agents.total_listings_active   (84.9% stale, max drift 120)
--   pulse_agents.total_sold_12m          (15.8% stale, max drift 109)
--   pulse_agencies.active_listings       (76.7% stale, max drift 182)
--   pulse_agencies.agent_count           (84.9% stale, max drift 77)
--
-- This migration:
--   1. One-shot rebuild using the same math the app relies on.
--   2. Creates pulse_rebuild_aggregate_caches() RPC so the same math can
--      be re-applied any time (e.g. after bulk syncs) — service_role only.
--   3. Schedules nightly cron at 03:15 UTC (13:15 AEST — low traffic,
--      does not overlap pulse-reconcile-orphans @ 03:00 or
--      pulse-aggregate-reconciler @ 03:35).

BEGIN;

-- 1. One-shot rebuild ---------------------------------------------------------

-- pulse_agents.total_listings_active
UPDATE pulse_agents pa
SET total_listings_active = COALESCE(agg.ct, 0)
FROM (
  SELECT agent_rea_id, count(*) AS ct
  FROM pulse_listings
  WHERE listing_type IN ('for_sale','for_rent','under_contract')
  GROUP BY agent_rea_id
) agg
WHERE agg.agent_rea_id = pa.rea_agent_id;

-- Zero-out agents whose cache says >0 but no matching listings exist
UPDATE pulse_agents
SET total_listings_active = 0
WHERE rea_agent_id IS NOT NULL
  AND total_listings_active > 0
  AND NOT EXISTS (
    SELECT 1
    FROM pulse_listings
    WHERE agent_rea_id = pulse_agents.rea_agent_id
      AND listing_type IN ('for_sale','for_rent','under_contract')
  );

-- pulse_agents.total_sold_12m
UPDATE pulse_agents pa
SET total_sold_12m = COALESCE(agg.ct, 0)
FROM (
  SELECT agent_rea_id, count(*) AS ct
  FROM pulse_listings
  WHERE listing_type = 'sold'
    AND COALESCE(sold_date, last_synced_at) > now() - interval '12 months'
  GROUP BY agent_rea_id
) agg
WHERE agg.agent_rea_id = pa.rea_agent_id;

UPDATE pulse_agents
SET total_sold_12m = 0
WHERE rea_agent_id IS NOT NULL
  AND total_sold_12m > 0
  AND NOT EXISTS (
    SELECT 1
    FROM pulse_listings
    WHERE agent_rea_id = pulse_agents.rea_agent_id
      AND listing_type = 'sold'
      AND COALESCE(sold_date, last_synced_at) > now() - interval '12 months'
  );

-- pulse_agencies.active_listings
UPDATE pulse_agencies ag
SET active_listings = COALESCE(agg.ct, 0)
FROM (
  SELECT agency_rea_id, count(*) AS ct
  FROM pulse_listings
  WHERE listing_type IN ('for_sale','for_rent','under_contract')
  GROUP BY agency_rea_id
) agg
WHERE agg.agency_rea_id = ag.rea_agency_id;

UPDATE pulse_agencies
SET active_listings = 0
WHERE rea_agency_id IS NOT NULL
  AND active_listings > 0
  AND NOT EXISTS (
    SELECT 1
    FROM pulse_listings
    WHERE agency_rea_id = pulse_agencies.rea_agency_id
      AND listing_type IN ('for_sale','for_rent','under_contract')
  );

-- pulse_agencies.agent_count
UPDATE pulse_agencies ag
SET agent_count = COALESCE(agg.ct, 0)
FROM (
  SELECT agency_rea_id, count(*) AS ct
  FROM pulse_agents
  WHERE agency_rea_id IS NOT NULL
  GROUP BY agency_rea_id
) agg
WHERE agg.agency_rea_id = ag.rea_agency_id;

UPDATE pulse_agencies
SET agent_count = 0
WHERE rea_agency_id IS NOT NULL
  AND agent_count > 0
  AND NOT EXISTS (
    SELECT 1
    FROM pulse_agents
    WHERE agency_rea_id = pulse_agencies.rea_agency_id
  );

-- 2. Self-healing RPC ---------------------------------------------------------

CREATE OR REPLACE FUNCTION pulse_rebuild_aggregate_caches()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r1 int := 0;
  r1z int := 0;
  r2 int := 0;
  r2z int := 0;
  r3 int := 0;
  r3z int := 0;
  r4 int := 0;
  r4z int := 0;
BEGIN
  -- pulse_agents.total_listings_active
  WITH agg AS (
    SELECT agent_rea_id, count(*) AS ct
    FROM pulse_listings
    WHERE listing_type IN ('for_sale','for_rent','under_contract')
    GROUP BY agent_rea_id
  ), upd AS (
    UPDATE pulse_agents pa
    SET total_listings_active = COALESCE(agg.ct, 0)
    FROM agg
    WHERE agg.agent_rea_id = pa.rea_agent_id
      AND pa.total_listings_active IS DISTINCT FROM COALESCE(agg.ct, 0)
    RETURNING 1
  )
  SELECT count(*) INTO r1 FROM upd;

  WITH upd AS (
    UPDATE pulse_agents
    SET total_listings_active = 0
    WHERE rea_agent_id IS NOT NULL
      AND total_listings_active > 0
      AND NOT EXISTS (
        SELECT 1
        FROM pulse_listings
        WHERE agent_rea_id = pulse_agents.rea_agent_id
          AND listing_type IN ('for_sale','for_rent','under_contract')
      )
    RETURNING 1
  )
  SELECT count(*) INTO r1z FROM upd;

  -- pulse_agents.total_sold_12m
  WITH agg AS (
    SELECT agent_rea_id, count(*) AS ct
    FROM pulse_listings
    WHERE listing_type = 'sold'
      AND COALESCE(sold_date, last_synced_at) > now() - interval '12 months'
    GROUP BY agent_rea_id
  ), upd AS (
    UPDATE pulse_agents pa
    SET total_sold_12m = COALESCE(agg.ct, 0)
    FROM agg
    WHERE agg.agent_rea_id = pa.rea_agent_id
      AND pa.total_sold_12m IS DISTINCT FROM COALESCE(agg.ct, 0)
    RETURNING 1
  )
  SELECT count(*) INTO r2 FROM upd;

  WITH upd AS (
    UPDATE pulse_agents
    SET total_sold_12m = 0
    WHERE rea_agent_id IS NOT NULL
      AND total_sold_12m > 0
      AND NOT EXISTS (
        SELECT 1
        FROM pulse_listings
        WHERE agent_rea_id = pulse_agents.rea_agent_id
          AND listing_type = 'sold'
          AND COALESCE(sold_date, last_synced_at) > now() - interval '12 months'
      )
    RETURNING 1
  )
  SELECT count(*) INTO r2z FROM upd;

  -- pulse_agencies.active_listings
  WITH agg AS (
    SELECT agency_rea_id, count(*) AS ct
    FROM pulse_listings
    WHERE listing_type IN ('for_sale','for_rent','under_contract')
    GROUP BY agency_rea_id
  ), upd AS (
    UPDATE pulse_agencies ag
    SET active_listings = COALESCE(agg.ct, 0)
    FROM agg
    WHERE agg.agency_rea_id = ag.rea_agency_id
      AND ag.active_listings IS DISTINCT FROM COALESCE(agg.ct, 0)
    RETURNING 1
  )
  SELECT count(*) INTO r3 FROM upd;

  WITH upd AS (
    UPDATE pulse_agencies
    SET active_listings = 0
    WHERE rea_agency_id IS NOT NULL
      AND active_listings > 0
      AND NOT EXISTS (
        SELECT 1
        FROM pulse_listings
        WHERE agency_rea_id = pulse_agencies.rea_agency_id
          AND listing_type IN ('for_sale','for_rent','under_contract')
      )
    RETURNING 1
  )
  SELECT count(*) INTO r3z FROM upd;

  -- pulse_agencies.agent_count
  WITH agg AS (
    SELECT agency_rea_id, count(*) AS ct
    FROM pulse_agents
    WHERE agency_rea_id IS NOT NULL
    GROUP BY agency_rea_id
  ), upd AS (
    UPDATE pulse_agencies ag
    SET agent_count = COALESCE(agg.ct, 0)
    FROM agg
    WHERE agg.agency_rea_id = ag.rea_agency_id
      AND ag.agent_count IS DISTINCT FROM COALESCE(agg.ct, 0)
    RETURNING 1
  )
  SELECT count(*) INTO r4 FROM upd;

  WITH upd AS (
    UPDATE pulse_agencies
    SET agent_count = 0
    WHERE rea_agency_id IS NOT NULL
      AND agent_count > 0
      AND NOT EXISTS (
        SELECT 1
        FROM pulse_agents
        WHERE agency_rea_id = pulse_agencies.rea_agency_id
      )
    RETURNING 1
  )
  SELECT count(*) INTO r4z FROM upd;

  RETURN jsonb_build_object(
    'total_listings_active_updated', r1 + r1z,
    'total_sold_12m_updated',         r2 + r2z,
    'active_listings_updated',        r3 + r3z,
    'agent_count_updated',            r4 + r4z,
    'detail', jsonb_build_object(
      'total_listings_active', jsonb_build_object('matched', r1, 'zeroed', r1z),
      'total_sold_12m',        jsonb_build_object('matched', r2, 'zeroed', r2z),
      'active_listings',       jsonb_build_object('matched', r3, 'zeroed', r3z),
      'agent_count',           jsonb_build_object('matched', r4, 'zeroed', r4z)
    ),
    'ran_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_rebuild_aggregate_caches() TO service_role;

-- 3. Nightly cron -------------------------------------------------------------
-- 03:15 UTC — does not overlap pulse-reconcile-orphans (03:00) or
-- pulse-aggregate-reconciler (03:35).
-- Unschedule any prior copy first so this migration is idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('pulse-aggregate-cache-rebuild')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'pulse-aggregate-cache-rebuild'
  );
EXCEPTION WHEN OTHERS THEN
  -- cron.unschedule raises if no job exists in some versions; ignore.
  NULL;
END $$;

SELECT cron.schedule(
  'pulse-aggregate-cache-rebuild',
  '15 3 * * *',
  $cron$SELECT public.pulse_rebuild_aggregate_caches();$cron$
);

COMMIT;

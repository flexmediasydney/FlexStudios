-- 083: pulse_source_card_stats() — RPC for IndustryPulse Source Card "coverage" line
--
-- The Source Card on the Data Sources tab needs to show "X suburbs covered out
-- of Y eligible" — i.e. how many suburbs the LAST CRON DISPATCH actually fired
-- a sync for, vs how many were eligible at that moment. This is fundamentally
-- different from the per-suburb fetch counts already shown (records_fetched /
-- records_new), which describe what one suburb returned.
--
-- The data lives in pulse_timeline rows where event_type='cron_dispatched'.
-- Each row's new_value JSON has shape:
--   {
--     source_id:   text                       -- which source_config dispatched
--     dispatched:  int                        -- count of suburbs fired (per-suburb)
--                                              -- OR 1 for bounding_box sources
--     suburbs:     text[]                     -- names of dispatched suburbs (per-suburb)
--     min_priority: int                       -- priority filter at dispatch time
--     max_items:   int                        -- per-suburb cap
--   }
-- Older rows (pre-070) may have null new_value — those are skipped here.
--
-- We also expose suburb_pool_size (current count of is_active=true suburbs WITH
-- postcode — the actual eligibility predicate from pulseFireScrapes/index.ts).
-- "eligible_at_run" is the same value as suburb_pool_size today; we don't have
-- a historical snapshot of pool size, so this is a present-day approximation.
-- This is acceptable because the suburb pool changes rarely.
--
-- Returns one row per source_id present in pulse_source_configs. If a source
-- has no cron_dispatched events, last_cron_at is NULL.

CREATE OR REPLACE FUNCTION pulse_source_card_stats()
RETURNS TABLE (
  source_id          text,
  last_cron_at       timestamptz,
  dispatched         int,
  suburb_pool_size   int,
  eligible_at_run    int,
  status             text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pool AS (
    SELECT count(*)::int AS sz
    FROM pulse_target_suburbs
    WHERE is_active = true
      AND postcode IS NOT NULL
  ),
  -- Pick the latest cron_dispatched per source_id. We use new_value->>'source_id'
  -- as the join key because that's where pulseFireScrapes writes it. Old rows
  -- with NULL new_value are excluded by the WHERE clause.
  ranked AS (
    SELECT
      (t.new_value->>'source_id')::text                            AS sid,
      t.created_at                                                  AS at,
      NULLIF(t.new_value->>'dispatched','')::int                    AS disp,
      ROW_NUMBER() OVER (
        PARTITION BY t.new_value->>'source_id'
        ORDER BY t.created_at DESC
      ) AS rn
    FROM pulse_timeline t
    WHERE t.event_type = 'cron_dispatched'
      AND t.new_value ? 'source_id'
      AND t.new_value->>'source_id' IS NOT NULL
  ),
  latest AS (
    SELECT sid, at, disp FROM ranked WHERE rn = 1
  )
  SELECT
    sc.source_id,
    l.at                                                            AS last_cron_at,
    l.disp                                                          AS dispatched,
    p.sz                                                            AS suburb_pool_size,
    -- For bounding_box sources, "eligible" is conceptually 1 (Greater Sydney
    -- region, single call). For per-suburb sources, eligible = pool size,
    -- optionally capped by max_suburbs. We mirror pulseFireScrapes' logic:
    -- LIMIT max_suburbs WHERE priority >= min_priority. Without per-suburb
    -- priority filter we can compute upper bound = min(pool, max_suburbs).
    CASE
      WHEN sc.approach = 'bounding_box' THEN 1
      ELSE LEAST(
        p.sz,
        COALESCE(sc.max_suburbs, p.sz)
      )
    END                                                             AS eligible_at_run,
    -- status: ok | partial | none | never
    CASE
      WHEN l.at IS NULL THEN 'never'
      WHEN l.disp IS NULL OR l.disp = 0 THEN 'none'
      WHEN sc.approach = 'bounding_box' AND l.disp >= 1 THEN 'ok'
      WHEN l.disp >= LEAST(p.sz, COALESCE(sc.max_suburbs, p.sz)) * 0.9 THEN 'ok'
      WHEN l.disp >= LEAST(p.sz, COALESCE(sc.max_suburbs, p.sz)) * 0.5 THEN 'partial'
      ELSE 'low'
    END                                                             AS status
  FROM pulse_source_configs sc
  CROSS JOIN pool p
  LEFT JOIN latest l ON l.sid = sc.source_id;
$$;

GRANT EXECUTE ON FUNCTION pulse_source_card_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_source_card_stats() TO anon;

COMMENT ON FUNCTION pulse_source_card_stats() IS
  'Returns one row per pulse_source_configs source with: timestamp of last '
  'cron_dispatched event, the dispatched suburb count, current suburb pool '
  'size, and a status string (ok|partial|low|none|never). Used by the '
  'IndustryPulse Data Sources Source Card to show suburb COVERAGE (not the '
  'per-suburb fetch counts already shown by pulse_sync_runs).';

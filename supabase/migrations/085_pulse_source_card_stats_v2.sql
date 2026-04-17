-- 085: pulse_source_card_stats v2 — expose config_max_suburbs + config_min_priority
--
-- The Source Card UI needs the full picture to render the secondary "configured
-- to scrape Y of your POOL_SIZE-suburb pool" line under the X/Y coverage number.
-- Previously the UI had to look those values up from a separate
-- pulseSourceConfigs query and join client-side. This migration extends the RPC
-- to return them inline so the card can render in one shot.
--
-- We also expose `is_enabled` so the UI can show a "disabled" state for sources
-- like domain_agents / domain_agencies that intentionally have no cron.
--
-- Drop-and-recreate is required because we're adding columns to the RETURNS
-- TABLE signature (Postgres rejects in-place column additions).

DROP FUNCTION IF EXISTS pulse_source_card_stats();

CREATE OR REPLACE FUNCTION pulse_source_card_stats()
RETURNS TABLE (
  source_id            text,
  last_cron_at         timestamptz,
  dispatched           int,
  suburb_pool_size     int,
  eligible_at_run      int,
  status               text,
  config_max_suburbs   int,
  config_min_priority  int,
  is_enabled           boolean,
  approach             text
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
    CASE
      WHEN sc.approach = 'bounding_box' THEN 1
      ELSE LEAST(p.sz, COALESCE(sc.max_suburbs, p.sz))
    END                                                             AS eligible_at_run,
    CASE
      WHEN l.at IS NULL THEN 'never'
      WHEN l.disp IS NULL OR l.disp = 0 THEN 'none'
      WHEN sc.approach = 'bounding_box' AND l.disp >= 1 THEN 'ok'
      WHEN l.disp >= LEAST(p.sz, COALESCE(sc.max_suburbs, p.sz)) * 0.9 THEN 'ok'
      WHEN l.disp >= LEAST(p.sz, COALESCE(sc.max_suburbs, p.sz)) * 0.5 THEN 'partial'
      ELSE 'low'
    END                                                             AS status,
    sc.max_suburbs                                                  AS config_max_suburbs,
    sc.min_priority                                                 AS config_min_priority,
    sc.is_enabled                                                   AS is_enabled,
    sc.approach                                                     AS approach
  FROM pulse_source_configs sc
  CROSS JOIN pool p
  LEFT JOIN latest l ON l.sid = sc.source_id;
$$;

GRANT EXECUTE ON FUNCTION pulse_source_card_stats() TO authenticated;

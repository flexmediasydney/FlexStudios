-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 145 — pulse_get_sync_log_records(sync_log_id) RPC
--
-- Powers the "New (N)" / "Changes (N)" tabs inside the Data Sources drill-down
-- popup. Given a sync_log_id, returns the two payload arrays the UI needs:
--
--   new_records:    pulse_timeline rows with event_type='first_seen'
--                   joined to the target entity table so we can show a
--                   display_name / subtitle / external_id without forcing the
--                   frontend to do a second lookup.
--   change_events:  all other pulse_timeline rows for that run (status /
--                   price / contact / etc. changes). Includes previous_value
--                   + new_value so the UI can render a diff mini-block.
--
-- Both arrays are capped at 2000 rows to keep the JSON payload reasonable.
-- *_count_total carry the un-capped counts so the UI can show
-- "showing 2000 of N".
--
-- Uses SECURITY DEFINER so it can run without granting SELECT on the
-- pulse_* tables to `authenticated` directly — grant is scoped to the
-- function instead.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_sync_log_records(p_sync_log_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH new_records AS (
    SELECT pt.id AS timeline_id,
           pt.entity_type,
           pt.pulse_entity_id,
           pt.title,
           pt.description,
           pt.created_at,
           CASE pt.entity_type
             WHEN 'agent'   THEN pa.full_name
             WHEN 'agency'  THEN pag.name
             WHEN 'listing' THEN pl.address
           END AS display_name,
           CASE pt.entity_type
             WHEN 'agent'   THEN pa.agency_name
             WHEN 'agency'  THEN pag.suburb
             WHEN 'listing' THEN pl.suburb || ' · ' || COALESCE(pl.listing_type, '')
           END AS subtitle,
           CASE pt.entity_type
             WHEN 'agent'   THEN pa.rea_agent_id
             WHEN 'agency'  THEN pag.rea_agency_id
             WHEN 'listing' THEN pl.source_listing_id
           END AS external_id
    FROM pulse_timeline pt
    LEFT JOIN pulse_agents   pa  ON pa.id  = pt.pulse_entity_id AND pt.entity_type = 'agent'
    LEFT JOIN pulse_agencies pag ON pag.id = pt.pulse_entity_id AND pt.entity_type = 'agency'
    LEFT JOIN pulse_listings pl  ON pl.id  = pt.pulse_entity_id AND pt.entity_type = 'listing'
    WHERE pt.sync_log_id = p_sync_log_id
      AND pt.event_type  = 'first_seen'
    ORDER BY pt.created_at
    LIMIT 2000
  ),
  change_events AS (
    SELECT pt.id AS timeline_id,
           pt.entity_type,
           pt.pulse_entity_id,
           pt.event_type,
           pt.event_category,
           pt.title,
           pt.description,
           pt.previous_value,
           pt.new_value,
           pt.created_at,
           CASE pt.entity_type
             WHEN 'agent'   THEN pa.full_name
             WHEN 'agency'  THEN pag.name
             WHEN 'listing' THEN pl.address
           END AS display_name
    FROM pulse_timeline pt
    LEFT JOIN pulse_agents   pa  ON pa.id  = pt.pulse_entity_id AND pt.entity_type = 'agent'
    LEFT JOIN pulse_agencies pag ON pag.id = pt.pulse_entity_id AND pt.entity_type = 'agency'
    LEFT JOIN pulse_listings pl  ON pl.id  = pt.pulse_entity_id AND pt.entity_type = 'listing'
    WHERE pt.sync_log_id = p_sync_log_id
      AND pt.event_type != 'first_seen'
    ORDER BY pt.created_at
    LIMIT 2000
  )
  SELECT jsonb_build_object(
    'new_records',       (SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) FROM new_records r),
    'new_count_total',   (SELECT count(*) FROM pulse_timeline WHERE sync_log_id = p_sync_log_id AND event_type  = 'first_seen'),
    'change_events',     (SELECT coalesce(jsonb_agg(row_to_json(r)), '[]'::jsonb) FROM change_events r),
    'change_count_total',(SELECT count(*) FROM pulse_timeline WHERE sync_log_id = p_sync_log_id AND event_type != 'first_seen'),
    'counts_by_category',(
      SELECT coalesce(jsonb_object_agg(event_category, n), '{}'::jsonb)
      FROM (
        SELECT event_category, count(*) n
        FROM pulse_timeline
        WHERE sync_log_id = p_sync_log_id
        GROUP BY event_category
      ) x
    )
  );
$$;

GRANT EXECUTE ON FUNCTION pulse_get_sync_log_records(uuid) TO authenticated;

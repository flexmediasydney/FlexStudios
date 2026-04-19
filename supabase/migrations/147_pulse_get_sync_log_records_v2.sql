-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 147 — pulse_get_sync_log_records v2 (drill-down UX fixes)
--
-- Fixes two user-facing bugs in the Data Sources drill-down popup:
--
-- BUG A: "New" tab always empty on listing-heavy runs.
--   pulseDataSync only emits `first_seen` timeline events for agents/agencies
--   (via bridge-create). Listings never emit per-row `first_seen` — only a
--   single rollup `new_listings_detected` summary row per run. So querying
--   pulse_timeline for first_seen misses all the actual listing inserts.
--
--   Fix: additionally query pulse_listings / pulse_agents / pulse_agencies
--   DIRECTLY by `first_seen_at` within the sync log's time window, UNION'd
--   with the existing first_seen event lookup (dedup on pulse_entity_id).
--
-- BUG B: "Changes" tab shows run-level rollups ("10 new listings detected").
--   Those are summary events, not entity changes, and confuse users.
--
--   Fix: filter out rollup event_types + any `entity_type = 'system'` rows
--   from change_events. Rollups stay visible via counts_by_category / the
--   header summary.
--
-- Shape unchanged: same keys, same limits (2000), same SECURITY DEFINER grant.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_sync_log_records(p_sync_log_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH sync_window AS (
    SELECT started_at,
           COALESCE(completed_at, now()) AS completed_at
    FROM pulse_sync_logs
    WHERE id = p_sync_log_id
  ),
  -- Path 1: pulse_timeline first_seen events (agents/agencies get these via
  -- bridge-create; listings in theory could too). Kept for compatibility and
  -- as a catch-all when the entity row pre-existed but is attributed to this
  -- sync via the event log.
  new_via_events AS (
    SELECT pt.entity_type,
           pt.pulse_entity_id,
           pt.created_at
    FROM pulse_timeline pt
    WHERE pt.sync_log_id = p_sync_log_id
      AND pt.event_type  = 'first_seen'
  ),
  -- Path 2: direct lookup by first_seen_at against the sync window.
  -- This catches listings (which never emit per-row first_seen events)
  -- and is defensive for any agent/agency path that skipped bridge-create.
  new_listings_direct AS (
    SELECT 'listing'::text    AS entity_type,
           pl.id              AS pulse_entity_id,
           pl.first_seen_at   AS created_at
    FROM pulse_listings pl, sync_window sw
    WHERE pl.first_seen_at >= sw.started_at
      AND pl.first_seen_at <= sw.completed_at + interval '1 minute'
  ),
  new_agencies_direct AS (
    SELECT 'agency'::text     AS entity_type,
           pag.id             AS pulse_entity_id,
           pag.first_seen_at  AS created_at
    FROM pulse_agencies pag, sync_window sw
    WHERE pag.first_seen_at >= sw.started_at
      AND pag.first_seen_at <= sw.completed_at + interval '1 minute'
  ),
  new_agents_direct AS (
    SELECT 'agent'::text      AS entity_type,
           pa.id              AS pulse_entity_id,
           pa.first_seen_at   AS created_at
    FROM pulse_agents pa, sync_window sw
    WHERE pa.first_seen_at >= sw.started_at
      AND pa.first_seen_at <= sw.completed_at + interval '1 minute'
  ),
  -- Union + dedupe on (entity_type, pulse_entity_id). Prefer the
  -- first_seen event row if both paths return it (has a timeline_id).
  new_union AS (
    SELECT entity_type, pulse_entity_id, created_at FROM new_via_events
    UNION
    SELECT entity_type, pulse_entity_id, created_at FROM new_listings_direct
    UNION
    SELECT entity_type, pulse_entity_id, created_at FROM new_agencies_direct
    UNION
    SELECT entity_type, pulse_entity_id, created_at FROM new_agents_direct
  ),
  new_records AS (
    SELECT DISTINCT ON (nu.entity_type, nu.pulse_entity_id)
           -- pulse_entity_id is unique inside an entity_type, so double-up as key
           (nu.entity_type || ':' || nu.pulse_entity_id::text) AS timeline_id,
           nu.entity_type,
           nu.pulse_entity_id,
           NULL::text AS title,
           NULL::text AS description,
           nu.created_at,
           CASE nu.entity_type
             WHEN 'agent'   THEN pa.full_name
             WHEN 'agency'  THEN pag.name
             WHEN 'listing' THEN pl.address
           END AS display_name,
           CASE nu.entity_type
             WHEN 'agent'   THEN pa.agency_name
             WHEN 'agency'  THEN pag.suburb
             WHEN 'listing' THEN COALESCE(pl.suburb, '') ||
                                 CASE WHEN pl.listing_type IS NOT NULL AND pl.listing_type <> ''
                                      THEN ' · ' || pl.listing_type
                                      ELSE '' END
           END AS subtitle,
           CASE nu.entity_type
             WHEN 'agent'   THEN pa.rea_agent_id
             WHEN 'agency'  THEN pag.rea_agency_id
             WHEN 'listing' THEN pl.source_listing_id
           END AS external_id,
           -- Extra fields used by the New tab's "match Payload: Listings" row layout
           CASE nu.entity_type WHEN 'listing' THEN pl.suburb        END AS l_suburb,
           CASE nu.entity_type WHEN 'listing' THEN pl.listing_type  END AS l_listing_type,
           CASE nu.entity_type WHEN 'listing' THEN pl.property_type END AS l_property_type,
           CASE nu.entity_type WHEN 'listing' THEN pl.asking_price  END AS l_asking_price,
           CASE nu.entity_type WHEN 'listing' THEN pl.price_text    END AS l_price_text,
           CASE nu.entity_type WHEN 'listing' THEN pl.bedrooms      END AS l_bedrooms,
           CASE nu.entity_type WHEN 'listing' THEN pl.bathrooms     END AS l_bathrooms,
           CASE nu.entity_type WHEN 'listing' THEN pl.parking       END AS l_parking,
           CASE nu.entity_type WHEN 'listing' THEN pl.status        END AS l_status,
           CASE nu.entity_type WHEN 'listing' THEN pl.source_url    END AS l_source_url
    FROM new_union nu
    LEFT JOIN pulse_agents   pa  ON pa.id  = nu.pulse_entity_id AND nu.entity_type = 'agent'
    LEFT JOIN pulse_agencies pag ON pag.id = nu.pulse_entity_id AND nu.entity_type = 'agency'
    LEFT JOIN pulse_listings pl  ON pl.id  = nu.pulse_entity_id AND nu.entity_type = 'listing'
    ORDER BY nu.entity_type, nu.pulse_entity_id, nu.created_at
    LIMIT 2000
  ),
  -- Run-level rollup events that are NOT entity-level changes. We show them
  -- in the header summary (counts_by_category) but strip them from the
  -- Changes tab so users don't see "10 new listings detected" listed as a
  -- change event.
  rollup_event_types AS (
    SELECT unnest(ARRAY[
      'new_listings_detected',
      'client_new_listing',
      'cron_dispatched',
      'cron_dispatch_batch',
      'cron_dispatch_started',
      'cron_dispatch_completed',
      'coverage_report',
      'data_sync',
      'data_cleanup',
      'circuit_reset'
    ]::text[]) AS event_type
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
      AND pt.event_type NOT IN (SELECT event_type FROM rollup_event_types)
      AND (pt.entity_type IS NULL OR pt.entity_type != 'system')
    ORDER BY pt.created_at
    LIMIT 2000
  )
  SELECT jsonb_build_object(
    'new_records',       (SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.created_at), '[]'::jsonb) FROM new_records r),
    'new_count_total',   (SELECT count(*) FROM (
       SELECT DISTINCT entity_type, pulse_entity_id FROM (
         SELECT entity_type, pulse_entity_id FROM pulse_timeline
           WHERE sync_log_id = p_sync_log_id AND event_type = 'first_seen'
         UNION
         SELECT 'listing'::text, pl.id FROM pulse_listings pl, sync_window sw
           WHERE pl.first_seen_at >= sw.started_at AND pl.first_seen_at <= sw.completed_at + interval '1 minute'
         UNION
         SELECT 'agency'::text,  pag.id FROM pulse_agencies pag, sync_window sw
           WHERE pag.first_seen_at >= sw.started_at AND pag.first_seen_at <= sw.completed_at + interval '1 minute'
         UNION
         SELECT 'agent'::text,   pa.id FROM pulse_agents pa, sync_window sw
           WHERE pa.first_seen_at >= sw.started_at AND pa.first_seen_at <= sw.completed_at + interval '1 minute'
       ) u
    ) x),
    'change_events',     (SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.created_at), '[]'::jsonb) FROM change_events r),
    'change_count_total',(SELECT count(*) FROM pulse_timeline pt
       WHERE pt.sync_log_id = p_sync_log_id
         AND pt.event_type != 'first_seen'
         AND pt.event_type NOT IN (SELECT event_type FROM rollup_event_types)
         AND (pt.entity_type IS NULL OR pt.entity_type != 'system')
    ),
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

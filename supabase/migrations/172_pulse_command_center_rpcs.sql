-- 172_pulse_command_center_rpcs.sql
-- New RPCs powering the overhauled Industry Pulse Command Center:
--   pulse_command_digest(p_hours int)  -> jsonb "since you last checked" digest
--   pulse_command_actions()            -> jsonb prioritized action queue inputs
--   pulse_command_watchlist(ids jsonb) -> jsonb latest activity per starred id
--
-- NOTE: pulse_global_search was originally part of this migration, but a
-- parallel migration (176_pulse_global_search_rpc.sql) replaced it with a
-- superior pg_trgm-based implementation sharing the same contract (kind,
-- id, label, sub). The client reads the 176 version; no global_search
-- section lives here any longer.
--
-- The digest + actions + watchlist RPCs return pre-aggregated jsonb so the
-- browser just renders. The client caches aggressively (60s staleTime).

BEGIN;

-- == 2. pulse_command_digest =================================================
-- Returns a single jsonb describing the key activity in the last p_hours.
-- Used by the "Since you last checked" digest at the top of the page.

CREATE OR REPLACE FUNCTION pulse_command_digest(p_hours int DEFAULT 24)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH window_def AS (
    SELECT
      (now() - make_interval(hours => p_hours)) AS since,
      (now() - make_interval(hours => p_hours * 2)) AS prev_since,
      (now() - make_interval(hours => p_hours))::timestamptz AS window_start,
      now()::timestamptz AS window_end
  ),
  new_listings AS (
    SELECT
      count(*) FILTER (WHERE ev.created_at >= w.since) AS current,
      count(*) FILTER (WHERE ev.created_at >= w.prev_since AND ev.created_at < w.since) AS prior
    FROM pulse_timeline ev, window_def w
    WHERE ev.event_type = 'first_seen'
      AND ev.created_at >= w.prev_since
  ),
  new_listings_crm AS (
    -- Listings whose denormalised agent_pulse_id belongs to an in-CRM agent.
    SELECT count(DISTINCT ev.pulse_entity_id) AS current
    FROM pulse_timeline ev
    JOIN pulse_listings l ON l.id = ev.pulse_entity_id
    JOIN pulse_agents a ON a.id = l.agent_pulse_id
    CROSS JOIN window_def w
    WHERE ev.event_type = 'first_seen'
      AND ev.entity_type = 'listing'
      AND ev.created_at >= w.since
      AND a.is_in_crm = true
  ),
  high_value_missed AS (
    SELECT
      count(*) FILTER (WHERE m.created_at >= w.since AND m.quoted_price >= 1000) AS current,
      count(*) FILTER (WHERE m.created_at >= w.prev_since AND m.created_at < w.since AND m.quoted_price >= 1000) AS prior,
      coalesce(sum(m.quoted_price) FILTER (WHERE m.created_at >= w.since AND m.quoted_price >= 1000), 0) AS value_current
    FROM pulse_listing_missed_opportunity m, window_def w
    WHERE m.created_at >= w.prev_since
      AND m.quote_status IN ('fresh', 'stale')
  ),
  new_agents AS (
    SELECT
      count(*) FILTER (WHERE a.created_at >= w.since) AS current,
      count(*) FILTER (WHERE a.created_at >= w.prev_since AND a.created_at < w.since) AS prior
    FROM pulse_agents a, window_def w
    WHERE coalesce(a.is_in_crm, false) = false
      AND a.created_at >= w.prev_since
  ),
  new_signals AS (
    SELECT
      count(*) FILTER (WHERE s.created_at >= w.since) AS current,
      count(*) FILTER (WHERE s.created_at >= w.prev_since AND s.created_at < w.since) AS prior
    FROM pulse_signals s, window_def w
    WHERE s.created_at >= w.prev_since
  ),
  enrichment_now AS (
    SELECT
      count(*) FILTER (WHERE listing_type = 'for_sale') AS total_fs,
      count(*) FILTER (WHERE listing_type = 'for_sale' AND detail_enriched_at IS NOT NULL) AS enriched_fs
    FROM pulse_listings
  ),
  -- Previous coverage % approx using a snapshot of rows enriched BEFORE the
  -- window. Gives a usable delta without a history table.
  enrichment_prev AS (
    SELECT
      count(*) FILTER (WHERE listing_type = 'for_sale' AND first_seen_at < w.since) AS total_fs_prior,
      count(*) FILTER (
        WHERE listing_type = 'for_sale'
          AND first_seen_at < w.since
          AND detail_enriched_at IS NOT NULL
          AND detail_enriched_at < w.since
      ) AS enriched_fs_prior
    FROM pulse_listings, window_def w
  ),
  -- 7-day daily sparkline of new listing counts
  daily_spark AS (
    SELECT jsonb_agg(
      jsonb_build_object('d', to_char(day, 'YYYY-MM-DD'), 'c', cnt)
      ORDER BY day
    ) AS rows
    FROM (
      SELECT
        date_trunc('day', gs)::date AS day,
        (
          SELECT count(*) FROM pulse_timeline ev
          WHERE ev.event_type = 'first_seen'
            AND ev.created_at >= gs
            AND ev.created_at < gs + interval '1 day'
        ) AS cnt
      FROM generate_series(
        date_trunc('day', now() - interval '6 days'),
        date_trunc('day', now()),
        interval '1 day'
      ) gs
    ) t
  )
  SELECT jsonb_build_object(
    'window_hours', p_hours,
    'window_start', (SELECT window_start FROM window_def),
    'window_end',   (SELECT window_end FROM window_def),
    'new_listings', jsonb_build_object(
      'current', (SELECT current FROM new_listings),
      'prior',   (SELECT prior FROM new_listings)
    ),
    'new_listings_crm', jsonb_build_object(
      'current', (SELECT current FROM new_listings_crm)
    ),
    'high_value_missed', jsonb_build_object(
      'current', (SELECT current FROM high_value_missed),
      'prior',   (SELECT prior FROM high_value_missed),
      'value',   (SELECT value_current FROM high_value_missed)
    ),
    'new_agents_outside_crm', jsonb_build_object(
      'current', (SELECT current FROM new_agents),
      'prior',   (SELECT prior FROM new_agents)
    ),
    'new_signals', jsonb_build_object(
      'current', (SELECT current FROM new_signals),
      'prior',   (SELECT prior FROM new_signals)
    ),
    'enrichment_coverage', jsonb_build_object(
      'pct_now',  CASE WHEN (SELECT total_fs FROM enrichment_now) > 0
                       THEN round(100.0 * (SELECT enriched_fs FROM enrichment_now) / (SELECT total_fs FROM enrichment_now), 1)
                       ELSE 0 END,
      'pct_prior', CASE WHEN (SELECT total_fs_prior FROM enrichment_prev) > 0
                        THEN round(100.0 * (SELECT enriched_fs_prior FROM enrichment_prev) / (SELECT total_fs_prior FROM enrichment_prev), 1)
                        ELSE 0 END
    ),
    'listings_sparkline_7d', coalesce((SELECT rows FROM daily_spark), '[]'::jsonb)
  );
$$;

-- == 3. pulse_command_actions ================================================
-- Returns raw inputs the client uses to build the prioritized action queue.
-- The client scores + renders cards; the RPC just surfaces the numbers.

CREATE OR REPLACE FUNCTION pulse_command_actions()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  pending_mappings AS (
    SELECT
      count(*) AS total_pending,
      count(*) FILTER (WHERE confidence = 'high') AS high_conf_pending
    FROM pulse_crm_mappings
    WHERE confirmed_at IS NULL
  ),
  unclassified AS (
    SELECT count(*) AS total
    FROM pulse_listing_missed_opportunity
    WHERE classified_package_name = 'UNCLASSIFIABLE'
      AND quote_status IN ('fresh', 'stale')
  ),
  stale_sources AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'source_id', source_id,
        'label', label,
        'last_run_at', last_run_at,
        'schedule_cron', schedule_cron,
        'hours_since_last', round(extract(epoch FROM (now() - last_run_at))/3600.0, 1)
      ) ORDER BY last_run_at ASC NULLS FIRST
    ) AS rows
    FROM pulse_source_configs
    WHERE is_enabled = true
      AND last_run_at IS NOT NULL
      AND last_run_at < now() - interval '3 hours'
    LIMIT 5
  ),
  silent_agents AS (
    -- In-CRM agents with zero captured listings in last 30d but with
    -- recent territory activity (listings). Shows up as "losing share".
    SELECT jsonb_agg(row_to_json(x)) AS rows FROM (
      SELECT
        a.id,
        a.full_name,
        a.agency_name
      FROM pulse_agents a
      WHERE coalesce(a.is_in_crm, false) = true
        AND EXISTS (
          SELECT 1 FROM pulse_listings l
          WHERE l.agent_pulse_id = a.id
            AND l.first_seen_at > now() - interval '30 days'
        )
      ORDER BY a.total_listings_active DESC NULLS LAST
      LIMIT 3
    ) x
  ),
  open_signals AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE level = 'organisation') AS organisation,
      count(*) FILTER (WHERE level = 'person') AS person
    FROM pulse_signals
    WHERE status = 'new'
  ),
  enrichment_backlog AS (
    SELECT
      count(*) FILTER (WHERE listing_type = 'for_sale' AND detail_enriched_at IS NULL) AS pending,
      count(*) FILTER (WHERE listing_type = 'for_sale' AND detail_enriched_at < now() - interval '14 days') AS stale
    FROM pulse_listings
  )
  SELECT jsonb_build_object(
    'pending_mappings', (SELECT row_to_json(pending_mappings) FROM pending_mappings),
    'unclassified', (SELECT total FROM unclassified),
    'stale_sources', coalesce((SELECT rows FROM stale_sources), '[]'::jsonb),
    'silent_agents', coalesce((SELECT rows FROM silent_agents), '[]'::jsonb),
    'open_signals', (SELECT row_to_json(open_signals) FROM open_signals),
    'enrichment_backlog', (SELECT row_to_json(enrichment_backlog) FROM enrichment_backlog)
  );
$$;

-- == 4. pulse_command_watchlist ==============================================
-- For a list of starred entity ids, return latest-activity summary for each.
-- Client passes jsonb arrays of UUIDs: { "agent_ids": [...], "agency_ids": [...] }.

CREATE OR REPLACE FUNCTION pulse_command_watchlist(p_ids jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agent_ids AS (
    SELECT (elem)::uuid AS id
    FROM jsonb_array_elements_text(coalesce(p_ids->'agent_ids', '[]'::jsonb)) elem
  ),
  agency_ids AS (
    SELECT (elem)::uuid AS id
    FROM jsonb_array_elements_text(coalesce(p_ids->'agency_ids', '[]'::jsonb)) elem
  ),
  agent_rows AS (
    SELECT
      a.id,
      a.full_name AS name,
      a.agency_name AS sub,
      a.total_listings_active,
      coalesce(a.is_in_crm, false) AS is_in_crm,
      (
        SELECT count(*)
        FROM pulse_timeline ev
        WHERE ev.entity_type = 'agent'
          AND ev.pulse_entity_id = a.id
          AND ev.event_type = 'first_seen'
          AND ev.created_at > now() - interval '7 days'
      ) AS new_this_week,
      (
        SELECT max(ev.created_at)
        FROM pulse_timeline ev
        WHERE ev.entity_type = 'agent'
          AND ev.pulse_entity_id = a.id
      ) AS last_activity_at
    FROM pulse_agents a
    WHERE a.id IN (SELECT id FROM agent_ids)
  ),
  agency_rows AS (
    SELECT
      ag.id,
      ag.name,
      coalesce(ag.suburb, ag.state) AS sub,
      coalesce(ag.is_in_crm, false) AS is_in_crm,
      (
        SELECT count(*)
        FROM pulse_timeline ev
        WHERE ev.entity_type = 'agency'
          AND ev.pulse_entity_id = ag.id
          AND ev.event_type = 'first_seen'
          AND ev.created_at > now() - interval '7 days'
      ) AS new_this_week,
      (
        SELECT max(ev.created_at)
        FROM pulse_timeline ev
        WHERE ev.entity_type = 'agency'
          AND ev.pulse_entity_id = ag.id
      ) AS last_activity_at
    FROM pulse_agencies ag
    WHERE ag.id IN (SELECT id FROM agency_ids)
  )
  SELECT jsonb_build_object(
    'agents', coalesce(
      (SELECT jsonb_agg(row_to_json(agent_rows)) FROM agent_rows),
      '[]'::jsonb
    ),
    'agencies', coalesce(
      (SELECT jsonb_agg(row_to_json(agency_rows)) FROM agency_rows),
      '[]'::jsonb
    )
  );
$$;

COMMIT;

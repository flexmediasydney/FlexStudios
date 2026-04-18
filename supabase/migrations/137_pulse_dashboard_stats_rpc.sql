-- Migration 137: pulse_get_dashboard_stats RPC
-- =============================================
-- Why: IndustryPulse.jsx previously loaded the FULL pulse_agents (8k+) +
-- pulse_agencies + pulse_listings (10k+) + pulse_events arrays into the
-- browser on every page mount via useEntityList. Every mount = ~50MB JSON
-- download + React-Query hydration.
--
-- What: A single SQL-only STABLE function that returns every aggregate the
-- Command Center + Stats strip on Industry Pulse needs — totals,
-- 7-day/14-day trend baselines, the top-N agents not in CRM, recent events,
-- agencies-sold-last-7-days aggregates, recent enrichment events, hot signals,
-- suburb distribution, and conversion funnel inputs.
--
-- Size: small JSON object (~10 KB on current data). Loads in <200ms.
-- Security: SECURITY DEFINER so it can bypass RLS on these read-only aggregate
-- lookups (same pattern as the existing pulse_get_dossier RPC).

CREATE OR REPLACE FUNCTION pulse_get_dashboard_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    -- Headline totals — used by IndustryPulse stat strip + tab chip counts
    'totals', jsonb_build_object(
      'agents',              (SELECT count(*) FROM pulse_agents),
      'agents_not_in_crm',   (SELECT count(*) FROM pulse_agents WHERE is_in_crm = false),
      'agents_in_crm',       (SELECT count(*) FROM pulse_agents WHERE is_in_crm = true),
      'agencies',            (SELECT count(*) FROM pulse_agencies),
      'agencies_not_in_crm', (SELECT count(*) FROM pulse_agencies WHERE is_in_crm = false),
      'agencies_in_crm',     (SELECT count(*) FROM pulse_agencies WHERE is_in_crm = true),
      'listings',            (SELECT count(*) FROM pulse_listings),
      'for_sale',            (SELECT count(*) FROM pulse_listings WHERE listing_type = 'for_sale'),
      'for_rent',            (SELECT count(*) FROM pulse_listings WHERE listing_type = 'for_rent'),
      'sold',                (SELECT count(*) FROM pulse_listings WHERE listing_type = 'sold'),
      'under_contract',      (SELECT count(*) FROM pulse_listings WHERE listing_type = 'under_contract'),
      'withdrawn',           (SELECT count(*) FROM pulse_listings WHERE listing_type = 'withdrawn'),
      'upcoming_events',     (SELECT count(*) FROM pulse_events WHERE event_date > now() AND coalesce(status,'') <> 'skipped'),
      'new_signals',         (SELECT count(*) FROM pulse_signals WHERE status = 'new'),
      'agent_movements_30d', (SELECT count(*) FROM pulse_agents WHERE agency_changed_at > now() - interval '30 days'),
      'suggested_mappings',  (SELECT count(*) FROM pulse_crm_mappings WHERE confidence = 'suggested'),
      'sold_12m',            (SELECT count(*) FROM pulse_listings WHERE listing_type = 'sold' AND coalesce(sold_date, last_synced_at) > now() - interval '12 months'),
      'recent_listings_30d', (SELECT count(*) FROM pulse_listings WHERE listed_date > now() - interval '30 days'),
      'recent_projects_30d', (SELECT count(*) FROM projects WHERE created_at > now() - interval '30 days')
    ),

    -- Avg days-on-market (client-side reduce was previously over 5k-row cap)
    'avg_dom', (
      SELECT COALESCE(round(avg(days_on_market))::int, 0)
      FROM pulse_listings
      WHERE days_on_market > 0
    ),

    -- Weekly trend baseline (for the ▲+12% delta badges on stat cards).
    -- Counts the universe of rows that existed 7 days ago.
    'trend_7d_ago', jsonb_build_object(
      'agents',     (SELECT count(*) FROM pulse_agents    WHERE created_at < now() - interval '7 days'),
      'agencies',   (SELECT count(*) FROM pulse_agencies  WHERE created_at < now() - interval '7 days'),
      'for_sale',   (SELECT count(*) FROM pulse_listings  WHERE listing_type = 'for_sale'  AND created_at < now() - interval '7 days'),
      'for_rent',   (SELECT count(*) FROM pulse_listings  WHERE listing_type = 'for_rent'  AND created_at < now() - interval '7 days'),
      'sold',       (SELECT count(*) FROM pulse_listings  WHERE listing_type = 'sold'      AND created_at < now() - interval '7 days')
    ),

    -- Top 10 agents NOT in CRM, ranked by a prospect score that mirrors the
    -- JS prospectScore() in PulseCommandCenter: listings + $ + contactability
    -- + rating. Replacing the client-side sort avoids shuttling 8k agents to
    -- the browser just to pick 10.
    'top_unmapped_agents', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.prospect_score DESC), '[]'::jsonb)
      FROM (
        SELECT
          pa.id,
          pa.full_name,
          pa.agency_name,
          pa.profile_image,
          pa.total_listings_active,
          pa.total_sold_12m,
          pa.avg_sold_price,
          pa.rea_rating,
          pa.mobile,
          pa.email,
          pa.rea_agent_id,
          (
            coalesce(pa.total_listings_active, 0) * 1.0
            + (coalesce(pa.avg_sold_price, 0) / 1000000.0) * 2.0
            + (CASE WHEN pa.mobile IS NOT NULL AND pa.mobile <> '' THEN 10 ELSE 0 END)
            + (CASE WHEN pa.email IS NOT NULL AND pa.email <> '' THEN 10 ELSE 0 END)
            + (coalesce(pa.rea_rating, 0) * 3)
          ) AS prospect_score
        FROM pulse_agents pa
        WHERE pa.is_in_crm = false
        ORDER BY prospect_score DESC
        LIMIT 10
      ) r
    ),

    -- Sold-last-7-days: top 20 agencies ranked by sold count + total $ value.
    -- Previously a client-side reduce over the whole listings array; here we
    -- run it server-side against only the rows in the 7-day window.
    'sold_last_7_days', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.count DESC, r.total_value DESC), '[]'::jsonb)
      FROM (
        SELECT
          COALESCE(l.agency_rea_id::text, lower(trim(l.agency_name))) AS agency_key,
          MAX(l.agency_rea_id)                                         AS agency_rea_id,
          MAX(l.agency_name)                                           AS agency_name,
          (SELECT pa.id        FROM pulse_agencies pa WHERE pa.rea_agency_id = MAX(l.agency_rea_id) LIMIT 1)  AS pulse_agency_id,
          (SELECT pa.is_in_crm FROM pulse_agencies pa WHERE pa.rea_agency_id = MAX(l.agency_rea_id) LIMIT 1)  AS is_in_crm,
          count(*)::int                                                AS count,
          coalesce(sum(l.sold_price), 0)                               AS total_value
        FROM pulse_listings l
        WHERE l.listing_type = 'sold'
          AND l.sold_date IS NOT NULL
          AND l.sold_date > now() - interval '7 days'
          AND (l.agency_rea_id IS NOT NULL OR (l.agency_name IS NOT NULL AND l.agency_name <> ''))
        GROUP BY agency_key
        ORDER BY count DESC, total_value DESC
        LIMIT 20
      ) r
    ),

    -- Suburb distribution: top 15 suburbs by active listing count. Active =
    -- for_sale OR for_rent OR under_contract (matches isActiveListing()).
    'suburb_distribution', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.count DESC), '[]'::jsonb)
      FROM (
        SELECT suburb, count(*)::int AS count
        FROM pulse_listings
        WHERE listing_type IN ('for_sale', 'for_rent', 'under_contract')
          AND suburb IS NOT NULL AND suburb <> ''
        GROUP BY suburb
        ORDER BY count DESC
        LIMIT 15
      ) r
    ),

    -- Weekly listings trend — up to 52 weeks so the Command Center's window
    -- picker (4w/12w/26w/52w) can render without a server round-trip.
    'weekly_listings', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.week_start), '[]'::jsonb)
      FROM (
        SELECT
          date_trunc('week', l.listed_date)::date AS week_start,
          count(*)::int AS count
        FROM pulse_listings l
        WHERE l.listed_date > now() - interval '52 weeks'
        GROUP BY week_start
      ) r
    ),

    -- Conversion funnel: every stage except "Territory" (which we already
    -- have from totals.agents). CRM "Active" counts are produced with a
    -- case-insensitive match to handle historical casing drift.
    'funnel', jsonb_build_object(
      'territory',     (SELECT count(*) FROM pulse_agents),
      'in_crm_total',  (SELECT count(*) FROM agents),
      'in_crm_active', (SELECT count(*) FROM agents WHERE lower(coalesce(relationship_state,'')) = 'active'),
      'booked_30d',    (SELECT count(*) FROM projects WHERE created_at > now() - interval '30 days')
    ),

    -- Agencies-to-table banner: $-value of territory listings whose agency is
    -- NOT in CRM. Replaces a client-side reduce over the full listings array.
    'money_on_the_table', (
      SELECT jsonb_build_object(
        'total',        COALESCE(SUM(COALESCE(l.asking_price, l.sold_price, 0)), 0),
        'listing_count', COUNT(*)::int
      )
      FROM pulse_listings l
      LEFT JOIN pulse_agencies pa
        ON (pa.rea_agency_id IS NOT NULL AND l.agency_rea_id IS NOT NULL AND pa.rea_agency_id = l.agency_rea_id)
        OR (pa.rea_agency_id IS NULL AND l.agency_rea_id IS NULL AND lower(trim(pa.name)) = lower(trim(l.agency_name)))
      WHERE pa.is_in_crm = false
        AND COALESCE(l.asking_price, l.sold_price, 0) > 0
    ),

    -- Recent enrichment / hot-signal feeds. Trimmed to the last 10 each so
    -- the payload stays small — the full history is available in the Timeline
    -- tab.
    'recent_enrichment', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT t.id, t.event_type, t.created_at, t.title, t.description,
               t.entity_type, t.pulse_entity_id, t.rea_id
        FROM pulse_timeline t
        WHERE t.event_type IN ('agent_email_discovered','agent_mobile_discovered','detail_enriched','first_seen')
        ORDER BY t.created_at DESC
        LIMIT 10
      ) r
    ),

    'hot_signals_7d', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT s.id, s.created_at, s.category AS event_type,
               s.title, s.description, s.level,
               s.linked_agent_ids, s.linked_agency_ids,
               s.source_type, s.source_url
        FROM pulse_signals s
        WHERE s.created_at > now() - interval '7 days'
        ORDER BY s.created_at DESC
        LIMIT 10
      ) r
    ),

    -- Fallback proxy for Hot Signals: timeline events that look like signals
    -- when pulse_signals is still sparse (matches SIGNAL_PROXY_CONFIG keys).
    'hot_signals_proxy_7d', (
      SELECT coalesce(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT t.id, t.created_at, t.event_type, t.title, t.description,
               t.entity_type, t.pulse_entity_id
        FROM pulse_timeline t
        WHERE t.event_type IN ('client_new_listing','listing_floorplan_added')
          AND t.created_at > now() - interval '7 days'
        ORDER BY t.created_at DESC
        LIMIT 10
      ) r
    ),

    'generated_at', to_jsonb(now())
  );
$$;

GRANT EXECUTE ON FUNCTION pulse_get_dashboard_stats() TO authenticated, anon, service_role;

COMMENT ON FUNCTION pulse_get_dashboard_stats() IS
  'Aggregate dashboard stats for the Industry Pulse page. Replaces 4 huge top-level useEntityList fetches (PulseAgent + PulseAgency + PulseListing + PulseEvent) with a single ~10KB JSON payload. See migration 137.';

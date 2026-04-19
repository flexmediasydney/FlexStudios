-- 165_pulse_retention_scope_rpcs.sql
-- Scope-based Retention RPCs for FlexStudios Industry Pulse Retention tab.
--
-- Concepts
--   "Scope" = CRM-mapped entity we consider an active customer.
--     * agent:  pulse_agents.is_in_crm = true  (resolves to a CRM contact via linked_agent_id)
--     * agency: pulse_agencies.is_in_crm = true (CRM org via linked_agency_id)
--
--   "Projects in scope" — rows in `projects` where
--     * project_type_name = 'Residential Real Estate'
--     * status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
--     * agent_id matches pulse_agents.linked_agent_id (for agent scope)
--       or project.agent_id linked-agent.linked_agency_pulse_id matches the agency
--
--   "Listings not linked" — pulse_listings with listing_type='for_sale',
--     agent_rea_id / agency_rea_id matching the scope entity, first_seen_at in window,
--     and NO project exists at that property_key in delivered/scheduled/ready_for_partial/
--     to_be_scheduled.
--
--   Retention % = projects_in_scope / (projects_in_scope + listings_in_window).
--     (interpreted as "signals we captured vs signals in the window")
--     For agent_detail we also surface the plain listings_captured (project exists at
--     same property_key) vs listings_missed split.
--
-- RPCs added
--   pulse_get_retention_agent_scope(from, to, min_activity)
--   pulse_get_retention_agency_scope(from, to, min_activity)
--   pulse_get_retention_agent_detail(agent_rea_id, from, to)
--   pulse_get_retention_agency_detail(agency_pulse_id, from, to)

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- pulse_get_retention_agent_scope
-- ══════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS pulse_get_retention_agent_scope(timestamptz, timestamptz, int);

CREATE OR REPLACE FUNCTION pulse_get_retention_agent_scope(
  p_from timestamptz,
  p_to   timestamptz,
  p_min_activity int DEFAULT 1
)
RETURNS TABLE (
  agent_rea_id               text,
  agent_pulse_id             uuid,
  agent_name                 text,
  agency_name                text,
  agency_pulse_id            uuid,
  profile_image              text,
  projects_in_scope          bigint,
  listings_in_window         bigint,
  listings_captured          bigint,
  listings_missed            bigint,
  retention_rate_pct         numeric,
  prev_retention_rate_pct    numeric,
  retention_delta_pct        numeric,
  missed_opportunity_value   numeric,
  last_project_date          date,
  last_listing_date          date
)
LANGUAGE sql
STABLE
AS $$
  WITH
  -- 1. In-scope agents (CRM-mapped)
  scope_agents AS (
    SELECT
      pa.id                     AS pulse_id,
      pa.rea_agent_id,
      pa.full_name,
      pa.agency_name,
      pa.linked_agency_pulse_id,
      pa.linked_agent_id,
      pa.profile_image
    FROM pulse_agents pa
    WHERE pa.is_in_crm = true
      AND pa.rea_agent_id IS NOT NULL
  ),
  -- 2. Their residential projects (all time; no window) for "projects_in_scope" and last_project
  scope_projects AS (
    SELECT
      sa.rea_agent_id,
      p.id                           AS project_id,
      p.property_key,
      p.shoot_date::date             AS project_date,
      p.calculated_price,
      p.status
    FROM scope_agents sa
    JOIN projects p ON p.agent_id = sa.linked_agent_id
    WHERE p.project_type_name = 'Residential Real Estate'
      AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  ),
  -- 3. Their for_sale listings inside the window
  window_listings AS (
    SELECT
      sa.rea_agent_id,
      l.id                           AS listing_id,
      l.property_key,
      l.first_seen_at::date          AS seen_date,
      COALESCE(q.quoted_price, 0)    AS quoted_price,
      q.quote_status,
      -- Captured iff we have a project at this property_key
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      )                              AS is_captured
    FROM scope_agents sa
    JOIN pulse_listings l ON l.agent_rea_id = sa.rea_agent_id
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at <  p_to
  ),
  -- 4. Previous window listings (same length, immediately prior) — for trend delta
  prev_window_listings AS (
    SELECT
      sa.rea_agent_id,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM scope_agents sa
    JOIN pulse_listings l ON l.agent_rea_id = sa.rea_agent_id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= (p_from - (p_to - p_from))
      AND l.first_seen_at <  p_from
  ),
  agg_projects AS (
    SELECT rea_agent_id,
           count(*)                  AS projects_cnt,
           max(project_date)         AS last_project
    FROM scope_projects
    GROUP BY rea_agent_id
  ),
  agg_window AS (
    SELECT rea_agent_id,
           count(*)                                                AS listings_cnt,
           count(*) FILTER (WHERE is_captured)                     AS captured_cnt,
           count(*) FILTER (WHERE NOT is_captured)                 AS missed_cnt,
           COALESCE(sum(quoted_price) FILTER (
             WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
           ), 0)                                                   AS missed_value,
           max(seen_date)                                          AS last_seen
    FROM window_listings
    GROUP BY rea_agent_id
  ),
  agg_prev AS (
    SELECT rea_agent_id,
           count(*)                                                AS prev_total,
           count(*) FILTER (WHERE is_captured)                     AS prev_captured
    FROM prev_window_listings
    GROUP BY rea_agent_id
  )
  SELECT
    sa.rea_agent_id                                                AS agent_rea_id,
    sa.pulse_id                                                    AS agent_pulse_id,
    sa.full_name                                                   AS agent_name,
    sa.agency_name,
    sa.linked_agency_pulse_id                                      AS agency_pulse_id,
    sa.profile_image,
    COALESCE(ap.projects_cnt, 0)                                   AS projects_in_scope,
    COALESCE(aw.listings_cnt, 0)                                   AS listings_in_window,
    COALESCE(aw.captured_cnt, 0)                                   AS listings_captured,
    COALESCE(aw.missed_cnt,  0)                                    AS listings_missed,
    -- retention_rate_pct = projects_in_scope / (projects_in_scope + listings_in_window)
    CASE
      WHEN COALESCE(ap.projects_cnt,0) + COALESCE(aw.listings_cnt,0) = 0 THEN 0
      ELSE round(
        100.0 * COALESCE(ap.projects_cnt,0)
             / (COALESCE(ap.projects_cnt,0) + COALESCE(aw.listings_cnt,0)),
        2
      )
    END                                                            AS retention_rate_pct,
    CASE
      WHEN COALESCE(apv.prev_total,0) = 0 THEN NULL
      ELSE round(100.0 * apv.prev_captured / apv.prev_total, 2)
    END                                                            AS prev_retention_rate_pct,
    -- retention_delta_pct: captured% this window vs prior window
    CASE
      WHEN COALESCE(aw.listings_cnt,0) = 0 OR COALESCE(apv.prev_total,0) = 0 THEN NULL
      ELSE round(
        (100.0 * aw.captured_cnt / NULLIF(aw.listings_cnt,0))
        - (100.0 * apv.prev_captured / NULLIF(apv.prev_total,0)),
        2
      )
    END                                                            AS retention_delta_pct,
    COALESCE(aw.missed_value, 0)                                   AS missed_opportunity_value,
    ap.last_project                                                AS last_project_date,
    aw.last_seen                                                   AS last_listing_date
  FROM scope_agents sa
  LEFT JOIN agg_projects ap  ON ap.rea_agent_id  = sa.rea_agent_id
  LEFT JOIN agg_window   aw  ON aw.rea_agent_id  = sa.rea_agent_id
  LEFT JOIN agg_prev     apv ON apv.rea_agent_id = sa.rea_agent_id
  WHERE COALESCE(ap.projects_cnt,0) + COALESCE(aw.listings_cnt,0) >= p_min_activity
  ORDER BY COALESCE(aw.missed_value, 0) DESC, COALESCE(aw.listings_cnt,0) DESC;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- pulse_get_retention_agency_scope — agency-level rollup
-- Scope = pulse_agencies.is_in_crm = true
-- ══════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS pulse_get_retention_agency_scope(timestamptz, timestamptz, int);

CREATE OR REPLACE FUNCTION pulse_get_retention_agency_scope(
  p_from timestamptz,
  p_to   timestamptz,
  p_min_activity int DEFAULT 1
)
RETURNS TABLE (
  agency_pulse_id            uuid,
  agency_name                text,
  agency_rea_id              text,
  logo_url                   text,
  agent_count                bigint,
  projects_in_scope          bigint,
  listings_in_window         bigint,
  listings_captured          bigint,
  listings_missed            bigint,
  retention_rate_pct         numeric,
  prev_retention_rate_pct    numeric,
  retention_delta_pct        numeric,
  missed_opportunity_value   numeric,
  last_project_date          date,
  last_listing_date          date
)
LANGUAGE sql
STABLE
AS $$
  WITH
  scope_agencies AS (
    -- Explicit agency scope…
    SELECT DISTINCT pag.id AS pulse_id
    FROM pulse_agencies pag
    WHERE pag.is_in_crm = true
    UNION
    -- …plus any agency that hosts a CRM-mapped agent (roll-up automatically)
    SELECT DISTINCT pa.linked_agency_pulse_id AS pulse_id
    FROM pulse_agents pa
    WHERE pa.is_in_crm = true
      AND pa.linked_agency_pulse_id IS NOT NULL
  ),
  scope_meta AS (
    SELECT
      sa.pulse_id,
      pag.name         AS agency_name,
      pag.rea_agency_id,
      pag.logo_url
    FROM scope_agencies sa
    LEFT JOIN pulse_agencies pag ON pag.id = sa.pulse_id
  ),
  -- All pulse_agents in that agency (even non-CRM agents contribute to missed listings)
  scope_agency_agents AS (
    SELECT pa.id AS agent_pulse_id,
           pa.rea_agent_id,
           pa.linked_agent_id,
           pa.linked_agency_pulse_id AS agency_pulse_id
    FROM pulse_agents pa
    WHERE pa.linked_agency_pulse_id IN (SELECT pulse_id FROM scope_agencies)
  ),
  -- Residential projects linked through any agent in these agencies
  scope_projects AS (
    SELECT
      saa.agency_pulse_id,
      p.id AS project_id,
      p.shoot_date::date AS project_date
    FROM scope_agency_agents saa
    JOIN projects p ON p.agent_id = saa.linked_agent_id
    WHERE p.project_type_name = 'Residential Real Estate'
      AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  ),
  -- For-sale listings in window, per agency — match by agent_pulse_id OR agency_pulse_id
  window_listings AS (
    SELECT DISTINCT
      sa.pulse_id                    AS agency_pulse_id,
      l.id                           AS listing_id,
      l.property_key,
      l.first_seen_at::date          AS seen_date,
      COALESCE(q.quoted_price, 0)    AS quoted_price,
      q.quote_status,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM scope_agencies sa
    JOIN pulse_listings l ON (l.agency_pulse_id = sa.pulse_id
                              OR l.agent_pulse_id IN (
                                SELECT agent_pulse_id FROM scope_agency_agents WHERE agency_pulse_id = sa.pulse_id
                              ))
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at <  p_to
  ),
  prev_window_listings AS (
    SELECT DISTINCT
      sa.pulse_id AS agency_pulse_id,
      l.id AS listing_id,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM scope_agencies sa
    JOIN pulse_listings l ON (l.agency_pulse_id = sa.pulse_id
                              OR l.agent_pulse_id IN (
                                SELECT agent_pulse_id FROM scope_agency_agents WHERE agency_pulse_id = sa.pulse_id
                              ))
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= (p_from - (p_to - p_from))
      AND l.first_seen_at <  p_from
  ),
  agg_agents AS (
    SELECT agency_pulse_id, count(*) AS agent_cnt
    FROM scope_agency_agents
    GROUP BY agency_pulse_id
  ),
  agg_projects AS (
    SELECT agency_pulse_id,
           count(*) AS projects_cnt,
           max(project_date) AS last_project
    FROM scope_projects
    GROUP BY agency_pulse_id
  ),
  agg_window AS (
    SELECT agency_pulse_id,
           count(*) AS listings_cnt,
           count(*) FILTER (WHERE is_captured) AS captured_cnt,
           count(*) FILTER (WHERE NOT is_captured) AS missed_cnt,
           COALESCE(sum(quoted_price) FILTER (
             WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
           ), 0) AS missed_value,
           max(seen_date) AS last_seen
    FROM window_listings
    GROUP BY agency_pulse_id
  ),
  agg_prev AS (
    SELECT agency_pulse_id,
           count(*) AS prev_total,
           count(*) FILTER (WHERE is_captured) AS prev_captured
    FROM prev_window_listings
    GROUP BY agency_pulse_id
  )
  SELECT
    sm.pulse_id                                                AS agency_pulse_id,
    sm.agency_name,
    sm.rea_agency_id                                           AS agency_rea_id,
    sm.logo_url,
    COALESCE(aa.agent_cnt, 0)                                  AS agent_count,
    COALESCE(ap.projects_cnt, 0)                               AS projects_in_scope,
    COALESCE(aw.listings_cnt, 0)                               AS listings_in_window,
    COALESCE(aw.captured_cnt, 0)                               AS listings_captured,
    COALESCE(aw.missed_cnt,  0)                                AS listings_missed,
    CASE
      WHEN COALESCE(ap.projects_cnt,0) + COALESCE(aw.listings_cnt,0) = 0 THEN 0
      ELSE round(
        100.0 * COALESCE(ap.projects_cnt,0)
             / (COALESCE(ap.projects_cnt,0) + COALESCE(aw.listings_cnt,0)),
        2
      )
    END                                                        AS retention_rate_pct,
    CASE
      WHEN COALESCE(apv.prev_total,0) = 0 THEN NULL
      ELSE round(100.0 * apv.prev_captured / apv.prev_total, 2)
    END                                                        AS prev_retention_rate_pct,
    CASE
      WHEN COALESCE(aw.listings_cnt,0) = 0 OR COALESCE(apv.prev_total,0) = 0 THEN NULL
      ELSE round(
        (100.0 * aw.captured_cnt / NULLIF(aw.listings_cnt,0))
        - (100.0 * apv.prev_captured / NULLIF(apv.prev_total,0)),
        2
      )
    END                                                        AS retention_delta_pct,
    COALESCE(aw.missed_value, 0)                               AS missed_opportunity_value,
    ap.last_project                                            AS last_project_date,
    aw.last_seen                                               AS last_listing_date
  FROM scope_meta sm
  LEFT JOIN agg_agents   aa  ON aa.agency_pulse_id = sm.pulse_id
  LEFT JOIN agg_projects ap  ON ap.agency_pulse_id = sm.pulse_id
  LEFT JOIN agg_window   aw  ON aw.agency_pulse_id = sm.pulse_id
  LEFT JOIN agg_prev     apv ON apv.agency_pulse_id = sm.pulse_id
  WHERE COALESCE(ap.projects_cnt,0) + COALESCE(aw.listings_cnt,0) >= p_min_activity
  ORDER BY COALESCE(aw.missed_value, 0) DESC, COALESCE(aw.listings_cnt,0) DESC;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- pulse_get_retention_agent_detail
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pulse_get_retention_agent_detail(
  p_agent_rea_id text,
  p_from         timestamptz,
  p_to           timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  agent_row AS (
    SELECT
      pa.id            AS agent_pulse_id,
      pa.rea_agent_id,
      pa.full_name,
      pa.email,
      pa.mobile,
      pa.business_phone,
      pa.agency_name,
      pa.linked_agency_pulse_id AS agency_pulse_id,
      pa.linked_agent_id       AS crm_agent_id,
      pa.profile_image,
      pa.is_in_crm
    FROM pulse_agents pa
    WHERE pa.rea_agent_id = p_agent_rea_id
    LIMIT 1
  ),
  proj_rows AS (
    SELECT
      p.id                     AS project_id,
      p.property_address,
      p.property_key,
      COALESCE(p.shoot_date, p.created_at)::date AS booking_date,
      p.status,
      p.calculated_price,
      COALESCE(
        (SELECT pk.name FROM packages pk
          WHERE pk.id = COALESCE(
            ((p.packages->0->>'package_id')::uuid),
            NULL)
          LIMIT 1),
        NULLIF(p.tonomo_package,'')
      ) AS package_name
    FROM projects p
    JOIN agent_row ar ON p.agent_id = ar.crm_agent_id
    WHERE p.project_type_name = 'Residential Real Estate'
      AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  ),
  listing_rows AS (
    SELECT
      l.id                           AS listing_id,
      l.address,
      l.suburb,
      l.first_seen_at,
      l.source_url,
      l.property_key,
      l.asking_price,
      l.agent_pulse_id,
      l.agency_pulse_id,
      q.classified_package_name      AS package,
      q.resolved_tier                AS tier,
      q.quoted_price,
      q.quote_status,
      q.data_gap_flag,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured,
      (SELECT pr.id FROM projects pr
         WHERE pr.property_key = l.property_key
           AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
         LIMIT 1
      ) AS matched_project_id
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.agent_rea_id = p_agent_rea_id
      AND l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at <  p_to
  ),
  match_rows AS (
    SELECT
      property_key,
      bool_or(is_captured)          AS any_captured,
      count(*)                       AS listings_cnt
    FROM listing_rows
    GROUP BY property_key
  )
  SELECT jsonb_build_object(
    'agent', (SELECT to_jsonb(ar.*) FROM agent_row ar),
    'window_from', p_from,
    'window_to',   p_to,
    'summary', jsonb_build_object(
      'projects_in_scope',         (SELECT count(*) FROM proj_rows),
      'listings_in_window',        (SELECT count(*) FROM listing_rows),
      'listings_captured',         (SELECT count(*) FILTER (WHERE is_captured) FROM listing_rows),
      'listings_missed',           (SELECT count(*) FILTER (WHERE NOT is_captured) FROM listing_rows),
      'missed_opportunity_value',  COALESCE((SELECT sum(quoted_price) FROM listing_rows WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0)
    ),
    'projects',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'project_id',       project_id,
        'property_address', property_address,
        'property_key',     property_key,
        'booking_date',     booking_date,
        'status',           status,
        'package_name',     package_name,
        'calculated_price', calculated_price
      ) ORDER BY booking_date DESC NULLS LAST)
      FROM proj_rows
    ), '[]'::jsonb),
    'listings',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',     listing_id,
        'address',        address,
        'suburb',         suburb,
        'first_seen_at',  first_seen_at,
        'source_url',     source_url,
        'property_key',   property_key,
        'package',        package,
        'tier',           tier,
        'quoted_price',   quoted_price,
        'quote_status',   quote_status,
        'data_gap_flag',  data_gap_flag,
        'is_captured',    is_captured,
        'matched_project_id', matched_project_id,
        'agent_pulse_id',  agent_pulse_id,
        'agency_pulse_id', agency_pulse_id
      ) ORDER BY first_seen_at DESC)
      FROM listing_rows
    ), '[]'::jsonb),
    'matches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'property_key', property_key,
        'any_captured', any_captured,
        'listings_cnt', listings_cnt
      ) ORDER BY any_captured DESC, property_key)
      FROM match_rows
    ), '[]'::jsonb)
  );
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- pulse_get_retention_agency_detail
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION pulse_get_retention_agency_detail(
  p_agency_pulse_id uuid,
  p_from            timestamptz,
  p_to              timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
  agency_row AS (
    SELECT
      pag.id AS agency_pulse_id,
      pag.name AS agency_name,
      pag.rea_agency_id,
      pag.logo_url,
      pag.address_street,
      pag.phone,
      pag.email,
      pag.is_in_crm
    FROM pulse_agencies pag
    WHERE pag.id = p_agency_pulse_id
    LIMIT 1
  ),
  agency_agents AS (
    SELECT pa.id             AS agent_pulse_id,
           pa.rea_agent_id,
           pa.linked_agent_id AS crm_agent_id,
           pa.full_name,
           pa.profile_image,
           pa.is_in_crm
    FROM pulse_agents pa
    WHERE pa.linked_agency_pulse_id = p_agency_pulse_id
  ),
  proj_rows AS (
    SELECT
      p.id                     AS project_id,
      p.property_address,
      p.property_key,
      p.agent_name,
      COALESCE(p.shoot_date, p.created_at)::date AS booking_date,
      p.status,
      p.calculated_price,
      COALESCE(
        (SELECT pk.name FROM packages pk
          WHERE pk.id = COALESCE(
            ((p.packages->0->>'package_id')::uuid),
            NULL)
          LIMIT 1),
        NULLIF(p.tonomo_package,'')
      ) AS package_name
    FROM projects p
    JOIN agency_agents aa ON p.agent_id = aa.crm_agent_id
    WHERE p.project_type_name = 'Residential Real Estate'
      AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
  ),
  listing_rows AS (
    SELECT DISTINCT
      l.id                           AS listing_id,
      l.address,
      l.suburb,
      l.first_seen_at,
      l.source_url,
      l.property_key,
      l.agent_name,
      l.agent_rea_id,
      l.agent_pulse_id,
      l.agency_pulse_id,
      q.classified_package_name      AS package,
      q.resolved_tier                AS tier,
      q.quoted_price,
      q.quote_status,
      q.data_gap_flag,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = l.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured,
      (SELECT pr.id FROM projects pr
         WHERE pr.property_key = l.property_key
           AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
         LIMIT 1
      ) AS matched_project_id
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at <  p_to
      AND (
        l.agency_pulse_id = p_agency_pulse_id
        OR l.agent_pulse_id IN (SELECT agent_pulse_id FROM agency_agents)
      )
  ),
  match_rows AS (
    SELECT
      property_key,
      bool_or(is_captured) AS any_captured,
      count(*)              AS listings_cnt
    FROM listing_rows
    GROUP BY property_key
  ),
  -- Per-agent roll-up inside the agency (for "expand to see agents within")
  agent_rollup AS (
    SELECT
      aa.agent_pulse_id,
      aa.rea_agent_id,
      aa.full_name,
      aa.profile_image,
      aa.is_in_crm,
      (SELECT count(*) FROM proj_rows pr WHERE pr.agent_name = aa.full_name) AS projects_cnt,
      (SELECT count(*) FROM listing_rows lr WHERE lr.agent_rea_id = aa.rea_agent_id) AS listings_cnt,
      (SELECT count(*) FROM listing_rows lr WHERE lr.agent_rea_id = aa.rea_agent_id AND lr.is_captured) AS captured_cnt,
      (SELECT count(*) FROM listing_rows lr WHERE lr.agent_rea_id = aa.rea_agent_id AND NOT lr.is_captured) AS missed_cnt,
      COALESCE((SELECT sum(quoted_price) FROM listing_rows lr
                WHERE lr.agent_rea_id = aa.rea_agent_id
                  AND NOT lr.is_captured
                  AND lr.quote_status IN ('fresh','data_gap')), 0) AS missed_value
    FROM agency_agents aa
  )
  SELECT jsonb_build_object(
    'agency', (SELECT to_jsonb(ar.*) FROM agency_row ar),
    'window_from', p_from,
    'window_to',   p_to,
    'summary', jsonb_build_object(
      'agent_count',               (SELECT count(*) FROM agency_agents),
      'projects_in_scope',         (SELECT count(*) FROM proj_rows),
      'listings_in_window',        (SELECT count(*) FROM listing_rows),
      'listings_captured',         (SELECT count(*) FILTER (WHERE is_captured) FROM listing_rows),
      'listings_missed',           (SELECT count(*) FILTER (WHERE NOT is_captured) FROM listing_rows),
      'missed_opportunity_value',  COALESCE((SELECT sum(quoted_price) FROM listing_rows WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0)
    ),
    'agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'agent_pulse_id', agent_pulse_id,
        'agent_rea_id',   rea_agent_id,
        'agent_name',     full_name,
        'profile_image',  profile_image,
        'is_in_crm',      is_in_crm,
        'projects_cnt',   projects_cnt,
        'listings_cnt',   listings_cnt,
        'captured_cnt',   captured_cnt,
        'missed_cnt',     missed_cnt,
        'missed_value',   missed_value
      ) ORDER BY missed_value DESC NULLS LAST, listings_cnt DESC NULLS LAST)
      FROM agent_rollup
    ), '[]'::jsonb),
    'projects',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'project_id',       project_id,
        'property_address', property_address,
        'property_key',     property_key,
        'agent_name',       agent_name,
        'booking_date',     booking_date,
        'status',           status,
        'package_name',     package_name,
        'calculated_price', calculated_price
      ) ORDER BY booking_date DESC NULLS LAST)
      FROM proj_rows
    ), '[]'::jsonb),
    'listings',  COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',     listing_id,
        'address',        address,
        'suburb',         suburb,
        'first_seen_at',  first_seen_at,
        'source_url',     source_url,
        'property_key',   property_key,
        'agent_name',     agent_name,
        'agent_rea_id',   agent_rea_id,
        'package',        package,
        'tier',           tier,
        'quoted_price',   quoted_price,
        'quote_status',   quote_status,
        'data_gap_flag',  data_gap_flag,
        'is_captured',    is_captured,
        'matched_project_id', matched_project_id,
        'agent_pulse_id',  agent_pulse_id,
        'agency_pulse_id', agency_pulse_id
      ) ORDER BY first_seen_at DESC)
      FROM listing_rows
    ), '[]'::jsonb),
    'matches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'property_key', property_key,
        'any_captured', any_captured,
        'listings_cnt', listings_cnt
      ) ORDER BY any_captured DESC, property_key)
      FROM match_rows
    ), '[]'::jsonb)
  );
$$;

COMMIT;

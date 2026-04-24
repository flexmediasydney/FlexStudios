-- Migration 219: same timezone-cast bug as migration 216, in the two
-- scope_v2 RPCs that power the Retention tab.
--
-- Affected date comparisons (both use `p_from::date` / `p_to::date` which
-- resolves to UTC calendar days):
--   • sold CTE:  l.sold_date >= p_from::date ...
--   • proj CTE:  pr.shoot_date >= p_from::date ...
--
-- Fix: `AT TIME ZONE 'Australia/Sydney'` before casting, for both bounds in
-- both CTEs. Pure rewrite; signatures preserved.

CREATE OR REPLACE FUNCTION public.pulse_get_retention_agent_scope_v2(
  p_from timestamp with time zone,
  p_to   timestamp with time zone
) RETURNS TABLE(
  agent_rea_id text, agent_pulse_id uuid, agent_name text, agency_name text,
  agency_pulse_id uuid, profile_image text, email text, mobile text,
  current_listings bigint, current_captured bigint, current_missed bigint,
  current_retention_pct numeric, current_missed_value numeric,
  sold_listings bigint, sold_captured bigint, sold_missed bigint,
  sold_retention_pct numeric, sold_missed_value numeric,
  projects_in_window bigint, last_project_date date, last_listing_date date,
  total_legacy_projects_ever bigint
)
LANGUAGE sql STABLE
AS $function$
  WITH crm_agents AS (
    SELECT pa.id AS agent_pulse_id, pa.rea_agent_id, pa.linked_agent_id AS crm_agent_id,
           pa.full_name AS agent_name, pa.agency_name AS agency_name,
           pa.profile_image, pa.email, pa.mobile,
           (SELECT id FROM pulse_agencies WHERE rea_agency_id = pa.agency_rea_id LIMIT 1) AS agency_pulse_id
    FROM pulse_agents pa
    WHERE pa.is_in_crm = true AND pa.rea_agent_id IS NOT NULL
  ),
  curr AS (
    SELECT l.agent_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           COALESCE(sum(q.quoted_price) FILTER (
             WHERE q.quote_status IN ('fresh','data_gap')
               AND NOT EXISTS (SELECT 1 FROM projects pr
                 WHERE pr.property_key = l.property_key
                   AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ), 0) AS missed_value,
           max(l.first_seen_at::date) AS last_seen
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
    GROUP BY l.agent_rea_id
  ),
  sold AS (
    SELECT l.agent_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           0::numeric AS missed_value,
           max(l.sold_date)::date AS last_sold
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= (p_from AT TIME ZONE 'Australia/Sydney')::date
      AND l.sold_date <  (p_to   AT TIME ZONE 'Australia/Sydney')::date
    GROUP BY l.agent_rea_id
  ),
  proj AS (
    SELECT pa.rea_agent_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM pulse_agents pa
    JOIN pulse_crm_mappings m ON m.entity_type = 'agent'
                              AND (m.pulse_entity_id = pa.id OR m.rea_id = pa.rea_agent_id)
    JOIN projects pr ON pr.agent_id = m.crm_entity_id
    WHERE pa.is_in_crm = true
      AND pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= (p_from AT TIME ZONE 'Australia/Sydney')::date
      AND pr.shoot_date <  (p_to   AT TIME ZONE 'Australia/Sydney')::date
    GROUP BY pa.rea_agent_id
  ),
  legacy_ever AS (
    SELECT linked_pulse_agent_id AS agent_pulse_id, count(*) AS n
    FROM legacy_projects
    WHERE linked_pulse_agent_id IS NOT NULL
    GROUP BY linked_pulse_agent_id
  )
  SELECT
    ca.rea_agent_id AS agent_rea_id, ca.agent_pulse_id, ca.agent_name, ca.agency_name,
    ca.agency_pulse_id, ca.profile_image, ca.email, ca.mobile,
    COALESCE(c.total, 0) AS current_listings,
    COALESCE(c.captured, 0) AS current_captured,
    COALESCE(c.total, 0) - COALESCE(c.captured, 0) AS current_missed,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(c.captured, 0) / c.total, 2) END AS current_retention_pct,
    COALESCE(c.missed_value, 0) AS current_missed_value,
    COALESCE(s.total, 0) AS sold_listings,
    COALESCE(s.captured, 0) AS sold_captured,
    COALESCE(s.total, 0) - COALESCE(s.captured, 0) AS sold_missed,
    CASE WHEN COALESCE(s.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(s.captured, 0) / s.total, 2) END AS sold_retention_pct,
    COALESCE(s.missed_value, 0) AS sold_missed_value,
    COALESCE(p.n, 0) AS projects_in_window,
    p.last_date AS last_project_date,
    GREATEST(c.last_seen, s.last_sold) AS last_listing_date,
    COALESCE(le.n, 0) AS total_legacy_projects_ever
  FROM crm_agents ca
  LEFT JOIN curr c        ON c.agent_rea_id = ca.rea_agent_id
  LEFT JOIN sold s        ON s.agent_rea_id = ca.rea_agent_id
  LEFT JOIN proj p        ON p.rea_agent_id = ca.rea_agent_id
  LEFT JOIN legacy_ever le ON le.agent_pulse_id = ca.agent_pulse_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agent_name;
$function$;


CREATE OR REPLACE FUNCTION public.pulse_get_retention_agency_scope_v2(
  p_from timestamp with time zone,
  p_to   timestamp with time zone
) RETURNS TABLE(
  agency_pulse_id uuid, crm_agency_id uuid, agency_name text, logo_url text,
  suburb text, rea_agency_id text, agents_in_agency bigint,
  current_listings bigint, current_captured bigint, current_missed bigint,
  current_retention_pct numeric, current_missed_value numeric,
  sold_listings bigint, sold_captured bigint, sold_missed bigint,
  sold_retention_pct numeric, sold_missed_value numeric,
  projects_in_window bigint, last_project_date date, last_listing_date date,
  total_legacy_projects_ever bigint
)
LANGUAGE sql STABLE
AS $function$
  WITH crm_agencies AS (
    SELECT pa.id AS agency_pulse_id, pa.linked_agency_id AS crm_agency_id,
           pa.name AS agency_name, pa.logo_url, pa.suburb, pa.rea_agency_id
    FROM pulse_agencies pa
    WHERE pa.is_in_crm = true
  ),
  agents_count AS (
    SELECT agency_rea_id, count(*)::bigint AS n
    FROM pulse_agents WHERE agency_rea_id IS NOT NULL GROUP BY agency_rea_id
  ),
  curr AS (
    SELECT l.agency_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           COALESCE(sum(q.quoted_price) FILTER (
             WHERE q.quote_status IN ('fresh','data_gap')
               AND NOT EXISTS (SELECT 1 FROM projects pr
                 WHERE pr.property_key = l.property_key
                   AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ), 0) AS missed_value,
           max(l.first_seen_at::date) AS last_seen
    FROM pulse_listings l
    LEFT JOIN pulse_listing_missed_opportunity q ON q.listing_id = l.id
    WHERE l.listing_type = 'for_sale'
      AND l.first_seen_at >= p_from
      AND l.first_seen_at < p_to
    GROUP BY l.agency_rea_id
  ),
  sold AS (
    SELECT l.agency_rea_id,
           count(*) AS total,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM projects pr
               WHERE pr.property_key = l.property_key
                 AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled'))
           ) AS captured,
           0::numeric AS missed_value,
           max(l.sold_date)::date AS last_sold
    FROM pulse_listings l
    WHERE l.listing_type = 'sold'
      AND l.sold_date >= (p_from AT TIME ZONE 'Australia/Sydney')::date
      AND l.sold_date <  (p_to   AT TIME ZONE 'Australia/Sydney')::date
    GROUP BY l.agency_rea_id
  ),
  proj AS (
    SELECT ca.rea_agency_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM crm_agencies ca
    JOIN projects pr ON pr.agency_id = ca.crm_agency_id
    WHERE pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= (p_from AT TIME ZONE 'Australia/Sydney')::date
      AND pr.shoot_date <  (p_to   AT TIME ZONE 'Australia/Sydney')::date
    GROUP BY ca.rea_agency_id
  ),
  legacy_ever AS (
    SELECT linked_pulse_agency_id AS agency_pulse_id, count(*) AS n
    FROM legacy_projects
    WHERE linked_pulse_agency_id IS NOT NULL
    GROUP BY linked_pulse_agency_id
  )
  SELECT
    ca.agency_pulse_id, ca.crm_agency_id, ca.agency_name, ca.logo_url, ca.suburb, ca.rea_agency_id,
    COALESCE(ac.n, 0) AS agents_in_agency,
    COALESCE(c.total, 0) AS current_listings,
    COALESCE(c.captured, 0) AS current_captured,
    COALESCE(c.total, 0) - COALESCE(c.captured, 0) AS current_missed,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(c.captured, 0) / c.total, 2) END AS current_retention_pct,
    COALESCE(c.missed_value, 0) AS current_missed_value,
    COALESCE(s.total, 0) AS sold_listings,
    COALESCE(s.captured, 0) AS sold_captured,
    COALESCE(s.total, 0) - COALESCE(s.captured, 0) AS sold_missed,
    CASE WHEN COALESCE(s.total, 0) = 0 THEN 0
         ELSE round(100.0 * COALESCE(s.captured, 0) / s.total, 2) END AS sold_retention_pct,
    COALESCE(s.missed_value, 0) AS sold_missed_value,
    COALESCE(p.n, 0) AS projects_in_window,
    p.last_date AS last_project_date,
    GREATEST(c.last_seen, s.last_sold) AS last_listing_date,
    COALESCE(le.n, 0) AS total_legacy_projects_ever
  FROM crm_agencies ca
  LEFT JOIN agents_count ac ON ac.agency_rea_id = ca.rea_agency_id
  LEFT JOIN curr c          ON c.agency_rea_id  = ca.rea_agency_id
  LEFT JOIN sold s          ON s.agency_rea_id  = ca.rea_agency_id
  LEFT JOIN proj p          ON p.rea_agency_id  = ca.rea_agency_id
  LEFT JOIN legacy_ever le  ON le.agency_pulse_id = ca.agency_pulse_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agency_name;
$function$;

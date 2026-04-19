-- 197_retention_legacy_linkage_upgrade.sql
-- Extends the per-agent / per-agency retention RPCs to show the FULL
-- legacy portfolio for each CRM-linked entity, not just the subset that
-- overlaps with currently-active pulse_listings.
--
-- Why: an agent may have done 50 legacy shoots historically. Only 5 of
-- those properties might also appear as active/sold listings in the
-- current Market Share window. Pre-197, that agent's retention card
-- showed "5 legacy captures" — which is correct for capture rate (the
-- other 45 properties aren't in the market any more) but HIDES the fact
-- that we did 50 total jobs for that agent in aggregate. We want both
-- numbers exposed.
--
-- Contract change:
--   * NEW jsonb field `total_legacy_projects_ever` on:
--       pulse_get_agent_retention(p_agent_rea_id, from, to)
--       pulse_get_agency_retention(p_agency_pulse_id, from, to)
--   * NEW TABLE columns on:
--       pulse_get_retention_agent_scope_v2(from, to)
--       pulse_get_retention_agency_scope_v2(from, to)
--     Named `total_legacy_projects_ever bigint`.
--
-- Back-compat: every previously-returned field is preserved verbatim.
-- Property-key capture check (the universal join) is untouched. We layer
-- ON TOP via the new linked_contact_id / linked_agency_id columns
-- introduced in migration 195.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- pulse_get_agent_retention (jsonb) — add total_legacy_projects_ever
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_get_agent_retention(
  p_agent_rea_id text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agent_ctx AS (
    SELECT pa.id AS agent_pulse_id, pa.linked_agent_id AS crm_agent_id
    FROM pulse_agents pa
    WHERE pa.rea_agent_id = p_agent_rea_id
    LIMIT 1
  ),
  agent_listings AS (
    SELECT q.*,
      l.agent_name, l.agent_rea_id, l.agent_pulse_id, l.agency_pulse_id,
      l.address, l.source_url, l.agency_name, l.detail_enriched_at,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS cap_active,
      EXISTS (
        SELECT 1 FROM legacy_projects lp WHERE lp.property_key = q.property_key
      ) AS cap_legacy
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agent_rea_id = p_agent_rea_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  agent_listings_enriched AS (
    SELECT al.*,
           (cap_active OR cap_legacy) AS is_captured,
           CASE
             WHEN cap_active AND cap_legacy THEN 'both'
             WHEN cap_active THEN 'active'
             WHEN cap_legacy THEN 'legacy'
             ELSE NULL
           END AS captured_by
    FROM agent_listings al
  ),
  legacy_ever AS (
    -- FULL legacy portfolio for this CRM-linked agent, regardless of window.
    SELECT count(*) AS n, max(completed_date) AS last_completed
    FROM legacy_projects lp
    WHERE lp.linked_contact_id = (SELECT crm_agent_id FROM agent_ctx)
      AND (SELECT crm_agent_id FROM agent_ctx) IS NOT NULL
  )
  SELECT jsonb_build_object(
    'agent_rea_id',      p_agent_rea_id,
    'agent_pulse_id',    (SELECT agent_pulse_id FROM agent_ctx),
    'crm_agent_id',      (SELECT crm_agent_id FROM agent_ctx),
    'agency_pulse_id',   (SELECT max(agency_pulse_id::text)::uuid FROM agent_listings_enriched),
    'window_from',       p_from,
    'window_to',         p_to,
    'total_listings',    (SELECT count(*) FROM agent_listings_enriched),
    'captured',          (SELECT count(*) FROM agent_listings_enriched WHERE is_captured),
    'captured_active',   (SELECT count(*) FROM agent_listings_enriched WHERE cap_active),
    'captured_legacy',   (SELECT count(*) FROM agent_listings_enriched WHERE cap_legacy),
    'missed',            (SELECT count(*) FROM agent_listings_enriched WHERE NOT is_captured),
    'retention_rate_pct', CASE
      WHEN (SELECT count(*) FROM agent_listings_enriched) = 0 THEN 0
      ELSE round(100.0 * (SELECT count(*) FROM agent_listings_enriched WHERE is_captured)
               / (SELECT count(*) FROM agent_listings_enriched), 2)
    END,
    'missed_opportunity_value',
       COALESCE((SELECT sum(quoted_price) FROM agent_listings_enriched
                 WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')), 0),
    -- NEW: total legacy projects linked to this CRM agent, ever.
    'total_legacy_projects_ever', COALESCE((SELECT n FROM legacy_ever), 0),
    'last_legacy_completed_date', (SELECT last_completed FROM legacy_ever),
    'missed_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',         listing_id,
        'address',            address,
        'suburb',             suburb,
        'first_seen_at',      first_seen_at,
        'package',            classified_package_name,
        'tier',               resolved_tier,
        'quoted_price',       quoted_price,
        'source_url',         source_url,
        'quote_status',       quote_status,
        'agent_pulse_id',     agent_pulse_id,
        'agency_pulse_id',    agency_pulse_id,
        'detail_enriched_at', detail_enriched_at,
        'captured_by',        captured_by
      ) ORDER BY quoted_price DESC NULLS LAST)
      FROM agent_listings_enriched WHERE NOT is_captured
    ), '[]'::jsonb),
    'captured_listings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'listing_id',         listing_id,
        'address',            address,
        'suburb',             suburb,
        'first_seen_at',      first_seen_at,
        'package',            classified_package_name,
        'agent_pulse_id',     agent_pulse_id,
        'agency_pulse_id',    agency_pulse_id,
        'detail_enriched_at', detail_enriched_at,
        'captured_by',        captured_by
      ) ORDER BY first_seen_at DESC)
      FROM agent_listings_enriched WHERE is_captured
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION pulse_get_agent_retention IS
  'Per-agent retention + market-share rollup. Adds total_legacy_projects_ever (migration 197) — full legacy portfolio via linked_contact_id, not just window-matched.';

-- ════════════════════════════════════════════════════════════════════════════
-- pulse_get_agency_retention (jsonb) — add total_legacy_projects_ever
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_get_agency_retention(
  p_agency_pulse_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agency_ctx AS (
    SELECT id AS agency_pulse_id, linked_agency_id AS crm_agency_id
    FROM pulse_agencies
    WHERE id = p_agency_pulse_id
  ),
  agency_listings AS (
    SELECT
      q.*,
      l.agent_name, l.agent_rea_id, l.agent_pulse_id,
      l.address, l.source_url, l.agency_name, l.agency_pulse_id,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agency_pulse_id = p_agency_pulse_id
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  totals AS (
    SELECT
      count(*) AS total_listings,
      count(*) FILTER (WHERE is_captured) AS captured,
      count(*) FILTER (WHERE NOT is_captured) AS missed,
      COALESCE(sum(quoted_price) FILTER (
        WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value,
      COALESCE(sum(quoted_price) FILTER (WHERE NOT is_captured), 0) AS missed_value_incl_pending
    FROM agency_listings
  ),
  by_package AS (
    SELECT classified_package_name AS package, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings WHERE NOT is_captured
    GROUP BY classified_package_name
  ),
  by_tier AS (
    SELECT resolved_tier AS tier, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings WHERE NOT is_captured
    GROUP BY resolved_tier
  ),
  agents_rollup AS (
    SELECT
      al.agent_rea_id,
      al.agent_pulse_id,
      max(al.agent_name) AS agent_name,
      count(*) AS total_listings,
      count(*) FILTER (WHERE al.is_captured) AS captured,
      count(*) FILTER (WHERE NOT al.is_captured) AS missed,
      COALESCE(sum(al.quoted_price) FILTER (
        WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value
    FROM agency_listings al
    WHERE al.agent_rea_id IS NOT NULL OR al.agent_pulse_id IS NOT NULL
    GROUP BY al.agent_rea_id, al.agent_pulse_id
  ),
  agents_enriched AS (
    SELECT
      ar.agent_rea_id,
      ar.agent_pulse_id,
      COALESCE(ar.agent_name, pa.full_name) AS agent_name,
      pa.profile_image,
      ar.total_listings,
      ar.captured,
      ar.missed,
      CASE WHEN ar.total_listings = 0 THEN 0
           ELSE round(100.0 * ar.captured / ar.total_listings, 2) END AS retention_rate_pct,
      ar.missed_value
    FROM agents_rollup ar
    LEFT JOIN pulse_agents pa ON pa.id = ar.agent_pulse_id
  ),
  top_missed AS (
    SELECT
      al.listing_id, al.address, al.suburb, al.first_seen_at,
      al.asking_price_numeric AS asking_price,
      al.classified_package_name, al.resolved_tier, al.pricing_method,
      al.quoted_price, al.photo_count, al.has_video,
      al.agency_name, al.agent_name, al.agent_rea_id, al.agent_pulse_id,
      al.source_url, al.quote_status, al.data_gap_flag
    FROM agency_listings al
    WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
    ORDER BY al.quoted_price DESC NULLS LAST, al.first_seen_at DESC
    LIMIT 20
  ),
  legacy_ever AS (
    -- FULL legacy portfolio for this CRM-linked agency, regardless of window.
    SELECT count(*) AS n, max(completed_date) AS last_completed
    FROM legacy_projects lp
    WHERE lp.linked_agency_id = (SELECT crm_agency_id FROM agency_ctx)
      AND (SELECT crm_agency_id FROM agency_ctx) IS NOT NULL
  )
  SELECT jsonb_build_object(
    'agency_pulse_id',   p_agency_pulse_id,
    'crm_agency_id',     (SELECT crm_agency_id FROM agency_ctx),
    'window_from',       p_from,
    'window_to',         p_to,
    'total_listings',    (SELECT total_listings FROM totals),
    'captured',          (SELECT captured FROM totals),
    'missed',            (SELECT missed FROM totals),
    'retention_rate_pct', CASE
      WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * (SELECT captured FROM totals) / (SELECT total_listings FROM totals), 2)
    END,
    'missed_opportunity_value',           (SELECT missed_value FROM totals),
    'missed_opportunity_including_pending', (SELECT missed_value_incl_pending FROM totals),
    -- NEW: total legacy projects for this CRM agency, ever.
    'total_legacy_projects_ever', COALESCE((SELECT n FROM legacy_ever), 0),
    'last_legacy_completed_date', (SELECT last_completed FROM legacy_ever),
    'by_package', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('package', package, 'listings', listings, 'value', value) ORDER BY value DESC) FROM by_package),
      '[]'::jsonb
    ),
    'by_tier', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('tier', tier, 'listings', listings, 'value', value) ORDER BY value DESC) FROM by_tier),
      '[]'::jsonb
    ),
    'agents', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'agent_rea_id',             agent_rea_id,
        'agent_pulse_id',           agent_pulse_id,
        'agent_name',               agent_name,
        'profile_image',            profile_image,
        'total_listings',           total_listings,
        'captured',                 captured,
        'missed',                   missed,
        'retention_rate_pct',       retention_rate_pct,
        'missed_opportunity_value', missed_value
      ) ORDER BY missed_value DESC, total_listings DESC) FROM agents_enriched),
      '[]'::jsonb
    ),
    'top_missed_listings', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'listing_id',              listing_id,
        'address',                 address,
        'suburb',                  suburb,
        'first_seen_at',           first_seen_at,
        'asking_price',            asking_price,
        'classified_package_name', classified_package_name,
        'resolved_tier',           resolved_tier,
        'pricing_method',          pricing_method,
        'quoted_price',            quoted_price,
        'photo_count',             photo_count,
        'has_video',               has_video,
        'agency_name',             agency_name,
        'agent_name',               agent_name,
        'agent_rea_id',            agent_rea_id,
        'agent_pulse_id',          agent_pulse_id,
        'source_url',              source_url,
        'quote_status',            quote_status,
        'data_gap_flag',           data_gap_flag
      )) FROM top_missed),
      '[]'::jsonb
    )
  );
$$;

COMMENT ON FUNCTION pulse_get_agency_retention IS
  'Per-agency retention + market-share rollup. Adds total_legacy_projects_ever (migration 197) — full legacy portfolio via linked_agency_id.';

-- ════════════════════════════════════════════════════════════════════════════
-- pulse_get_retention_agent_scope_v2 — extend TABLE return with legacy count
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS pulse_get_retention_agent_scope_v2(timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION pulse_get_retention_agent_scope_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agent_rea_id text,
  agent_pulse_id uuid,
  agent_name text,
  agency_name text,
  agency_pulse_id uuid,
  profile_image text,
  email text,
  mobile text,
  current_listings bigint,
  current_captured bigint,
  current_missed bigint,
  current_retention_pct numeric,
  current_missed_value numeric,
  sold_listings bigint,
  sold_captured bigint,
  sold_missed bigint,
  sold_retention_pct numeric,
  sold_missed_value numeric,
  projects_in_window bigint,
  last_project_date date,
  last_listing_date date,
  total_legacy_projects_ever bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH crm_agents AS (
    SELECT pa.id            AS agent_pulse_id,
           pa.rea_agent_id,
           pa.linked_agent_id AS crm_agent_id,
           pa.full_name      AS agent_name,
           pa.agency_name    AS agency_name,
           pa.profile_image,
           pa.email,
           pa.mobile,
           (SELECT id FROM pulse_agencies WHERE rea_agency_id = pa.agency_rea_id LIMIT 1) AS agency_pulse_id
    FROM pulse_agents pa
    WHERE pa.is_in_crm = true
      AND pa.rea_agent_id IS NOT NULL
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
      AND l.sold_date >= p_from::date
      AND l.sold_date < p_to::date
    GROUP BY l.agent_rea_id
  ),
  proj AS (
    SELECT pa.rea_agent_id,
           count(DISTINCT pr.id) AS n,
           max(pr.shoot_date) AS last_date
    FROM pulse_agents pa
    JOIN pulse_crm_mappings m ON m.entity_type = 'agent' AND (m.pulse_entity_id = pa.id OR m.rea_id = pa.rea_agent_id)
    JOIN projects pr ON pr.agent_id = m.crm_entity_id
    WHERE pa.is_in_crm = true
      AND pr.project_type_name = 'Residential Real Estate'
      AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      AND pr.shoot_date >= p_from::date
      AND pr.shoot_date < p_to::date
    GROUP BY pa.rea_agent_id
  ),
  legacy_ever AS (
    -- Per-CRM-agent full legacy portfolio regardless of window or listings.
    SELECT linked_contact_id AS crm_agent_id, count(*) AS n
    FROM legacy_projects
    WHERE linked_contact_id IS NOT NULL
    GROUP BY linked_contact_id
  )
  SELECT
    ca.rea_agent_id   AS agent_rea_id,
    ca.agent_pulse_id,
    ca.agent_name,
    ca.agency_name,
    ca.agency_pulse_id,
    ca.profile_image,
    ca.email,
    ca.mobile,
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
  LEFT JOIN legacy_ever le ON le.crm_agent_id = ca.crm_agent_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agent_name;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- pulse_get_retention_agency_scope_v2 — extend TABLE return with legacy count
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS pulse_get_retention_agency_scope_v2(timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION pulse_get_retention_agency_scope_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agency_pulse_id uuid,
  crm_agency_id uuid,
  agency_name text,
  logo_url text,
  suburb text,
  rea_agency_id text,
  agents_in_agency bigint,
  current_listings bigint,
  current_captured bigint,
  current_missed bigint,
  current_retention_pct numeric,
  current_missed_value numeric,
  sold_listings bigint,
  sold_captured bigint,
  sold_missed bigint,
  sold_retention_pct numeric,
  sold_missed_value numeric,
  projects_in_window bigint,
  last_project_date date,
  last_listing_date date,
  total_legacy_projects_ever bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH crm_agencies AS (
    SELECT pa.id                 AS agency_pulse_id,
           pa.linked_agency_id   AS crm_agency_id,
           pa.name               AS agency_name,
           pa.logo_url,
           pa.suburb,
           pa.rea_agency_id
    FROM pulse_agencies pa
    WHERE pa.is_in_crm = true
  ),
  agents_count AS (
    SELECT agency_rea_id, count(*)::bigint AS n
    FROM pulse_agents
    WHERE agency_rea_id IS NOT NULL
    GROUP BY agency_rea_id
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
      AND l.sold_date >= p_from::date
      AND l.sold_date < p_to::date
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
      AND pr.shoot_date >= p_from::date
      AND pr.shoot_date < p_to::date
    GROUP BY ca.rea_agency_id
  ),
  legacy_ever AS (
    SELECT linked_agency_id AS crm_agency_id, count(*) AS n
    FROM legacy_projects
    WHERE linked_agency_id IS NOT NULL
    GROUP BY linked_agency_id
  )
  SELECT
    ca.agency_pulse_id,
    ca.crm_agency_id,
    ca.agency_name,
    ca.logo_url,
    ca.suburb,
    ca.rea_agency_id,
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
  LEFT JOIN legacy_ever le  ON le.crm_agency_id = ca.crm_agency_id
  ORDER BY
    (COALESCE(c.missed_value, 0)) DESC,
    (COALESCE(c.total, 0) - COALESCE(c.captured, 0)) DESC,
    ca.agency_name;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Operator notification
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO pulse_timeline (
  entity_type, event_type, event_category,
  title, description, new_value, source, idempotency_key
) VALUES (
  'system',
  'retention_engine_legacy_linked',
  'system',
  'Retention engine now surfaces full legacy portfolio per agent/agency',
  'pulse_get_agent_retention, pulse_get_agency_retention, pulse_get_retention_agent_scope_v2, pulse_get_retention_agency_scope_v2 now return total_legacy_projects_ever driven by legacy_projects.linked_contact_id / linked_agency_id (migration 195).',
  jsonb_build_object(
    'migration',     '197_retention_legacy_linkage_upgrade',
    'rpcs_extended', jsonb_build_array(
      'pulse_get_agent_retention',
      'pulse_get_agency_retention',
      'pulse_get_retention_agent_scope_v2',
      'pulse_get_retention_agency_scope_v2'
    )
  ),
  '197_retention_legacy_linkage_upgrade',
  '197_retention_legacy_linkage_upgrade:shift'
)
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;

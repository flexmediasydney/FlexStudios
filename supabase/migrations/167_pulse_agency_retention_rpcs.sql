-- 167_pulse_agency_retention_rpcs.sql
-- Agency-level Market Share + Retention intelligence RPCs.
--
-- Parallels pulse_get_agent_retention (mig 160) but aggregates across every
-- agent whose listing is joined to an agency (via pulse_listings.agency_pulse_id).
-- Used by:
--   • OrgDetails.jsx → Market Share tab (CRM Agency detail page)
--   • PulseAgencyIntel.jsx → AgencySlideout → Market Share card (compact)
--   • AgencyMarketShareSection.jsx (new component)
--
-- Substrate: pulse_listing_missed_opportunity (mig 158).
-- Capture criteria matches the Market Share dashboard: a listing is "captured"
-- when a project exists at its property_key with status in
-- (delivered, scheduled, ready_for_partial, to_be_scheduled).
--
-- Headline missed $ excludes pending_enrichment quotes. A second field
-- `missed_opportunity_including_pending` includes them for auditing.

BEGIN;

-- ── 1. pulse_get_agency_retention ──────────────────────────────────────────
-- Full rollup: totals, breakdowns (by_package, by_tier), agent roster ranked
-- by missed opportunity $, and top 20 missed listings for drill-through.

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
      l.agent_name,
      l.agent_rea_id,
      l.agent_pulse_id,
      l.address,
      l.source_url,
      l.agency_name,
      l.agency_pulse_id,
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
    FROM agency_listings
    WHERE NOT is_captured
    GROUP BY classified_package_name
  ),
  by_tier AS (
    SELECT resolved_tier AS tier, count(*) AS listings,
           COALESCE(sum(quoted_price), 0) AS value
    FROM agency_listings
    WHERE NOT is_captured
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
      al.listing_id,
      al.address,
      al.suburb,
      al.first_seen_at,
      al.asking_price_numeric AS asking_price,
      al.classified_package_name,
      al.resolved_tier,
      al.pricing_method,
      al.quoted_price,
      al.photo_count,
      al.has_video,
      al.agency_name,
      al.agent_name,
      al.agent_rea_id,
      al.agent_pulse_id,
      al.source_url,
      al.quote_status,
      al.data_gap_flag
    FROM agency_listings al
    WHERE NOT al.is_captured
      AND al.quote_status IN ('fresh','data_gap')
    ORDER BY al.quoted_price DESC NULLS LAST, al.first_seen_at DESC
    LIMIT 20
  )
  SELECT jsonb_build_object(
    'agency_pulse_id', p_agency_pulse_id,
    'crm_agency_id', (SELECT crm_agency_id FROM agency_ctx),
    'window_from', p_from,
    'window_to', p_to,
    'total_listings', (SELECT total_listings FROM totals),
    'captured', (SELECT captured FROM totals),
    'missed', (SELECT missed FROM totals),
    'retention_rate_pct', CASE
      WHEN (SELECT total_listings FROM totals) = 0 THEN 0
      ELSE round(100.0 * (SELECT captured FROM totals) / (SELECT total_listings FROM totals), 2)
    END,
    'missed_opportunity_value', (SELECT missed_value FROM totals),
    'missed_opportunity_including_pending', (SELECT missed_value_incl_pending FROM totals),
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
        'agent_rea_id', agent_rea_id,
        'agent_pulse_id', agent_pulse_id,
        'agent_name', agent_name,
        'profile_image', profile_image,
        'total_listings', total_listings,
        'captured', captured,
        'missed', missed,
        'retention_rate_pct', retention_rate_pct,
        'missed_opportunity_value', missed_value
      ) ORDER BY missed_value DESC, total_listings DESC) FROM agents_enriched),
      '[]'::jsonb
    ),
    'top_missed_listings', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
        'listing_id', listing_id,
        'address', address,
        'suburb', suburb,
        'first_seen_at', first_seen_at,
        'asking_price', asking_price,
        'classified_package_name', classified_package_name,
        'resolved_tier', resolved_tier,
        'pricing_method', pricing_method,
        'quoted_price', quoted_price,
        'photo_count', photo_count,
        'has_video', has_video,
        'agency_name', agency_name,
        'agent_name', agent_name,
        'agent_rea_id', agent_rea_id,
        'agent_pulse_id', agent_pulse_id,
        'source_url', source_url,
        'quote_status', quote_status,
        'data_gap_flag', data_gap_flag
      )) FROM top_missed),
      '[]'::jsonb
    )
  );
$$;

-- ── 2. pulse_get_agency_retention_monthly ──────────────────────────────────
-- Monthly trend: powers the retention trend line chart.

CREATE OR REPLACE FUNCTION pulse_get_agency_retention_monthly(
  p_agency_pulse_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  month date,
  total int,
  captured int,
  missed int,
  missed_value numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH agency_listings AS (
    SELECT
      q.first_seen_at,
      q.quoted_price,
      q.quote_status,
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
  )
  SELECT
    date_trunc('month', first_seen_at)::date AS month,
    count(*)::int AS total,
    count(*) FILTER (WHERE is_captured)::int AS captured,
    count(*) FILTER (WHERE NOT is_captured)::int AS missed,
    COALESCE(sum(quoted_price) FILTER (
      WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
    ), 0)::numeric AS missed_value
  FROM agency_listings
  GROUP BY 1
  ORDER BY 1;
$$;

-- ── 3. pulse_get_agency_growth_headroom ────────────────────────────────────
-- "If we captured p_target_capture_pct of the missed listings, this much
-- additional revenue becomes available." Used for the sales-scenario card.

CREATE OR REPLACE FUNCTION pulse_get_agency_growth_headroom(
  p_agency_pulse_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_target_capture_pct numeric DEFAULT 50
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH agency_listings AS (
    SELECT
      q.quoted_price,
      q.quote_status,
      q.first_seen_at,
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
  agg AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE is_captured) AS captured,
      count(*) FILTER (WHERE NOT is_captured) AS missed,
      COALESCE(sum(quoted_price) FILTER (
        WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
      ), 0) AS missed_value,
      COALESCE(avg(quoted_price) FILTER (
        WHERE NOT is_captured AND quote_status IN ('fresh','data_gap')
          AND quoted_price IS NOT NULL AND quoted_price > 0
      ), 0) AS avg_missed_price
    FROM agency_listings
  ),
  months AS (
    -- Count of month buckets spanned by the window; min 1 to avoid /0.
    SELECT GREATEST(1, (extract(year FROM p_to) * 12 + extract(month FROM p_to))
                     - (extract(year FROM p_from) * 12 + extract(month FROM p_from))
                     + 1) AS n
  )
  SELECT jsonb_build_object(
    'current_capture_pct', CASE WHEN (SELECT total FROM agg) = 0 THEN 0
                                ELSE round(100.0 * (SELECT captured FROM agg) / (SELECT total FROM agg), 2) END,
    'target_capture_pct', p_target_capture_pct,
    'additional_captures_needed', GREATEST(0,
      ceil((p_target_capture_pct / 100.0) * (SELECT total FROM agg))::int
        - (SELECT captured FROM agg)::int
    ),
    'additional_revenue',
      -- Scale missed $ by whatever fraction of missed listings we'd need to hit
      -- p_target_capture_pct. Null-safe / zero-safe.
      CASE WHEN (SELECT missed FROM agg) = 0 OR (SELECT total FROM agg) = 0 THEN 0
           ELSE round(
             (SELECT missed_value FROM agg) *
             LEAST(1.0, GREATEST(0.0,
               (ceil((p_target_capture_pct / 100.0) * (SELECT total FROM agg))::numeric
                - (SELECT captured FROM agg)::numeric
               ) / NULLIF((SELECT missed FROM agg), 0)::numeric
             ))
           , 2) END,
    'per_month_avg',
      CASE WHEN (SELECT missed FROM agg) = 0 OR (SELECT total FROM agg) = 0 THEN 0
           ELSE round(
             ((SELECT missed_value FROM agg) *
             LEAST(1.0, GREATEST(0.0,
               (ceil((p_target_capture_pct / 100.0) * (SELECT total FROM agg))::numeric
                - (SELECT captured FROM agg)::numeric
               ) / NULLIF((SELECT missed FROM agg), 0)::numeric
             )))
             / (SELECT n FROM months)
           , 2) END,
    'window_months', (SELECT n FROM months),
    'total_missed_value', (SELECT missed_value FROM agg)
  );
$$;

COMMIT;

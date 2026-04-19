-- 174_pulse_agents_retention_bulk.sql
-- Bulk retention RPCs for the Industry Pulse Agents / Agencies tabs.
--
-- Problem: PulseAgentIntel and PulseAgencyIntel render ~50 rows per page but
-- there are ~8.8k pulse_agents and ~2.5k pulse_agencies overall. The per-row
-- Grid view wants a "Missed opp (12m) + Retention%" chip on every card, and
-- calling pulse_get_agent_retention / pulse_get_agency_retention once per row
-- is an N+1 disaster (50 RTTs per page render, most of which walk the same
-- pulse_listing_missed_opportunity + projects joins).
--
-- This migration adds two batched RPCs that accept an array of rea_ids and
-- return one row per id with the headline retention + missed_value numbers
-- only. No breakdowns, no top-missed, no agent rollup — just enough for the
-- compact chip + filter. ~100x fewer round-trips.
--
-- The frontend uses these lazily (only once the Grid card is visible / the
-- Table row is on-screen) and caches the rows in react-query by rea_id so
-- paging backwards is free.

BEGIN;

-- ── 1. pulse_get_agents_retention_bulk ────────────────────────────────────
-- Batched equivalent of pulse_get_agent_retention. Returns one row per
-- requested rea_agent_id, including the zero-case for ids that have no
-- listings in the window (so the UI can distinguish "no data" from "not
-- queried yet" without needing a second RPC).

CREATE OR REPLACE FUNCTION pulse_get_agents_retention_bulk(
  p_rea_agent_ids text[],
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  rea_agent_id text,
  total_listings int,
  captured int,
  missed int,
  retention_rate_pct numeric,
  missed_opportunity_value numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH ids AS (
    SELECT unnest(p_rea_agent_ids) AS rea_agent_id
  ),
  agent_listings AS (
    SELECT
      l.agent_rea_id,
      q.quoted_price,
      q.quote_status,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agent_rea_id = ANY(p_rea_agent_ids)
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  rolled AS (
    SELECT
      al.agent_rea_id,
      count(*)::int AS total_listings,
      count(*) FILTER (WHERE al.is_captured)::int AS captured,
      count(*) FILTER (WHERE NOT al.is_captured)::int AS missed,
      COALESCE(sum(al.quoted_price) FILTER (
        WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
      ), 0)::numeric AS missed_opportunity_value
    FROM agent_listings al
    GROUP BY al.agent_rea_id
  )
  SELECT
    ids.rea_agent_id,
    COALESCE(r.total_listings, 0) AS total_listings,
    COALESCE(r.captured, 0) AS captured,
    COALESCE(r.missed, 0) AS missed,
    CASE WHEN COALESCE(r.total_listings, 0) = 0 THEN 0
         ELSE round(100.0 * r.captured / r.total_listings, 2) END AS retention_rate_pct,
    COALESCE(r.missed_opportunity_value, 0) AS missed_opportunity_value
  FROM ids
  LEFT JOIN rolled r ON r.agent_rea_id = ids.rea_agent_id;
$$;

COMMENT ON FUNCTION pulse_get_agents_retention_bulk(text[], timestamptz, timestamptz) IS
  'Batched retention headline for N agents. Mirrors pulse_get_agent_retention but returns one row per rea_agent_id with only total/captured/missed/retention%/missed$ — no breakdowns. Used by Industry Pulse Agents tab Grid + Table views.';

-- ── 2. pulse_get_agencies_retention_bulk ──────────────────────────────────
-- Same shape, keyed by agency pulse_id (uuid). Mirrors
-- pulse_get_agency_retention headline fields.

CREATE OR REPLACE FUNCTION pulse_get_agencies_retention_bulk(
  p_agency_pulse_ids uuid[],
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  agency_pulse_id uuid,
  total_listings int,
  captured int,
  missed int,
  retention_rate_pct numeric,
  missed_opportunity_value numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH ids AS (
    SELECT unnest(p_agency_pulse_ids) AS agency_pulse_id
  ),
  agency_listings AS (
    SELECT
      l.agency_pulse_id,
      q.quoted_price,
      q.quote_status,
      EXISTS (
        SELECT 1 FROM projects pr
        WHERE pr.property_key = q.property_key
          AND pr.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
      ) AS is_captured
    FROM pulse_listing_missed_opportunity q
    JOIN pulse_listings l ON l.id = q.listing_id
    WHERE l.agency_pulse_id = ANY(p_agency_pulse_ids)
      AND q.listing_type = 'for_sale'
      AND q.first_seen_at >= p_from
      AND q.first_seen_at < p_to
  ),
  rolled AS (
    SELECT
      al.agency_pulse_id,
      count(*)::int AS total_listings,
      count(*) FILTER (WHERE al.is_captured)::int AS captured,
      count(*) FILTER (WHERE NOT al.is_captured)::int AS missed,
      COALESCE(sum(al.quoted_price) FILTER (
        WHERE NOT al.is_captured AND al.quote_status IN ('fresh','data_gap')
      ), 0)::numeric AS missed_opportunity_value
    FROM agency_listings al
    GROUP BY al.agency_pulse_id
  )
  SELECT
    ids.agency_pulse_id,
    COALESCE(r.total_listings, 0) AS total_listings,
    COALESCE(r.captured, 0) AS captured,
    COALESCE(r.missed, 0) AS missed,
    CASE WHEN COALESCE(r.total_listings, 0) = 0 THEN 0
         ELSE round(100.0 * r.captured / r.total_listings, 2) END AS retention_rate_pct,
    COALESCE(r.missed_opportunity_value, 0) AS missed_opportunity_value
  FROM ids
  LEFT JOIN rolled r ON r.agency_pulse_id = ids.agency_pulse_id;
$$;

COMMENT ON FUNCTION pulse_get_agencies_retention_bulk(uuid[], timestamptz, timestamptz) IS
  'Batched retention headline for N agencies. Mirrors pulse_get_agency_retention headline fields. Used by Industry Pulse Agencies tab Grid + Table views.';

GRANT EXECUTE ON FUNCTION pulse_get_agents_retention_bulk(text[], timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_get_agencies_retention_bulk(uuid[], timestamptz, timestamptz) TO authenticated;

COMMIT;

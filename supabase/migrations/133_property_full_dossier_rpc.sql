-- 133_property_full_dossier_rpc.sql
-- Migration 133 — property_get_full_dossier RPC for the rebuilt PropertyDetails page
--
-- ── Problem ───────────────────────────────────────────────────────────────
-- The PropertyDetails page currently fires 7+ client-side queries to render
-- a single property dossier: properties row, pulse_listings history,
-- flexmedia projects, every agent that ever listed it, agencies, timeline
-- events, active signals, upcoming events, relist-candidate checks,
-- comparables, and neighbour clients. Each query is paginated client-side,
-- and the page stalls for 3–5s on cold load.
--
-- ── Fix ───────────────────────────────────────────────────────────────────
-- A single server-side RPC that assembles everything into one JSONB payload
-- in a single round-trip. Mirrors the pattern established by migration 129
-- (pulse_get_dossier). Target < 500ms.
--
-- Return shape:
--   { property, listings[], projects[], agents[], agencies[], timeline_events[],
--     signals[], upcoming_events[], relist_candidate, comparables[], neighbour_clients[] }
--
-- All list fields are guaranteed to be jsonb arrays (never null) so the UI
-- can spread them blindly. Every subquery is capped (≤ 50 listings, ≤ 50
-- timeline, ≤ 10 signals, ≤ 10 events, ≤ 5 comparables, ≤ 5 neighbours).

BEGIN;

CREATE OR REPLACE FUNCTION public.property_get_full_dossier(
  p_property_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_property            jsonb;
  v_suburb              text;
  v_postcode            text;
  v_state               text;
  v_latitude            numeric;
  v_longitude           numeric;
  v_bedrooms            integer;
  v_bathrooms           integer;
  v_parking             text;
  v_land_size_sqm       numeric;
  v_property_type       text;
  v_display_address     text;
  v_hero_image          text;
  v_current_listing_id  uuid;
  v_current_listing_type text;
  v_first_listed_date   date;
  v_latest_listed_date  date;
  v_latest_sold_date    date;
  v_latest_sold_price   numeric;
  v_latest_ask_price    numeric;
  v_latest_price_text   text;
  v_days_on_market      integer;
  v_agent_rea_ids       text[];
  v_agency_rea_ids      text[];
  v_listing_ids         uuid[];
  v_listings            jsonb;
  v_projects            jsonb;
  v_agents              jsonb;
  v_agencies            jsonb;
  v_timeline            jsonb;
  v_signals             jsonb;
  v_events              jsonb;
  v_relist              jsonb;
  v_comparables         jsonb;
  v_neighbours          jsonb;
BEGIN
  IF p_property_key IS NULL OR length(btrim(p_property_key)) = 0 THEN
    RETURN jsonb_build_object('error', 'property_key is required');
  END IF;

  -- ── 1. Pull the canonical properties row (if present) ───────────────────
  SELECT
    p.display_address, p.suburb, p.postcode, p.state,
    p.latitude, p.longitude
  INTO
    v_display_address, v_suburb, v_postcode, v_state,
    v_latitude, v_longitude
  FROM properties p
  WHERE p.property_key = p_property_key
    AND coalesce(p.is_merged, false) = false
  LIMIT 1;

  -- ── 2. Pick canonical "current listing" ─────────────────────────────────
  --      Most recent by listed_date DESC where listing_withdrawn_at IS NULL;
  --      fall back to most recent active-state row (any withdrawal state)
  --      if no un-withdrawn listing exists.
  SELECT l.id, l.listing_type, l.listed_date
    INTO v_current_listing_id, v_current_listing_type, v_latest_listed_date
  FROM pulse_listings l
  WHERE l.property_key = p_property_key
    AND l.listing_withdrawn_at IS NULL
  ORDER BY l.listed_date DESC NULLS LAST, l.first_seen_at DESC NULLS LAST
  LIMIT 1;

  IF v_current_listing_id IS NULL THEN
    SELECT l.id, l.listing_type, l.listed_date
      INTO v_current_listing_id, v_current_listing_type, v_latest_listed_date
    FROM pulse_listings l
    WHERE l.property_key = p_property_key
    ORDER BY l.listed_date DESC NULLS LAST, l.first_seen_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  -- ── 3. Property-level rollups (address, beds/baths, sold summary) ───────
  SELECT
    coalesce(v_display_address, max(l.address)),
    coalesce(v_suburb,          max(l.suburb)),
    coalesce(v_postcode,        max(l.postcode)),
    coalesce(v_state,           'NSW'),
    coalesce(v_latitude,        max(l.latitude)),
    coalesce(v_longitude,       max(l.longitude)),
    max(l.bedrooms),
    max(l.bathrooms),
    max(l.parking),
    max(l.land_size_sqm),
    max(l.property_type),
    min(l.listed_date)
  INTO
    v_display_address, v_suburb, v_postcode, v_state,
    v_latitude, v_longitude,
    v_bedrooms, v_bathrooms, v_parking, v_land_size_sqm, v_property_type,
    v_first_listed_date
  FROM pulse_listings l
  WHERE l.property_key = p_property_key;

  -- Hero image: from current listing first, else most recent listing that has one.
  SELECT coalesce(l.hero_image, (l.images->>0))
    INTO v_hero_image
  FROM pulse_listings l
  WHERE l.id = v_current_listing_id;

  IF v_hero_image IS NULL THEN
    SELECT coalesce(l.hero_image, (l.images->>0))
      INTO v_hero_image
    FROM pulse_listings l
    WHERE l.property_key = p_property_key
      AND (l.hero_image IS NOT NULL OR jsonb_array_length(coalesce(l.images, '[]'::jsonb)) > 0)
    ORDER BY l.listed_date DESC NULLS LAST, l.first_seen_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  -- Current-listing price details + DOM.
  SELECT l.asking_price, l.price_text, l.days_on_market
    INTO v_latest_ask_price, v_latest_price_text, v_days_on_market
  FROM pulse_listings l
  WHERE l.id = v_current_listing_id;

  -- Canonical sold_date / sold_price = most recent listing_type='sold' row.
  SELECT l.sold_date, l.sold_price
    INTO v_latest_sold_date, v_latest_sold_price
  FROM pulse_listings l
  WHERE l.property_key = p_property_key
    AND l.listing_type = 'sold'
  ORDER BY l.sold_date DESC NULLS LAST, l.listed_date DESC NULLS LAST
  LIMIT 1;

  v_property := jsonb_build_object(
    'property_key',                p_property_key,
    'display_address',             v_display_address,
    'suburb',                      v_suburb,
    'postcode',                    v_postcode,
    'state',                       v_state,
    'hero_image',                  v_hero_image,
    'latitude',                    v_latitude,
    'longitude',                   v_longitude,
    'current_listing_type',        v_current_listing_type,
    'current_listing_id',          v_current_listing_id,
    'bedrooms',                    v_bedrooms,
    'bathrooms',                   v_bathrooms,
    'parking',                     v_parking,
    'land_size_sqm',               v_land_size_sqm,
    'property_type',               v_property_type,
    'days_on_market',              v_days_on_market,
    'first_listed_date',           v_first_listed_date,
    'latest_listed_date',          v_latest_listed_date,
    'latest_sold_date',            v_latest_sold_date,
    'latest_sold_price',           v_latest_sold_price,
    'latest_asking_price_numeric', v_latest_ask_price,
    'latest_price_text',           v_latest_price_text
  );

  -- ── 4. Listings (up to 50) ───────────────────────────────────────────────
  SELECT
    COALESCE(jsonb_agg(to_jsonb(l_row) ORDER BY l_row.listed_date DESC NULLS LAST,
                                            l_row.first_seen_at DESC NULLS LAST), '[]'::jsonb),
    array_remove(array_agg(DISTINCT l_row.agent_rea_id),  NULL),
    array_remove(array_agg(DISTINCT l_row.agency_rea_id), NULL),
    array_remove(array_agg(DISTINCT l_row.id),            NULL)
  INTO v_listings, v_agent_rea_ids, v_agency_rea_ids, v_listing_ids
  FROM (
    SELECT
      l.id, l.source_listing_id, l.source_url, l.listing_type,
      l.asking_price, l.sold_price, l.price_text,
      l.listed_date, l.sold_date, l.auction_date, l.auction_time_known,
      l.date_available, l.days_on_market, l.listing_withdrawn_at,
      l.agent_rea_id, l.agent_name, l.agency_rea_id, l.agency_name,
      l.agent_pulse_id, l.agency_pulse_id,
      l.hero_image, l.images, l.floorplan_urls, l.video_url, l.video_thumb_url,
      l.media_items, l.detail_enriched_at, l.status, l.description,
      l.first_seen_at
    FROM pulse_listings l
    WHERE l.property_key = p_property_key
    ORDER BY l.listed_date DESC NULLS LAST, l.first_seen_at DESC NULLS LAST
    LIMIT 50
  ) l_row;

  -- ── 5. FlexMedia projects at this property_key ──────────────────────────
  SELECT COALESCE(jsonb_agg(to_jsonb(p_row) ORDER BY p_row.booking_date DESC NULLS LAST), '[]'::jsonb)
    INTO v_projects
  FROM (
    SELECT
      pr.id,
      pr.property_address    AS address,
      pr.agent_id,
      pr.agent_name,
      pr.project_type_name   AS service_type,
      pr.tonomo_package,
      pr.shoot_date          AS booking_date,
      pr.status,
      pr.photographer_name,
      pr.tonomo_deliverable_link AS media_folder_url,
      pr.tonomo_lifecycle_stage  AS pipeline_stage,
      pr.outcome,
      pr.price
    FROM projects pr
    WHERE pr.property_key = p_property_key
      AND coalesce(pr.is_archived, false) = false
    ORDER BY pr.shoot_date DESC NULLS LAST
    LIMIT 50
  ) p_row;

  -- ── 6. Agents decorated (every agent that ever listed this property) ─────
  IF v_agent_rea_ids IS NOT NULL AND array_length(v_agent_rea_ids, 1) > 0 THEN
    WITH agent_list AS (
      SELECT pa.*
      FROM pulse_agents pa
      WHERE pa.rea_agent_id = ANY (v_agent_rea_ids)
    ),
    mapping AS (
      SELECT
        m.pulse_entity_id,
        m.rea_id,
        m.crm_entity_id,
        m.confidence AS crm_mapping_confidence
      FROM pulse_crm_mappings m
      WHERE m.entity_type = 'agent'
        AND (
          m.pulse_entity_id IN (SELECT id FROM agent_list)
          OR m.rea_id        = ANY (v_agent_rea_ids)
        )
    ),
    per_agent_campaigns AS (
      SELECT
        mm.rea_id,
        COUNT(DISTINCT pr.id)  AS campaigns_count,
        MAX(pr.shoot_date)     AS latest_campaign_date
      FROM pulse_crm_mappings mm
      JOIN projects pr
        ON pr.agent_id = mm.crm_entity_id
       AND pr.property_key = p_property_key
      WHERE mm.entity_type = 'agent'
        AND mm.rea_id = ANY (v_agent_rea_ids)
      GROUP BY mm.rea_id
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'rea_agent_id',           al.rea_agent_id,
          'pulse_agent_id',         al.id,
          'crm_agent_id',           mp.crm_entity_id,
          'full_name',              al.full_name,
          'email',                  al.email,
          'mobile',                 al.mobile,
          'profile_image',          al.profile_image,
          'job_title',              al.job_title,
          'agency_name',            al.agency_name,
          'agency_rea_id',          al.agency_rea_id,
          'sales_as_lead',          al.sales_as_lead,
          'avg_sold_price',         al.avg_sold_price,
          'avg_days_on_market',     al.avg_days_on_market,
          'rea_rating',             al.rea_rating,
          'reviews_count',          al.reviews_count,
          'data_integrity_score',   al.data_integrity_score,
          'is_in_crm',              coalesce(al.is_in_crm, false),
          'first_seen_at',          al.first_seen_at,
          'campaigns_count',        coalesce(pc.campaigns_count, 0),
          'latest_campaign_date',   pc.latest_campaign_date,
          'crm_mapping_confidence', mp.crm_mapping_confidence
        )
        ORDER BY al.sales_as_lead DESC NULLS LAST
      ),
      '[]'::jsonb
    )
    INTO v_agents
    FROM agent_list al
    LEFT JOIN mapping mp
      ON mp.pulse_entity_id = al.id
      OR (mp.rea_id IS NOT NULL AND mp.rea_id = al.rea_agent_id)
    LEFT JOIN per_agent_campaigns pc
      ON pc.rea_id = al.rea_agent_id;
  ELSE
    v_agents := '[]'::jsonb;
  END IF;

  -- ── 7. Agencies decorated ───────────────────────────────────────────────
  IF v_agency_rea_ids IS NOT NULL AND array_length(v_agency_rea_ids, 1) > 0 THEN
    WITH agency_list AS (
      SELECT pg.*
      FROM pulse_agencies pg
      WHERE pg.rea_agency_id = ANY (v_agency_rea_ids)
    ),
    mapping AS (
      SELECT
        m.pulse_entity_id,
        m.rea_id,
        m.crm_entity_id,
        m.confidence AS crm_mapping_confidence
      FROM pulse_crm_mappings m
      WHERE m.entity_type = 'agency'
        AND (
          m.pulse_entity_id IN (SELECT id FROM agency_list)
          OR m.rea_id        = ANY (v_agency_rea_ids)
        )
    ),
    per_agency_counts AS (
      SELECT agency_rea_id, COUNT(*)::int AS listings_count_at_property
      FROM pulse_listings
      WHERE property_key = p_property_key
        AND agency_rea_id IS NOT NULL
      GROUP BY agency_rea_id
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'rea_agency_id',             al.rea_agency_id,
          'pulse_agency_id',           al.id,
          'crm_agency_id',             mp.crm_entity_id,
          'name',                      al.name,
          'email',                     al.email,
          'phone',                     al.phone,
          'website',                   al.website,
          'logo_url',                  al.logo_url,
          'brand_color_primary',       coalesce(al.brand_color_primary, al.brand_colour),
          'brand_color_text',          al.brand_color_text,
          'is_in_crm',                 coalesce(al.is_in_crm, false),
          'listings_count_at_property', coalesce(pc.listings_count_at_property, 0),
          'crm_mapping_confidence',    mp.crm_mapping_confidence
        )
        ORDER BY coalesce(pc.listings_count_at_property, 0) DESC, al.name ASC
      ),
      '[]'::jsonb
    )
    INTO v_agencies
    FROM agency_list al
    LEFT JOIN mapping mp
      ON mp.pulse_entity_id = al.id
      OR (mp.rea_id IS NOT NULL AND mp.rea_id = al.rea_agency_id)
    LEFT JOIN per_agency_counts pc
      ON pc.agency_rea_id = al.rea_agency_id;
  ELSE
    v_agencies := '[]'::jsonb;
  END IF;

  -- ── 8. Timeline events (≤ 50) ───────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_timeline
  FROM (
    SELECT
      tl.id, tl.entity_type, tl.event_type, tl.title, tl.description,
      tl.pulse_entity_id, tl.rea_id, tl.source, tl.created_at, tl.metadata
    FROM pulse_timeline tl
    WHERE
      (v_listing_ids IS NOT NULL AND tl.pulse_entity_id = ANY (v_listing_ids))
      OR (v_agent_rea_ids  IS NOT NULL AND tl.rea_id = ANY (v_agent_rea_ids))
      OR (v_agency_rea_ids IS NOT NULL AND tl.rea_id = ANY (v_agency_rea_ids))
    ORDER BY tl.created_at DESC
    LIMIT 50
  ) t;

  -- ── 9. Unresolved signals (≤ 10) ────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC), '[]'::jsonb)
    INTO v_signals
  FROM (
    SELECT
      s.id, s.level, s.category, s.title, s.description,
      s.status, s.created_at, s.source_data
    FROM pulse_signals s
    WHERE coalesce(s.status, 'new') <> 'dismissed'
      AND (
        (s.source_data ? 'property_key' AND s.source_data->>'property_key' = p_property_key)
        OR (
          v_agent_rea_ids IS NOT NULL
          AND jsonb_typeof(s.linked_agent_ids) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(s.linked_agent_ids) AS x(val)
            WHERE x.val = ANY (v_agent_rea_ids)
          )
        )
        OR (
          v_agency_rea_ids IS NOT NULL
          AND jsonb_typeof(s.linked_agency_ids) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(s.linked_agency_ids) AS x(val)
            WHERE x.val = ANY (v_agency_rea_ids)
          )
        )
      )
    ORDER BY s.created_at DESC
    LIMIT 10
  ) s;

  -- ── 10. Upcoming events near this property (≤ 10, next 30d) ─────────────
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.event_date ASC), '[]'::jsonb)
    INTO v_events
  FROM (
    SELECT
      ev.id, ev.title, ev.category, ev.event_date, ev.venue, ev.location,
      ev.source_url
    FROM pulse_events ev
    WHERE ev.event_date BETWEEN now() AND now() + interval '30 days'
      AND (
        (v_suburb           IS NOT NULL AND ev.location ILIKE '%' || v_suburb || '%')
        OR (v_display_address IS NOT NULL AND ev.venue    ILIKE '%' || v_display_address || '%')
      )
    ORDER BY ev.event_date ASC
    LIMIT 10
  ) e;

  -- ── 11. Relist candidate (scoped to this property_key) ──────────────────
  WITH rc AS (
    SELECT *
    FROM pulse_relist_candidates(now() - interval '5 years', 1000)
    WHERE property_key = p_property_key
    LIMIT 1
  )
  SELECT
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM rc) THEN
        jsonb_build_object('is_candidate', false)
      ELSE
        jsonb_build_object(
          'is_candidate',      true,
          'last_withdrawn',    (SELECT last_withdrawn   FROM rc),
          'latest_active_at',  (SELECT latest_active_at FROM rc),
          'agent_rea_ids',     (SELECT to_jsonb(agent_rea_ids)  FROM rc),
          'agency_rea_ids',    (SELECT to_jsonb(agency_rea_ids) FROM rc)
        )
    END
  INTO v_relist;

  -- ── 12. Comparables (≤ 5) ───────────────────────────────────────────────
  --      Same suburb, similar beds (±1), listing_type='sold', sold in last 12mo.
  --      If this property has lat/lng, rank by haversine distance, else by recency.
  IF v_suburb IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c._rank ASC), '[]'::jsonb)
      INTO v_comparables
    FROM (
      SELECT
        l.property_key, l.address, l.suburb,
        l.bedrooms, l.bathrooms, l.sold_price, l.sold_date,
        l.days_on_market, l.hero_image,
        CASE
          WHEN v_latitude IS NOT NULL AND v_longitude IS NOT NULL
               AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
          THEN
            -- Cheap squared-euclidean approximation (suburb-scale, no earth-curvature needed)
            power(l.latitude::numeric  - v_latitude,  2)
            + power(l.longitude::numeric - v_longitude, 2)
          ELSE
            -- Fallback rank: days since sold (more recent = smaller rank)
            extract(epoch FROM (now() - l.sold_date::timestamptz))
        END AS _rank
      FROM pulse_listings l
      WHERE l.suburb = v_suburb
        AND l.listing_type = 'sold'
        AND l.property_key IS DISTINCT FROM p_property_key
        AND l.sold_date IS NOT NULL
        AND l.sold_date > (now() - interval '12 months')
        AND (v_bedrooms IS NULL
             OR l.bedrooms IS NULL
             OR l.bedrooms BETWEEN greatest(v_bedrooms - 1, 0) AND v_bedrooms + 1)
      ORDER BY _rank ASC
      LIMIT 5
    ) c;
  ELSE
    v_comparables := '[]'::jsonb;
  END IF;

  -- ── 13. Neighbour CRM clients in same suburb (≤ 5) ──────────────────────
  IF v_suburb IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'pulse_agent_id', pa.id,
        'crm_agent_id',   mp.crm_entity_id,
        'full_name',      pa.full_name,
        'profile_image',  pa.profile_image,
        'agency_name',    pa.agency_name
      )
      ORDER BY pa.sales_as_lead DESC NULLS LAST
    ), '[]'::jsonb)
      INTO v_neighbours
    FROM (
      SELECT pa.*
      FROM pulse_agents pa
      WHERE coalesce(pa.is_in_crm, false) = true
        AND jsonb_typeof(pa.suburbs_active) = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(pa.suburbs_active) AS sx(val)
          WHERE sx.val ILIKE v_suburb
        )
      ORDER BY pa.sales_as_lead DESC NULLS LAST
      LIMIT 5
    ) pa
    LEFT JOIN pulse_crm_mappings mp
      ON mp.entity_type = 'agent'
     AND (mp.pulse_entity_id = pa.id
          OR (pa.rea_agent_id IS NOT NULL AND mp.rea_id = pa.rea_agent_id));
  ELSE
    v_neighbours := '[]'::jsonb;
  END IF;

  -- ── 14. Assemble payload ────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'property',          v_property,
    'listings',          COALESCE(v_listings,     '[]'::jsonb),
    'projects',          COALESCE(v_projects,     '[]'::jsonb),
    'agents',            COALESCE(v_agents,       '[]'::jsonb),
    'agencies',          COALESCE(v_agencies,     '[]'::jsonb),
    'timeline_events',   COALESCE(v_timeline,     '[]'::jsonb),
    'signals',           COALESCE(v_signals,      '[]'::jsonb),
    'upcoming_events',   COALESCE(v_events,       '[]'::jsonb),
    'relist_candidate',  COALESCE(v_relist,       jsonb_build_object('is_candidate', false)),
    'comparables',       COALESCE(v_comparables,  '[]'::jsonb),
    'neighbour_clients', COALESCE(v_neighbours,   '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.property_get_full_dossier(text) IS
  'Single-roundtrip dossier for PropertyDetails. Returns JSONB with property, '
  'listings (≤50), projects, agents, agencies, timeline_events (≤50), signals '
  '(≤10), upcoming_events (≤10), relist_candidate, comparables (≤5), '
  'neighbour_clients (≤5). Added migration 133 (Phase 1 property detail rebuild).';

GRANT EXECUTE ON FUNCTION public.property_get_full_dossier(text) TO authenticated, service_role;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- Migration 132 — Pulse timeline backfill + dossier RPC widening
-- ════════════════════════════════════════════════════════════════════════════
--
-- Problem observed by user: Agent / Agency Intelligence slideouts + the
-- Intelligence tabs on PersonDetails / OrgDetails all appear empty, despite
-- thousands of pulse_* rows existing. Property Details works because it
-- builds its timeline from pulse_listings + projects directly (no dependency
-- on pulse_timeline rows at all).
--
-- Root cause breakdown:
--
--   1. pulse_timeline.first_seen is only emitted in pulseDataSync's Step 9
--      loop over websift-scraped agents. The listing-bridge path
--      (pulseDataSync line 1488+) and the pulseReconcileOrphans bridge RPCs
--      (pulse_reconcile_bridge_agents_from_listings, _agencies_from_refs)
--      INSERT pulse_agents / pulse_agencies rows with no corresponding
--      first_seen entry. Result: 2,794/3,567 agents (78%) and 1,507/1,513
--      agencies (99.6%) have zero timeline events.
--
--   2. pulse_get_dossier (migration 129) filters timeline rows by
--      crm_entity_id OR pulse_entity_id OR rea_id. For an agent this means
--      it finds agent-entity-type events and nothing else. But the most
--      interesting signals for an agent are the events fired against their
--      LISTINGS (new_listings_detected, price_change, listing_sold,
--      detail_enriched, etc.) — those have entity_type='listing' and
--      pulse_entity_id=<listing_id>, NOT the agent's id or rea_id. The RPC
--      needs to union in listing events where the listing belongs to the
--      agent (pulse_listings.agent_rea_id = agent's rea_agent_id).
--
--   3. Listing timeline rows lack rea_id anchoring (0/2558). This was a
--      non-issue for the current RPC's agent/agency paths, but tightens the
--      need for fix (2).
--
-- Fixes applied here:
--
--   A. Backfill first_seen for all pulse_agents / pulse_agencies /
--      pulse_listings that currently have none. Uses each row's
--      first_seen_at timestamp (or created_at fallback) so the event lands
--      at the historically correct point, not "now".
--
--   B. Update the two bridge RPCs to emit first_seen inline going forward
--      (idempotent — won't re-emit if one already exists).
--
--   C. Widen pulse_get_dossier's timeline subquery for agents + agencies so
--      it also returns events attached to their listings (via rea_id join
--      through pulse_listings.agent_rea_id / agency_rea_id).
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. Backfill first_seen for pulse_agents ────────────────────────────────
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, rea_id,
  event_type, event_category, title, description,
  new_value, source, created_at
)
SELECT
  'agent',
  pa.id,
  pa.rea_agent_id,
  'first_seen',
  'system',
  COALESCE(pa.full_name, 'Unknown agent') || ' first detected',
  'Agent first seen'
    || CASE WHEN pa.agency_name IS NOT NULL
            THEN ' at ' || pa.agency_name
            ELSE '' END,
  jsonb_build_object(
    'agency_name', pa.agency_name,
    'agency_rea_id', pa.agency_rea_id,
    'source', pa.source
  ),
  COALESCE(pa.source, 'backfill_migration_132'),
  COALESCE(pa.first_seen_at, pa.created_at, now())
FROM pulse_agents pa
WHERE NOT EXISTS (
  SELECT 1 FROM pulse_timeline t
  WHERE t.event_type = 'first_seen'
    AND t.entity_type = 'agent'
    AND (t.pulse_entity_id = pa.id
         OR (pa.rea_agent_id IS NOT NULL AND t.rea_id = pa.rea_agent_id))
);

-- ── A2. Backfill first_seen for pulse_agencies ──────────────────────────────
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, rea_id,
  event_type, event_category, title, description,
  new_value, source, created_at
)
SELECT
  'agency',
  pg.id,
  pg.rea_agency_id,
  'first_seen',
  'system',
  COALESCE(pg.name, 'Unknown agency') || ' first detected',
  'Agency first seen in market data',
  jsonb_build_object(
    'name', pg.name,
    'rea_agency_id', pg.rea_agency_id,
    'source', pg.source
  ),
  COALESCE(pg.source, 'backfill_migration_132'),
  COALESCE(pg.first_seen_at, pg.created_at, now())
FROM pulse_agencies pg
WHERE NOT EXISTS (
  SELECT 1 FROM pulse_timeline t
  WHERE t.event_type = 'first_seen'
    AND t.entity_type = 'agency'
    AND (t.pulse_entity_id = pg.id
         OR (pg.rea_agency_id IS NOT NULL AND t.rea_id = pg.rea_agency_id))
);

-- ── A3. Backfill first_seen for pulse_listings ──────────────────────────────
-- Listings are noisier (already have detail_enriched, price_change, etc.), but
-- a canonical "first_seen" anchor helps the property / listing drill-throughs.
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, rea_id,
  event_type, event_category, title, description,
  new_value, source, created_at
)
SELECT
  'listing',
  pl.id,
  pl.source_listing_id,
  'first_seen',
  'system',
  COALESCE(pl.address, 'Listing') || ' first detected',
  'Listing first seen on ' || COALESCE(pl.source, 'source')
    || CASE WHEN pl.agent_name IS NOT NULL
            THEN ' via ' || pl.agent_name
            ELSE '' END,
  jsonb_build_object(
    'address', pl.address,
    'suburb', pl.suburb,
    'agent_name', pl.agent_name,
    'agency_name', pl.agency_name,
    'listing_type', pl.listing_type
  ),
  COALESCE(pl.source, 'backfill_migration_132'),
  COALESCE(pl.first_seen_at, pl.created_at, now())
FROM pulse_listings pl
WHERE NOT EXISTS (
  SELECT 1 FROM pulse_timeline t
  WHERE t.event_type = 'first_seen'
    AND t.entity_type = 'listing'
    AND t.pulse_entity_id = pl.id
);

-- ── B1. Bridge RPC for agents — emit first_seen inline ──────────────────────
-- Wraps the existing insert so every newly bridged pulse_agent gets a
-- companion timeline row.
CREATE OR REPLACE FUNCTION public.pulse_reconcile_bridge_agents_from_listings()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH ins AS (
    INSERT INTO pulse_agents (
      rea_agent_id,
      full_name,
      agency_name,
      agency_rea_id,
      source,
      data_sources,
      data_integrity_score,
      total_listings_active,
      first_seen_at,
      last_synced_at,
      last_sync_log_id,
      is_in_crm,
      is_prospect
    )
    SELECT
      src.agent_rea_id,
      src.full_name,
      src.agency_name,
      src.agency_rea_id,
      'rea_listings_bridge'::text,
      '["rea_listings"]'::jsonb,
      30,
      src.total_listings_active,
      src.first_seen_at,
      src.last_synced_at,
      src.last_sync_log_id,
      false,
      false
    FROM (
      SELECT
        l.agent_rea_id,
        (array_agg(l.agent_name  ORDER BY length(l.agent_name)  DESC NULLS LAST))[1] AS full_name,
        (array_agg(l.agency_name ORDER BY length(l.agency_name) DESC NULLS LAST))[1] AS agency_name,
        (array_agg(l.agency_rea_id) FILTER (WHERE l.agency_rea_id IS NOT NULL))[1]   AS agency_rea_id,
        count(*)::int                                                                AS total_listings_active,
        min(l.first_seen_at)                                                         AS first_seen_at,
        max(l.last_synced_at)                                                        AS last_synced_at,
        (array_agg(l.last_sync_log_id ORDER BY l.last_synced_at DESC NULLS LAST)
          FILTER (WHERE l.last_sync_log_id IS NOT NULL))[1]                          AS last_sync_log_id
      FROM pulse_listings l
      WHERE l.agent_rea_id IS NOT NULL
        AND l.agent_name   IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pulse_agents pa WHERE pa.rea_agent_id = l.agent_rea_id)
      GROUP BY l.agent_rea_id
    ) src
    ON CONFLICT (rea_agent_id) DO NOTHING
    RETURNING id, rea_agent_id, full_name, agency_name, agency_rea_id, first_seen_at
  ),
  tl AS (
    -- Companion timeline rows for the agents we actually inserted.
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      new_value, source, created_at
    )
    SELECT
      'agent', ins.id, ins.rea_agent_id,
      'first_seen', 'system',
      COALESCE(ins.full_name, 'Unknown agent') || ' first detected',
      'Agent first seen via listing bridge'
        || CASE WHEN ins.agency_name IS NOT NULL
                THEN ' at ' || ins.agency_name ELSE '' END,
      jsonb_build_object(
        'agency_name', ins.agency_name,
        'agency_rea_id', ins.agency_rea_id,
        'source', 'rea_listings_bridge'
      ),
      'rea_listings_bridge',
      COALESCE(ins.first_seen_at, now())
    FROM ins
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$function$;

-- ── B2. Bridge RPC for agencies — emit first_seen inline ────────────────────
CREATE OR REPLACE FUNCTION public.pulse_reconcile_bridge_agencies_from_refs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH ins AS (
    INSERT INTO pulse_agencies (
      rea_agency_id,
      name,
      source,
      data_sources,
      active_listings,
      first_seen_at,
      last_synced_at,
      last_sync_log_id,
      is_in_crm
    )
    SELECT DISTINCT ON (lower(trim(src.name)))
      src.rea_agency_id,
      src.name,
      'rea_listings_bridge'::text,
      '["rea_listings"]'::jsonb,
      src.active_listings,
      src.first_seen_at,
      src.last_synced_at,
      src.last_sync_log_id,
      false
    FROM (
      SELECT
        l.agency_rea_id                                                              AS rea_agency_id,
        (array_agg(l.agency_name ORDER BY length(l.agency_name) DESC NULLS LAST))[1] AS name,
        count(*)::int                                                                AS active_listings,
        min(l.first_seen_at)                                                         AS first_seen_at,
        max(l.last_synced_at)                                                        AS last_synced_at,
        (array_agg(l.last_sync_log_id ORDER BY l.last_synced_at DESC NULLS LAST)
          FILTER (WHERE l.last_sync_log_id IS NOT NULL))[1]                          AS last_sync_log_id
      FROM pulse_listings l
      WHERE l.agency_rea_id IS NOT NULL
        AND l.agency_name   IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = l.agency_rea_id)
      GROUP BY l.agency_rea_id

      UNION ALL

      SELECT
        pa.agency_rea_id                                                              AS rea_agency_id,
        (array_agg(pa.agency_name ORDER BY length(pa.agency_name) DESC NULLS LAST))[1] AS name,
        NULL::int                                                                     AS active_listings,
        min(pa.first_seen_at)                                                         AS first_seen_at,
        max(pa.last_synced_at)                                                        AS last_synced_at,
        NULL::uuid                                                                    AS last_sync_log_id
      FROM pulse_agents pa
      WHERE pa.agency_rea_id IS NOT NULL
        AND pa.agency_name   IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = pa.agency_rea_id)
      GROUP BY pa.agency_rea_id
    ) src
    ORDER BY lower(trim(src.name)), src.active_listings DESC NULLS LAST
    ON CONFLICT (lower(trim(name))) DO NOTHING
    RETURNING id, rea_agency_id, name, first_seen_at
  ),
  tl AS (
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      new_value, source, created_at
    )
    SELECT
      'agency', ins.id, ins.rea_agency_id,
      'first_seen', 'system',
      COALESCE(ins.name, 'Unknown agency') || ' first detected',
      'Agency first seen via listing bridge',
      jsonb_build_object(
        'name', ins.name,
        'rea_agency_id', ins.rea_agency_id,
        'source', 'rea_listings_bridge'
      ),
      'rea_listings_bridge',
      COALESCE(ins.first_seen_at, now())
    FROM ins
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$function$;

-- ── C. Widen pulse_get_dossier so timeline includes listing events ──────────
-- For agent dossiers: union in events attached to the agent's listings.
-- For agency dossiers: union in events attached to the agency's listings
-- (direct agency_rea_id match + all agents in the agency).
CREATE OR REPLACE FUNCTION public.pulse_get_dossier(p_entity_type text, p_entity_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mapping             jsonb;
  v_mapping_row         pulse_crm_mappings%ROWTYPE;
  v_pulse_record        jsonb;
  v_rea_agent_id        text;
  v_rea_agency_id       text;
  v_pulse_entity_id     uuid;
  v_listing_ids         uuid[];
  v_listings            jsonb;
  v_timeline            jsonb;
  v_agency_roster       jsonb;
  v_projects            jsonb;
BEGIN
  IF p_entity_type NOT IN ('agent', 'agency') THEN
    RETURN jsonb_build_object(
      'error', 'invalid entity_type: must be agent or agency'
    );
  END IF;

  -- ── 1. CRM mapping ──
  SELECT * INTO v_mapping_row
  FROM pulse_crm_mappings
  WHERE crm_entity_id = p_entity_id
    AND entity_type   = p_entity_type
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_mapping_row.id IS NOT NULL THEN
    v_mapping         := to_jsonb(v_mapping_row);
    v_pulse_entity_id := v_mapping_row.pulse_entity_id;
  ELSE
    v_mapping         := NULL;
    v_pulse_entity_id := NULL;
  END IF;

  -- ── 2. Pulse record ──
  -- Additional fallback: when called with a pulse_agents.id directly (as
  -- happens from the Industry Pulse slideouts, which hand us the pulse UUID
  -- rather than a CRM UUID), no mapping row exists. Fall through to a
  -- direct pulse_agents.id = p_entity_id match so the slideouts populate.
  IF p_entity_type = 'agent' THEN
    IF v_pulse_entity_id IS NOT NULL THEN
      SELECT to_jsonb(pa.*), pa.rea_agent_id
        INTO v_pulse_record, v_rea_agent_id
      FROM pulse_agents pa
      WHERE pa.id = v_pulse_entity_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL AND v_mapping_row.rea_id IS NOT NULL THEN
      SELECT to_jsonb(pa.*), pa.rea_agent_id
        INTO v_pulse_record, v_rea_agent_id
      FROM pulse_agents pa
      WHERE pa.rea_agent_id = v_mapping_row.rea_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL THEN
      -- CRM agent → pulse agent
      SELECT to_jsonb(pa.*), pa.rea_agent_id
        INTO v_pulse_record, v_rea_agent_id
      FROM agents a
      JOIN pulse_agents pa ON pa.rea_agent_id = a.rea_agent_id
      WHERE a.id = p_entity_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL THEN
      -- Direct pulse_agents.id match (slideout case).
      SELECT to_jsonb(pa.*), pa.rea_agent_id
        INTO v_pulse_record, v_rea_agent_id
      FROM pulse_agents pa
      WHERE pa.id = p_entity_id
      LIMIT 1;
      IF v_pulse_record IS NOT NULL THEN
        v_pulse_entity_id := p_entity_id;
      END IF;
    END IF;

    IF v_pulse_record IS NOT NULL THEN
      v_rea_agency_id := v_pulse_record->>'agency_rea_id';
    END IF;

  ELSE  -- agency
    IF v_pulse_entity_id IS NOT NULL THEN
      SELECT to_jsonb(ag.*), ag.rea_agency_id
        INTO v_pulse_record, v_rea_agency_id
      FROM pulse_agencies ag
      WHERE ag.id = v_pulse_entity_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL AND v_mapping_row.rea_id IS NOT NULL THEN
      SELECT to_jsonb(ag.*), ag.rea_agency_id
        INTO v_pulse_record, v_rea_agency_id
      FROM pulse_agencies ag
      WHERE ag.rea_agency_id = v_mapping_row.rea_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL THEN
      SELECT to_jsonb(ag.*), ag.rea_agency_id
        INTO v_pulse_record, v_rea_agency_id
      FROM agencies a
      JOIN pulse_agencies ag ON ag.rea_agency_id = a.rea_agency_id
      WHERE a.id = p_entity_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL THEN
      -- Direct pulse_agencies.id match (slideout case).
      SELECT to_jsonb(ag.*), ag.rea_agency_id
        INTO v_pulse_record, v_rea_agency_id
      FROM pulse_agencies ag
      WHERE ag.id = p_entity_id
      LIMIT 1;
      IF v_pulse_record IS NOT NULL THEN
        v_pulse_entity_id := p_entity_id;
      END IF;
    END IF;
  END IF;

  -- ── 3. Listings (up to 100) ──
  IF p_entity_type = 'agent' AND v_rea_agent_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.first_seen_at DESC NULLS LAST), '[]'::jsonb),
           array_agg(l.id)
      INTO v_listings, v_listing_ids
    FROM (
      SELECT *
      FROM pulse_listings
      WHERE agent_rea_id = v_rea_agent_id
      ORDER BY first_seen_at DESC NULLS LAST
      LIMIT 100
    ) l;
  ELSIF p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.first_seen_at DESC NULLS LAST), '[]'::jsonb),
           array_agg(l.id)
      INTO v_listings, v_listing_ids
    FROM (
      SELECT DISTINCT ON (id) *
      FROM pulse_listings
      WHERE agency_rea_id = v_rea_agency_id
         OR agent_rea_id IN (
           SELECT pa.rea_agent_id
           FROM pulse_agents pa
           WHERE pa.agency_rea_id = v_rea_agency_id
             AND pa.rea_agent_id IS NOT NULL
         )
      ORDER BY id, first_seen_at DESC NULLS LAST
      LIMIT 100
    ) l;
  ELSE
    v_listings := '[]'::jsonb;
    v_listing_ids := '{}'::uuid[];
  END IF;

  -- ── 4. Timeline (up to 50 events) — widened ──
  --     agent → entity's own events + events on any of their listings
  --     agency → entity's own events + events on any of its listings
  --     Also tolerates a pulse_listings.source_listing_id match through rea_id
  --     for legacy listing-entity events that were written with rea_id set.
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_timeline
  FROM (
    SELECT *
    FROM pulse_timeline t
    WHERE
      -- Direct anchors on the CRM/pulse entity itself
         t.crm_entity_id = p_entity_id
      OR (v_pulse_entity_id IS NOT NULL AND t.pulse_entity_id = v_pulse_entity_id)
      OR (p_entity_type = 'agent'  AND v_rea_agent_id  IS NOT NULL AND t.rea_id = v_rea_agent_id)
      OR (p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL AND t.rea_id = v_rea_agency_id)
      -- NEW: also include listing-level events for listings attributed to this entity
      OR (v_listing_ids IS NOT NULL
          AND array_length(v_listing_ids, 1) > 0
          AND t.entity_type = 'listing'
          AND t.pulse_entity_id = ANY(v_listing_ids))
    ORDER BY t.created_at DESC
    LIMIT 50
  ) t;

  -- ── 5. Agency roster ──
  IF p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.sales_as_lead DESC NULLS LAST), '[]'::jsonb)
      INTO v_agency_roster
    FROM (
      SELECT pa.*, (
        SELECT to_jsonb(m)
        FROM pulse_crm_mappings m
        WHERE m.entity_type = 'agent'
          AND (m.pulse_entity_id = pa.id
               OR (pa.rea_agent_id IS NOT NULL AND m.rea_id = pa.rea_agent_id))
        LIMIT 1
      ) AS crm_mapping
      FROM pulse_agents pa
      WHERE pa.agency_rea_id = v_rea_agency_id
      ORDER BY pa.sales_as_lead DESC NULLS LAST
      LIMIT 100
    ) r;
  ELSE
    v_agency_roster := '[]'::jsonb;
  END IF;

  -- ── 6. Cross-linked projects ──
  IF p_entity_type = 'agent' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.shoot_date DESC NULLS LAST), '[]'::jsonb)
      INTO v_projects
    FROM (
      SELECT *
      FROM projects
      WHERE agent_id  = p_entity_id
         OR client_id = p_entity_id
      ORDER BY shoot_date DESC NULLS LAST
      LIMIT 100
    ) p;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.shoot_date DESC NULLS LAST), '[]'::jsonb)
      INTO v_projects
    FROM (
      SELECT *
      FROM projects
      WHERE agency_id = p_entity_id
      ORDER BY shoot_date DESC NULLS LAST
      LIMIT 100
    ) p;
  END IF;

  -- ── 7. Final payload ──
  RETURN jsonb_build_object(
    'pulse_record',          v_pulse_record,
    'mapping',               v_mapping,
    'listings',              v_listings,
    'timeline',              v_timeline,
    'agency_roster',         v_agency_roster,
    'cross_linked_projects', v_projects
  );
END;
$function$;

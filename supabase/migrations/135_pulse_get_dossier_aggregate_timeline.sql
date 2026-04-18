-- ════════════════════════════════════════════════════════════════════════════
-- Migration 135 — Pulse dossier RPC: fully aggregate timeline across levels
-- ════════════════════════════════════════════════════════════════════════════
--
-- Problem (user report 2026-04-18):
--   When viewing an agency dossier (e.g. "PACE Property Agents - GREENACRE")
--   the Intelligence Timeline only shows events directly tied to the agency
--   plus events on listings owned by the agency. It MISSES events fired
--   against the agents within that agency (first_seen rows, agency_change,
--   etc. — 18 agent-level events on PACE alone).
--
--   Migration 132 widened the RPC to include listing-level events for
--   agent/agency dossiers, but it did NOT union in agent-level events for
--   an agency dossier. So an agency dossier that should show "Agency X +
--   all its agents + all its listings" ends up showing "Agency X + all
--   its listings" with the agents invisible.
--
-- Measured before/after for PACE Property Agents - GREENACRE (ETKSSE):
--   BEFORE: timeline = 27 rows (1 agency + 26 listing)
--   AFTER:  timeline = 45 rows (1 agency + 18 agent + 26 listing)
--
-- Fixes applied here:
--   1. For entity_type='agency': union in events attached to any pulse_agent
--      in the agency (by pulse_entity_id or rea_id match on rea_agent_id).
--   2. For entity_type='agent': union in events attached to any pulse_listing
--      owned by that agent (already partially covered via v_listing_ids but
--      also allow rea_id = pl.source_listing_id legacy matches).
--   3. Bump the timeline LIMIT from 50 → 200 since the aggregated population
--      can be much larger.
--   4. Add a `timeline_summary` field to the return payload with total,
--      by_entity_type, by_category breakdowns. This lets the UI render
--      filter chips + counts without re-scanning the rows.
--
-- Everything else in the RPC is preserved exactly (pulse_record, listings,
-- agency_roster, cross_linked_projects).
-- ════════════════════════════════════════════════════════════════════════════

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
  v_listing_rea_ids     text[];
  v_agent_ids           uuid[];
  v_agent_rea_ids       text[];
  v_listings            jsonb;
  v_timeline            jsonb;
  v_timeline_summary    jsonb;
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
      SELECT to_jsonb(pa.*), pa.rea_agent_id
        INTO v_pulse_record, v_rea_agent_id
      FROM agents a
      JOIN pulse_agents pa ON pa.rea_agent_id = a.rea_agent_id
      WHERE a.id = p_entity_id
      LIMIT 1;
    END IF;

    IF v_pulse_record IS NULL THEN
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

  -- ── 3. Listings (up to 100) + collect listing ids/rea_ids for timeline ──
  IF p_entity_type = 'agent' AND v_rea_agent_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.first_seen_at DESC NULLS LAST), '[]'::jsonb),
           array_agg(l.id),
           array_agg(l.source_listing_id) FILTER (WHERE l.source_listing_id IS NOT NULL)
      INTO v_listings, v_listing_ids, v_listing_rea_ids
    FROM (
      SELECT *
      FROM pulse_listings
      WHERE agent_rea_id = v_rea_agent_id
      ORDER BY first_seen_at DESC NULLS LAST
      LIMIT 100
    ) l;
  ELSIF p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.first_seen_at DESC NULLS LAST), '[]'::jsonb),
           array_agg(l.id),
           array_agg(l.source_listing_id) FILTER (WHERE l.source_listing_id IS NOT NULL)
      INTO v_listings, v_listing_ids, v_listing_rea_ids
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
    v_listing_rea_ids := '{}'::text[];
  END IF;

  -- ── 3b. For agency dossiers: collect agent ids/rea_ids for timeline union ──
  IF p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL THEN
    SELECT array_agg(pa.id),
           array_agg(pa.rea_agent_id) FILTER (WHERE pa.rea_agent_id IS NOT NULL)
      INTO v_agent_ids, v_agent_rea_ids
    FROM pulse_agents pa
    WHERE pa.agency_rea_id = v_rea_agency_id;
  ELSE
    v_agent_ids := '{}'::uuid[];
    v_agent_rea_ids := '{}'::text[];
  END IF;

  -- ── 4. Timeline (up to 200 events) — fully aggregated ──
  --     agent  → own events + events on their listings
  --     agency → own events + events on all their agents + events on all their listings
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_timeline
  FROM (
    SELECT DISTINCT ON (id) *
    FROM pulse_timeline t
    WHERE
      -- Direct anchors on the CRM/pulse entity itself
         t.crm_entity_id = p_entity_id
      OR (v_pulse_entity_id IS NOT NULL AND t.pulse_entity_id = v_pulse_entity_id)
      OR (p_entity_type = 'agent'  AND v_rea_agent_id  IS NOT NULL AND t.rea_id = v_rea_agent_id)
      OR (p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL AND t.rea_id = v_rea_agency_id)
      -- Listing-level events for listings under this entity
      OR (v_listing_ids IS NOT NULL
          AND array_length(v_listing_ids, 1) > 0
          AND t.pulse_entity_id = ANY(v_listing_ids))
      OR (v_listing_rea_ids IS NOT NULL
          AND array_length(v_listing_rea_ids, 1) > 0
          AND t.entity_type = 'listing'
          AND t.rea_id = ANY(v_listing_rea_ids))
      -- NEW (135): Agent-level events for agents at this agency
      OR (p_entity_type = 'agency'
          AND v_agent_ids IS NOT NULL
          AND array_length(v_agent_ids, 1) > 0
          AND t.pulse_entity_id = ANY(v_agent_ids))
      OR (p_entity_type = 'agency'
          AND v_agent_rea_ids IS NOT NULL
          AND array_length(v_agent_rea_ids, 1) > 0
          AND t.entity_type = 'agent'
          AND t.rea_id = ANY(v_agent_rea_ids))
    ORDER BY id, t.created_at DESC
    LIMIT 200
  ) t;

  -- ── 4b. Timeline summary — total + by_entity_type + by_category ──
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_array_elements(v_timeline)),
    'by_entity_type', COALESCE((
      SELECT jsonb_object_agg(et, cnt)
      FROM (
        SELECT elem->>'entity_type' AS et, count(*)::int AS cnt
        FROM jsonb_array_elements(v_timeline) elem
        WHERE elem->>'entity_type' IS NOT NULL
        GROUP BY elem->>'entity_type'
      ) x
    ), '{}'::jsonb),
    'by_category', COALESCE((
      SELECT jsonb_object_agg(cat, cnt)
      FROM (
        SELECT elem->>'event_category' AS cat, count(*)::int AS cnt
        FROM jsonb_array_elements(v_timeline) elem
        WHERE elem->>'event_category' IS NOT NULL
        GROUP BY elem->>'event_category'
      ) x
    ), '{}'::jsonb)
  ) INTO v_timeline_summary;

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
    'timeline_summary',      v_timeline_summary,
    'agency_roster',         v_agency_roster,
    'cross_linked_projects', v_projects
  );
END;
$function$;

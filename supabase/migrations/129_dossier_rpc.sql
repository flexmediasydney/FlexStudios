-- 129_dossier_rpc.sql
-- Migration 129 — pulse_get_dossier RPC for PulseIntelligencePanel
--
-- ── Problem ───────────────────────────────────────────────────────────────
-- PulseIntelligencePanel currently loads:
--   - pulse_crm_mappings (ALL rows)
--   - pulse_agents (up to 5,000)
--   - pulse_agencies (up to 500)
--   - pulse_listings (up to 5,000)
--   - pulse_timeline (up to 500)
--   - projects (all)
-- …just to render one agent/agency dossier. That's six separate client-side
-- queries pulling >10k rows to find maybe 30 that matter for the panel.
--
-- ── Fix ───────────────────────────────────────────────────────────────────
-- A single server-side RPC that returns one JSONB blob with:
--   - pulse_record          : full pulse_agents or pulse_agencies row
--   - mapping               : matching pulse_crm_mappings row
--   - listings              : up to 100 related listings
--   - timeline              : up to 50 timeline events scoped to this entity
--   - agency_roster         : for entityType=agency, up to 100 pulse_agents
--   - cross_linked_projects : projects joined on agent_id / client_id / agency_id
--
-- All filters happen server-side using existing indexes on rea_agent_id /
-- rea_agency_id (migration 092), crm_entity_id on pulse_crm_mappings, and
-- the existing btree on pulse_timeline. One round-trip, one JSONB payload.
--
-- Query-count impact on the "open dossier" interaction:
--   Before : 6 useEntityList selects (>10,000 rows downloaded client-side)
--   After  : 1 RPC (≤280 rows returned, all scoped to the entity)

BEGIN;

CREATE OR REPLACE FUNCTION public.pulse_get_dossier(
  p_entity_type text,
  p_entity_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_mapping             jsonb;
  v_mapping_row         pulse_crm_mappings%ROWTYPE;
  v_pulse_record        jsonb;
  v_rea_agent_id        text;
  v_rea_agency_id       text;
  v_pulse_entity_id     uuid;
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

  -- ── 1. Find the CRM mapping for this entity ─────────────────────────────
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

  -- ── 2. Find the pulse record (agent or agency) ──────────────────────────
  --     Preference order:
  --       a) mapping.pulse_entity_id → direct id match
  --       b) mapping.rea_id          → rea_agent_id / rea_agency_id match
  --       c) CRM row's rea_agent_id / rea_agency_id field (fallback)
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
      -- Last-resort: pull rea_agent_id from the CRM agent row itself.
      SELECT to_jsonb(pa.*), pa.rea_agent_id
        INTO v_pulse_record, v_rea_agent_id
      FROM agents a
      JOIN pulse_agents pa ON pa.rea_agent_id = a.rea_agent_id
      WHERE a.id = p_entity_id
      LIMIT 1;
    END IF;

    -- Agency REA ID of the agent, used for agent→agency lookups elsewhere.
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
  END IF;

  -- ── 3. Listings (up to 100), scoped by REA id(s) ────────────────────────
  --     agent → agent_rea_id match
  --     agency → agency_rea_id match (OR agents-in-that-agency's listings)
  IF p_entity_type = 'agent' AND v_rea_agent_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.first_seen_at DESC NULLS LAST), '[]'::jsonb)
      INTO v_listings
    FROM (
      SELECT *
      FROM pulse_listings
      WHERE agent_rea_id = v_rea_agent_id
      ORDER BY first_seen_at DESC NULLS LAST
      LIMIT 100
    ) l;
  ELSIF p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.first_seen_at DESC NULLS LAST), '[]'::jsonb)
      INTO v_listings
    FROM (
      -- Direct agency match + agents-in-this-agency match (union)
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
  END IF;

  -- ── 4. Timeline (up to 50 events) scoped to this entity ─────────────────
  --     Match on crm_entity_id OR pulse_entity_id OR rea_id (as text).
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_timeline
  FROM (
    SELECT *
    FROM pulse_timeline t
    WHERE t.crm_entity_id = p_entity_id
       OR (v_pulse_entity_id IS NOT NULL AND t.pulse_entity_id = v_pulse_entity_id)
       OR (p_entity_type = 'agent'  AND v_rea_agent_id  IS NOT NULL AND t.rea_id = v_rea_agent_id)
       OR (p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL AND t.rea_id = v_rea_agency_id)
    ORDER BY t.created_at DESC
    LIMIT 50
  ) t;

  -- ── 5. Agency roster (up to 100 pulse_agents) — agency-only ─────────────
  IF p_entity_type = 'agency' AND v_rea_agency_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.sales_as_lead DESC NULLS LAST), '[]'::jsonb)
      INTO v_agency_roster
    FROM (
      SELECT pa.*, (
        -- Attach the CRM mapping row (if any) so the UI can show the green
        -- "CRM" chip + link through without a second query.
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

  -- ── 6. Cross-linked projects ────────────────────────────────────────────
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

  -- ── 7. Final payload ────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'pulse_record',          v_pulse_record,
    'mapping',               v_mapping,
    'listings',              v_listings,
    'timeline',              v_timeline,
    'agency_roster',         v_agency_roster,
    'cross_linked_projects', v_projects
  );
END;
$$;

COMMENT ON FUNCTION public.pulse_get_dossier(text, uuid) IS
  'Single-roundtrip dossier fetch for PulseIntelligencePanel. Returns JSONB with pulse_record, mapping, listings (≤100), timeline (≤50), agency_roster (≤100, agency only), and cross_linked_projects (≤100). Replaces 6 client-side useEntityList calls that were downloading >10k rows. Added migration 129.';

GRANT EXECUTE ON FUNCTION public.pulse_get_dossier(text, uuid) TO authenticated, anon, service_role;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 349: Atomic "Add to CRM" RPCs for Industry Pulse
-- ═══════════════════════════════════════════════════════════════════════════
-- The previous PulseAgentIntel/PulseAgencyIntel "Add to CRM" flow ran four
-- sequential awaited writes from the client (create Agency / create Agent /
-- create mapping / flip is_in_crm). When any write failed mid-sequence
-- (today's outage was a vivid example) the user got partial state — agent
-- created without mapping, mapping created without is_in_crm flip, etc.
--
-- These two RPCs collapse the whole flow into a single PL/pgSQL function =
-- single transaction. Either everything commits, or nothing does.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. pulse_add_agent_to_crm — create CRM Agent + mapping + flip is_in_crm
-- ───────────────────────────────────────────────────────────────────────────
-- Caller passes:
--   p_pulse_agent_id         the pulse_agents.id we're claiming
--   p_agent_payload          jsonb of fields for the new CRM agent
--                            (name is required; phone/email/title/etc. optional)
--   p_existing_agency_id     when the dialog matched the pulse agent's agency
--                            against an existing CRM agency, pass its id
--   p_new_agency_payload     OR pass jsonb to create a new agency in the same
--                            transaction (name required; rea_agency_id etc.
--                            optional). Mutually exclusive with the above.
--
-- Returns: { agent_id, agency_id, mapping_id }
CREATE OR REPLACE FUNCTION pulse_add_agent_to_crm(
  p_pulse_agent_id        uuid,
  p_agent_payload         jsonb,
  p_existing_agency_id    uuid    DEFAULT NULL,
  p_new_agency_payload    jsonb   DEFAULT NULL
)
RETURNS TABLE (agent_id uuid, agency_id uuid, mapping_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_agency_id  uuid;
  v_agent_id   uuid;
  v_mapping_id uuid;
  v_rea_id     text;
BEGIN
  IF p_pulse_agent_id IS NULL THEN
    RAISE EXCEPTION 'pulse_add_agent_to_crm: p_pulse_agent_id is required';
  END IF;
  IF p_agent_payload IS NULL OR (p_agent_payload->>'name') IS NULL THEN
    RAISE EXCEPTION 'pulse_add_agent_to_crm: p_agent_payload.name is required';
  END IF;

  -- Resolve agency: prefer explicit existing_agency_id, else create one.
  IF p_existing_agency_id IS NOT NULL THEN
    v_agency_id := p_existing_agency_id;
  ELSIF p_new_agency_payload IS NOT NULL
    AND (p_new_agency_payload->>'name') IS NOT NULL THEN
    INSERT INTO agencies (
      name, phone, email, website, rea_agency_id, source
    ) VALUES (
      p_new_agency_payload->>'name',
      p_new_agency_payload->>'phone',
      p_new_agency_payload->>'email',
      p_new_agency_payload->>'website',
      p_new_agency_payload->>'rea_agency_id',
      COALESCE(p_new_agency_payload->>'source', 'pulse')
    )
    RETURNING id INTO v_agency_id;
  END IF;
  -- v_agency_id may legitimately remain NULL if the pulse agent has no agency.

  -- Create the CRM agent.
  INSERT INTO agents (
    name,
    phone,
    email,
    current_agency_id,
    rea_agent_id,
    title,
    relationship_state,
    source
  ) VALUES (
    p_agent_payload->>'name',
    p_agent_payload->>'phone',
    p_agent_payload->>'email',
    v_agency_id,
    p_agent_payload->>'rea_agent_id',
    p_agent_payload->>'title',
    COALESCE(p_agent_payload->>'relationship_state', 'prospect'),
    COALESCE(p_agent_payload->>'source', 'pulse')
  )
  RETURNING id INTO v_agent_id;

  -- Resolve the rea_id we'll persist on the mapping (prefer payload, fallback
  -- to the pulse_agents row).
  v_rea_id := p_agent_payload->>'rea_agent_id';
  IF v_rea_id IS NULL THEN
    SELECT rea_agent_id INTO v_rea_id FROM pulse_agents WHERE id = p_pulse_agent_id;
  END IF;

  -- Drop any prior dismissal sentinel for this CRM agent.
  DELETE FROM pulse_crm_mappings
   WHERE entity_type = 'agent'
     AND crm_entity_id = v_agent_id
     AND match_type = 'no_link';

  -- Insert the mapping.
  INSERT INTO pulse_crm_mappings (
    entity_type, pulse_entity_id, rea_id, crm_entity_id,
    match_type, confidence, confirmed_at, created_at, updated_at
  ) VALUES (
    'agent', p_pulse_agent_id, v_rea_id, v_agent_id,
    'manual', 'confirmed', now(), now(), now()
  )
  RETURNING id INTO v_mapping_id;

  -- Flip is_in_crm + write linked_agent_id back-pointer for symmetry with
  -- the CRM-side linker (migration 348).
  UPDATE pulse_agents
     SET is_in_crm       = true,
         linked_agent_id = v_agent_id,
         updated_at      = now()
   WHERE id = p_pulse_agent_id;

  RETURN QUERY SELECT v_agent_id, v_agency_id, v_mapping_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_add_agent_to_crm(uuid, jsonb, uuid, jsonb) TO authenticated;
COMMENT ON FUNCTION pulse_add_agent_to_crm IS
  'Atomically promote a pulse_agents row into the CRM: create/find Agency, create CRM Agent, insert pulse_crm_mappings row, flip is_in_crm + linked_agent_id. Single transaction — no partial-state on failure.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. pulse_add_agency_to_crm — create CRM Agency + mapping + flip is_in_crm
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pulse_add_agency_to_crm(
  p_pulse_agency_id uuid,
  p_agency_payload  jsonb
)
RETURNS TABLE (agency_id uuid, mapping_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_agency_id  uuid;
  v_mapping_id uuid;
  v_rea_id     text;
BEGIN
  IF p_pulse_agency_id IS NULL THEN
    RAISE EXCEPTION 'pulse_add_agency_to_crm: p_pulse_agency_id is required';
  END IF;
  IF p_agency_payload IS NULL OR (p_agency_payload->>'name') IS NULL THEN
    RAISE EXCEPTION 'pulse_add_agency_to_crm: p_agency_payload.name is required';
  END IF;

  INSERT INTO agencies (
    name, phone, email, website, rea_agency_id, source, relationship_state
  ) VALUES (
    p_agency_payload->>'name',
    p_agency_payload->>'phone',
    p_agency_payload->>'email',
    p_agency_payload->>'website',
    p_agency_payload->>'rea_agency_id',
    COALESCE(p_agency_payload->>'source', 'pulse'),
    COALESCE(p_agency_payload->>'relationship_state', 'Prospecting')
  )
  RETURNING id INTO v_agency_id;

  v_rea_id := p_agency_payload->>'rea_agency_id';
  IF v_rea_id IS NULL THEN
    SELECT rea_agency_id INTO v_rea_id FROM pulse_agencies WHERE id = p_pulse_agency_id;
  END IF;

  DELETE FROM pulse_crm_mappings
   WHERE entity_type = 'agency'
     AND crm_entity_id = v_agency_id
     AND match_type = 'no_link';

  INSERT INTO pulse_crm_mappings (
    entity_type, pulse_entity_id, rea_id, crm_entity_id,
    match_type, confidence, confirmed_at, created_at, updated_at
  ) VALUES (
    'agency', p_pulse_agency_id, v_rea_id, v_agency_id,
    'manual', 'confirmed', now(), now(), now()
  )
  RETURNING id INTO v_mapping_id;

  UPDATE pulse_agencies
     SET is_in_crm        = true,
         linked_agency_id = v_agency_id,
         updated_at       = now()
   WHERE id = p_pulse_agency_id;

  RETURN QUERY SELECT v_agency_id, v_mapping_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_add_agency_to_crm(uuid, jsonb) TO authenticated;
COMMENT ON FUNCTION pulse_add_agency_to_crm IS
  'Atomically promote a pulse_agencies row into the CRM: create CRM Agency, insert pulse_crm_mappings row, flip is_in_crm + linked_agency_id. Single transaction.';

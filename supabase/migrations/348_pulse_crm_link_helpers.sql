-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 348: CRM → Pulse linking helpers
-- ═══════════════════════════════════════════════════════════════════════════
-- Backs the always-visible "Industry Pulse link" card on PersonDetails and
-- OrgDetails. Lets a CRM user start from a CRM agent/agency and link it to
-- the corresponding pulse record (or dismiss the suggestion). Reuses the
-- existing pulse_linkage_name_score() ensemble from migration 191, then
-- boosts for matching email/phone/rea_id signals.
--
-- ───────────────────────────────────────────────────────────────────────────
-- 1. pulse_suggest_crm_links — top-N candidate pulse rows for a CRM record
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pulse_suggest_crm_links(
  p_entity_type text,
  p_crm_id      uuid,
  p_limit       int DEFAULT 5
)
RETURNS TABLE (
  pulse_id          uuid,
  pulse_name        text,
  pulse_rea_id      text,
  pulse_email       text,
  pulse_phone       text,
  pulse_agency_name text,
  score             numeric,
  match_reasons     text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_crm_name   text;
  v_crm_email  text;
  v_crm_phone  text;
  v_crm_rea_id text;
BEGIN
  IF p_entity_type NOT IN ('agent','agency') THEN
    RAISE EXCEPTION 'pulse_suggest_crm_links: invalid entity_type %', p_entity_type;
  END IF;

  IF p_entity_type = 'agent' THEN
    SELECT a.name, a.email, a.phone, a.rea_agent_id
      INTO v_crm_name, v_crm_email, v_crm_phone, v_crm_rea_id
    FROM agents a WHERE a.id = p_crm_id;
  ELSE
    SELECT a.name, a.email, a.phone, a.rea_agency_id
      INTO v_crm_name, v_crm_email, v_crm_phone, v_crm_rea_id
    FROM agencies a WHERE a.id = p_crm_id;
  END IF;

  IF v_crm_name IS NULL THEN
    RETURN;
  END IF;

  IF p_entity_type = 'agent' THEN
    RETURN QUERY
    WITH scored AS (
      SELECT
        pa.id                              AS pulse_id,
        pa.full_name                       AS pulse_name,
        pa.rea_agent_id                    AS pulse_rea_id,
        pa.email                           AS pulse_email,
        COALESCE(pa.business_phone, '')    AS pulse_phone,
        pa.agency_name                     AS pulse_agency_name,
        pulse_linkage_name_score(v_crm_name, pa.full_name)        AS name_score,
        (v_crm_email IS NOT NULL AND pa.email IS NOT NULL
         AND lower(btrim(v_crm_email)) = lower(btrim(pa.email)))  AS email_match,
        (v_crm_phone IS NOT NULL AND pa.business_phone IS NOT NULL
         AND regexp_replace(v_crm_phone, '\D', '', 'g')
           = regexp_replace(pa.business_phone, '\D', '', 'g'))    AS phone_match,
        (v_crm_rea_id IS NOT NULL AND pa.rea_agent_id IS NOT NULL
         AND v_crm_rea_id = pa.rea_agent_id)                      AS rea_match
      FROM pulse_agents pa
      WHERE pa.linked_agent_id IS NULL  -- skip already-linked
    )
    SELECT
      s.pulse_id,
      s.pulse_name,
      s.pulse_rea_id,
      s.pulse_email,
      s.pulse_phone,
      s.pulse_agency_name,
      LEAST(1.0,
        s.name_score
        + CASE WHEN s.rea_match   THEN 0.50 ELSE 0 END
        + CASE WHEN s.email_match THEN 0.20 ELSE 0 END
        + CASE WHEN s.phone_match THEN 0.15 ELSE 0 END
      ) AS score,
      ARRAY(
        SELECT r FROM (VALUES
          (CASE WHEN s.rea_match    THEN 'rea_id'    END),
          (CASE WHEN s.email_match  THEN 'email'     END),
          (CASE WHEN s.phone_match  THEN 'phone'     END),
          (CASE WHEN s.name_score >= 0.7 THEN 'name' END)
        ) v(r) WHERE r IS NOT NULL
      ) AS match_reasons
    FROM scored s
    WHERE s.name_score > 0.2 OR s.rea_match OR s.email_match OR s.phone_match
    ORDER BY score DESC
    LIMIT p_limit;
  ELSE
    -- entity_type = 'agency'
    RETURN QUERY
    WITH scored AS (
      SELECT
        pa.id                              AS pulse_id,
        pa.name                            AS pulse_name,
        pa.rea_agency_id                   AS pulse_rea_id,
        NULL::text                         AS pulse_email,
        NULL::text                         AS pulse_phone,
        NULL::text                         AS pulse_agency_name,
        pulse_linkage_name_score(v_crm_name, pa.name)             AS name_score,
        (v_crm_rea_id IS NOT NULL AND pa.rea_agency_id IS NOT NULL
         AND v_crm_rea_id = pa.rea_agency_id)                     AS rea_match
      FROM pulse_agencies pa
      WHERE pa.linked_agency_id IS NULL
    )
    SELECT
      s.pulse_id,
      s.pulse_name,
      s.pulse_rea_id,
      s.pulse_email,
      s.pulse_phone,
      s.pulse_agency_name,
      LEAST(1.0,
        s.name_score
        + CASE WHEN s.rea_match THEN 0.50 ELSE 0 END
      ) AS score,
      ARRAY(
        SELECT r FROM (VALUES
          (CASE WHEN s.rea_match           THEN 'rea_id' END),
          (CASE WHEN s.name_score >= 0.7   THEN 'name'   END)
        ) v(r) WHERE r IS NOT NULL
      ) AS match_reasons
    FROM scored s
    WHERE s.name_score > 0.2 OR s.rea_match
    ORDER BY score DESC
    LIMIT p_limit;
  END IF;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_suggest_crm_links(text, uuid, int) TO authenticated;
COMMENT ON FUNCTION pulse_suggest_crm_links IS
  'Top-N pulse_agents/agencies candidates for a given CRM record, ranked by name ensemble + email/phone/rea_id boosters. Used by PulseLinkCard on PersonDetails / OrgDetails.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. pulse_apply_crm_link — atomically link a CRM record to a pulse record
-- ───────────────────────────────────────────────────────────────────────────
-- Single transaction: writes pulse_*.linked_*_id, sets is_in_crm=true,
-- upserts pulse_crm_mappings (match_type='manual_from_crm', confirmed),
-- deletes any prior 'no_link' sentinel for this CRM record. Returns the
-- mapping row.
CREATE OR REPLACE FUNCTION pulse_apply_crm_link(
  p_entity_type text,
  p_crm_id      uuid,
  p_pulse_id    uuid
)
RETURNS TABLE (mapping_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rea_id     text;
  v_mapping_id uuid;
BEGIN
  IF p_entity_type NOT IN ('agent','agency') THEN
    RAISE EXCEPTION 'pulse_apply_crm_link: invalid entity_type %', p_entity_type;
  END IF;

  -- Drop any prior dismissal sentinel for this CRM record.
  DELETE FROM pulse_crm_mappings
   WHERE entity_type = p_entity_type
     AND crm_entity_id = p_crm_id
     AND match_type = 'no_link';

  IF p_entity_type = 'agent' THEN
    SELECT rea_agent_id INTO v_rea_id FROM pulse_agents WHERE id = p_pulse_id;
    UPDATE pulse_agents
       SET linked_agent_id = p_crm_id,
           is_in_crm = true,
           updated_at = now()
     WHERE id = p_pulse_id;
  ELSE
    SELECT rea_agency_id INTO v_rea_id FROM pulse_agencies WHERE id = p_pulse_id;
    UPDATE pulse_agencies
       SET linked_agency_id = p_crm_id,
           is_in_crm = true,
           updated_at = now()
     WHERE id = p_pulse_id;
  END IF;

  -- Upsert the mapping row. One mapping per (entity_type, crm_entity_id).
  -- Update-then-insert pattern (no ON CONFLICT — no unique index assumed).
  UPDATE pulse_crm_mappings
     SET pulse_entity_id = p_pulse_id,
         rea_id          = COALESCE(v_rea_id, rea_id),
         match_type      = 'manual_from_crm',
         confidence      = 'confirmed',
         confirmed_at    = now(),
         updated_at      = now()
   WHERE entity_type = p_entity_type
     AND crm_entity_id = p_crm_id
   RETURNING id INTO v_mapping_id;

  IF v_mapping_id IS NULL THEN
    INSERT INTO pulse_crm_mappings (
      entity_type, pulse_entity_id, rea_id, crm_entity_id,
      match_type, confidence, confirmed_at, created_at, updated_at
    ) VALUES (
      p_entity_type, p_pulse_id, v_rea_id, p_crm_id,
      'manual_from_crm', 'confirmed', now(), now(), now()
    )
    RETURNING id INTO v_mapping_id;
  END IF;

  RETURN QUERY SELECT v_mapping_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_apply_crm_link(text, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION pulse_apply_crm_link IS
  'Atomically link a CRM agent/agency to a pulse record. Writes pulse_*.linked_*_id, flips is_in_crm, upserts pulse_crm_mappings, clears any dismissal sentinel.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. pulse_unlink_crm — inverse of apply
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pulse_unlink_crm(
  p_entity_type text,
  p_crm_id      uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_entity_type NOT IN ('agent','agency') THEN
    RAISE EXCEPTION 'pulse_unlink_crm: invalid entity_type %', p_entity_type;
  END IF;

  IF p_entity_type = 'agent' THEN
    UPDATE pulse_agents
       SET linked_agent_id = NULL,
           is_in_crm = false,
           updated_at = now()
     WHERE linked_agent_id = p_crm_id;
  ELSE
    UPDATE pulse_agencies
       SET linked_agency_id = NULL,
           is_in_crm = false,
           updated_at = now()
     WHERE linked_agency_id = p_crm_id;
  END IF;

  DELETE FROM pulse_crm_mappings
   WHERE entity_type = p_entity_type
     AND crm_entity_id = p_crm_id
     AND match_type <> 'no_link';
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_unlink_crm(text, uuid) TO authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. pulse_dismiss_crm_link / pulse_undismiss_crm_link — sentinel rows
-- ───────────────────────────────────────────────────────────────────────────
-- "Not in Industry Pulse" — record a sentinel mapping with no pulse_entity_id
-- so the suggestion card can suppress itself. Undo restores it.
CREATE OR REPLACE FUNCTION pulse_dismiss_crm_link(
  p_entity_type text,
  p_crm_id      uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_entity_type NOT IN ('agent','agency') THEN
    RAISE EXCEPTION 'pulse_dismiss_crm_link: invalid entity_type %', p_entity_type;
  END IF;

  -- Only allowed when not actively linked.
  IF EXISTS (
    SELECT 1 FROM pulse_crm_mappings
     WHERE entity_type = p_entity_type
       AND crm_entity_id = p_crm_id
       AND pulse_entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'pulse_dismiss_crm_link: CRM record % already linked to a pulse row', p_crm_id;
  END IF;

  INSERT INTO pulse_crm_mappings (
    entity_type, pulse_entity_id, crm_entity_id,
    match_type, confidence, created_at, updated_at
  ) VALUES (
    p_entity_type, NULL, p_crm_id,
    'no_link', 'dismissed', now(), now()
  )
  ON CONFLICT DO NOTHING;
END;
$fn$;

CREATE OR REPLACE FUNCTION pulse_undismiss_crm_link(
  p_entity_type text,
  p_crm_id      uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  DELETE FROM pulse_crm_mappings
   WHERE entity_type = p_entity_type
     AND crm_entity_id = p_crm_id
     AND match_type = 'no_link';
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_dismiss_crm_link(text, uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_undismiss_crm_link(text, uuid) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 350: Cross-table SAFR via Pulse↔CRM link
-- ═══════════════════════════════════════════════════════════════════════════
-- Today SAFR runs on Pulse and CRM as two independent ledgers:
--   ('agent',  pulse_agents.id)    →  pulse_agents columns
--   ('contact', agents.id)         →  agents columns
-- Migration 178 already maps both sides. Migration 179 backfilled CRM
-- column values as source='manual' confidence=1.0 observations. What's
-- missing is the bridge — when a pulse record is linked to a CRM record,
-- their observations should flow into a shared logical pool so:
--
--   • At link time:   Pulse data populates the CRM columns (Pulse wins
--                     because its observations are typically newer than
--                     the seeded manual=1.0 baseline).
--   • Manual edits:   PersonDetails/OrgDetails saves trigger SAFR with
--                     source='manual' conf=1.0 → highest priority. Pulse
--                     scraper updates can't overwrite the operator.
--   • Scraper updates: continue to flow through SAFR, mirror to BOTH
--                     pulse_* and CRM tables when linked.
--   • Unlink:         dual-write stops. Each side keeps its current
--                     snapshot. Future observations stay on their own
--                     ledger.
--
-- Implementation:
--   1. Trigger on entity_field_sources (INSERT/UPDATE) — when an
--      observation lands on one side, mirror it to the linked side.
--   2. Trigger on agents/agencies (UPDATE) — when CRM columns change
--      via direct UPDATE, record a 'manual' observation (depth-guarded).
--   3. pulse_apply_crm_link / pulse_unlink_crm — replay existing pulse
--      observations to CRM ledger at link time so the mirror happens
--      immediately (not just on the next observation event).
--   4. pulse_preview_link_changes — the UI's "what will change" query.
--
-- Recursion safety: every trigger guards on pg_trigger_depth() to prevent
-- the cross-mirror from firing recursively when record_field_observation
-- writes to entity_field_sources, or when safr_mirror_to_legacy writes
-- to the agents/agencies columns.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. safr_cross_mirror_observation — the bridge trigger
-- ───────────────────────────────────────────────────────────────────────────
-- After an observation lands on one ledger, if a link exists, copy it to
-- the linked counterpart's ledger. Only fields present in BOTH legacy maps
-- get mirrored (e.g. agency.website has no organization equivalent → skip).
CREATE OR REPLACE FUNCTION safr_cross_mirror_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_other_type text;
  v_other_id   uuid;
BEGIN
  -- Recursion guard. Depth 1 = direct INSERT/UPDATE on entity_field_sources.
  -- Depth ≥ 2 = a re-entrant trigger (e.g. record_field_observation called
  -- by us). We only want to mirror at depth 1.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Resolve the linked counterpart (if any).
  IF NEW.entity_type = 'agent' THEN
    SELECT 'contact', linked_agent_id
      INTO v_other_type, v_other_id
    FROM pulse_agents
    WHERE id = NEW.entity_id;
  ELSIF NEW.entity_type = 'contact' THEN
    SELECT 'agent', id
      INTO v_other_type, v_other_id
    FROM pulse_agents
    WHERE linked_agent_id = NEW.entity_id;
  ELSIF NEW.entity_type = 'agency' THEN
    SELECT 'organization', linked_agency_id
      INTO v_other_type, v_other_id
    FROM pulse_agencies
    WHERE id = NEW.entity_id;
  ELSIF NEW.entity_type = 'organization' THEN
    SELECT 'agency', id
      INTO v_other_type, v_other_id
    FROM pulse_agencies
    WHERE linked_agency_id = NEW.entity_id;
  ELSE
    RETURN NEW;
  END IF;

  IF v_other_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip fields that don't have a counterpart map row (e.g. agency.website
  -- has no organization equivalent — no point recording an organization
  -- observation that can't mirror to a column).
  IF NOT EXISTS (
    SELECT 1 FROM safr_legacy_field_map
    WHERE entity_type = v_other_type AND field_name = NEW.field_name
  ) THEN
    RETURN NEW;
  END IF;

  -- Mirror by replaying the observation. record_field_observation handles
  -- the dedup (UNIQUE on entity/field/value/source) and resolver, so this
  -- is idempotent.
  PERFORM record_field_observation(
    v_other_type,
    v_other_id,
    NEW.field_name,
    NEW.value_display,
    NEW.source,
    NEW.source_ref_type,
    NEW.source_ref_id,
    NEW.confidence,
    NEW.observed_at
  );

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS safr_cross_mirror_trg ON entity_field_sources;
CREATE TRIGGER safr_cross_mirror_trg
AFTER INSERT OR UPDATE OF value_normalized, value_display, status, confidence
ON entity_field_sources
FOR EACH ROW
WHEN (NEW.status IN ('active', 'promoted'))
EXECUTE FUNCTION safr_cross_mirror_observation();

COMMENT ON FUNCTION safr_cross_mirror_observation IS
  'Mirrors entity_field_sources observations across the Pulse↔CRM link so both ledgers stay in sync when linked.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. safr_record_crm_edit — capture manual CRM column changes
-- ───────────────────────────────────────────────────────────────────────────
-- When PersonDetails / OrgDetails saves a field directly to agents/agencies,
-- record it as a 'manual' observation. Guard prevents loops when
-- safr_mirror_to_legacy is what changed the column.
CREATE OR REPLACE FUNCTION safr_record_crm_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Don't record observations that came from safr_mirror_to_legacy itself.
  -- Depth ≥ 1 means we're nested inside a SAFR-driven update.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'agents' THEN
    IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'email',
        NEW.email, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name AND NEW.name IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'full_name',
        NEW.name, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.title IS DISTINCT FROM OLD.title AND NEW.title IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'job_title',
        NEW.title, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'phone',
        NEW.phone, 'manual', NULL, NULL, NULL, now());
    END IF;
  ELSIF TG_TABLE_NAME = 'agencies' THEN
    IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'email',
        NEW.email, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name AND NEW.name IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'name',
        NEW.name, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'phone',
        NEW.phone, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.address IS DISTINCT FROM OLD.address AND NEW.address IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'address',
        NEW.address, 'manual', NULL, NULL, NULL, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS safr_record_crm_edit_agents_trg ON agents;
CREATE TRIGGER safr_record_crm_edit_agents_trg
AFTER UPDATE OF name, email, phone, title ON agents
FOR EACH ROW
EXECUTE FUNCTION safr_record_crm_edit();

DROP TRIGGER IF EXISTS safr_record_crm_edit_agencies_trg ON agencies;
CREATE TRIGGER safr_record_crm_edit_agencies_trg
AFTER UPDATE OF name, email, phone, address ON agencies
FOR EACH ROW
EXECUTE FUNCTION safr_record_crm_edit();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. pulse_apply_crm_link — extend with link-time SAFR replay
-- ───────────────────────────────────────────────────────────────────────────
-- After establishing the link, copy all existing pulse-side observations
-- into the CRM ledger and re-resolve so safr_mirror_to_legacy fires with
-- the (potentially new) winner per field. This is what pulls Pulse's
-- email/phone/etc onto the CRM record at link time.
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
  v_crm_efs_type text;
  v_pulse_efs_type text;
BEGIN
  IF p_entity_type NOT IN ('agent','agency') THEN
    RAISE EXCEPTION 'pulse_apply_crm_link: invalid entity_type %', p_entity_type;
  END IF;

  -- SAFR uses different entity_type names than the link RPC. Map:
  --   p_entity_type='agent'  → pulse ledger 'agent', CRM ledger 'contact'
  --   p_entity_type='agency' → pulse ledger 'agency', CRM ledger 'organization'
  v_pulse_efs_type := p_entity_type;
  v_crm_efs_type   := CASE p_entity_type
                        WHEN 'agent'  THEN 'contact'
                        WHEN 'agency' THEN 'organization' END;

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

  -- Upsert the mapping row.
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

  -- ──────────────────────────────────────────────────────────────────────
  -- Link-time SAFR replay: for every active pulse observation that has a
  -- field in the CRM-side legacy map, replay it as a CRM observation. The
  -- record_field_observation calls trigger the resolver per-field, which
  -- mirrors the winning value to the agents/agencies column.
  --
  -- This is idempotent — re-linking just bumps last_seen_at on existing
  -- rows.
  -- ──────────────────────────────────────────────────────────────────────
  PERFORM record_field_observation(
    v_crm_efs_type, p_crm_id, efs.field_name,
    efs.value_display, efs.source, efs.source_ref_type, efs.source_ref_id,
    efs.confidence, efs.observed_at
  )
  FROM entity_field_sources efs
  JOIN safr_legacy_field_map m
    ON m.entity_type = v_crm_efs_type AND m.field_name = efs.field_name
  WHERE efs.entity_type = v_pulse_efs_type
    AND efs.entity_id   = p_pulse_id
    AND efs.status IN ('active', 'promoted')
    AND efs.value_display IS NOT NULL;

  RETURN QUERY SELECT v_mapping_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_apply_crm_link(text, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION pulse_apply_crm_link IS
  'Atomically link a CRM agent/agency to a pulse record AND replay pulse-side SAFR observations into the CRM ledger so columns mirror the resolver winner. Migration 348 + 350.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4. pulse_preview_link_changes — what will change if we link
-- ───────────────────────────────────────────────────────────────────────────
-- Used by PulseLinkCard to show "N fields will be updated from Pulse"
-- before the user confirms the link. Returns one row per shared field with
-- the current CRM column value vs. the pulse column value, plus a flag
-- indicating whether linking would change the CRM value (heuristic — based
-- on column comparison, not full resolver simulation).
CREATE OR REPLACE FUNCTION pulse_preview_link_changes(
  p_entity_type text,
  p_crm_id      uuid,
  p_pulse_id    uuid
)
RETURNS TABLE (
  field_name        text,
  crm_label         text,
  crm_current_value text,
  pulse_value       text,
  will_change       boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_entity_type = 'agent' THEN
    RETURN QUERY
    WITH crm AS (
      SELECT name, email, phone, title FROM agents WHERE id = p_crm_id
    ),
    pulse AS (
      SELECT full_name, email, business_phone, mobile, job_title
      FROM pulse_agents WHERE id = p_pulse_id
    )
    SELECT * FROM (VALUES
      ('full_name', 'Name',
       (SELECT name FROM crm),
       (SELECT full_name FROM pulse),
       (SELECT name FROM crm) IS DISTINCT FROM (SELECT full_name FROM pulse)
         AND (SELECT full_name FROM pulse) IS NOT NULL),
      ('email', 'Email',
       (SELECT email FROM crm),
       (SELECT email FROM pulse),
       (SELECT email FROM crm) IS DISTINCT FROM (SELECT email FROM pulse)
         AND (SELECT email FROM pulse) IS NOT NULL),
      ('phone', 'Phone',
       (SELECT phone FROM crm),
       (SELECT business_phone FROM pulse),
       (SELECT phone FROM crm) IS DISTINCT FROM (SELECT business_phone FROM pulse)
         AND (SELECT business_phone FROM pulse) IS NOT NULL),
      ('mobile', 'Mobile',
       (SELECT phone FROM crm),  -- agents.phone covers both 'phone' and 'mobile' in legacy map
       (SELECT mobile FROM pulse),
       (SELECT phone FROM crm) IS DISTINCT FROM (SELECT mobile FROM pulse)
         AND (SELECT mobile FROM pulse) IS NOT NULL),
      ('job_title', 'Title',
       (SELECT title FROM crm),
       (SELECT job_title FROM pulse),
       (SELECT title FROM crm) IS DISTINCT FROM (SELECT job_title FROM pulse)
         AND (SELECT job_title FROM pulse) IS NOT NULL)
    ) AS t(field_name, crm_label, crm_current_value, pulse_value, will_change);
  ELSIF p_entity_type = 'agency' THEN
    RETURN QUERY
    WITH crm AS (
      SELECT name, email, phone, address FROM agencies WHERE id = p_crm_id
    ),
    pulse AS (
      SELECT name, email, phone, address FROM pulse_agencies WHERE id = p_pulse_id
    )
    SELECT * FROM (VALUES
      ('name', 'Name',
       (SELECT name FROM crm),
       (SELECT name FROM pulse),
       (SELECT name FROM crm) IS DISTINCT FROM (SELECT name FROM pulse)
         AND (SELECT name FROM pulse) IS NOT NULL),
      ('email', 'Email',
       (SELECT email FROM crm),
       (SELECT email FROM pulse),
       (SELECT email FROM crm) IS DISTINCT FROM (SELECT email FROM pulse)
         AND (SELECT email FROM pulse) IS NOT NULL),
      ('phone', 'Phone',
       (SELECT phone FROM crm),
       (SELECT phone FROM pulse),
       (SELECT phone FROM crm) IS DISTINCT FROM (SELECT phone FROM pulse)
         AND (SELECT phone FROM pulse) IS NOT NULL),
      ('address', 'Address',
       (SELECT address FROM crm),
       (SELECT address FROM pulse),
       (SELECT address FROM crm) IS DISTINCT FROM (SELECT address FROM pulse)
         AND (SELECT address FROM pulse) IS NOT NULL)
    ) AS t(field_name, crm_label, crm_current_value, pulse_value, will_change);
  ELSE
    RAISE EXCEPTION 'pulse_preview_link_changes: invalid entity_type %', p_entity_type;
  END IF;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_preview_link_changes(text, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION pulse_preview_link_changes IS
  'Preview the per-field column-level diff for a prospective Pulse↔CRM link. Used by PulseLinkCard to show what will change before the user confirms.';

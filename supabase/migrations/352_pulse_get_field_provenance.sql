-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 352: per-field provenance RPC for the audit panel
-- ═══════════════════════════════════════════════════════════════════════════
-- Drives the "Field sources" panel on PersonDetails / OrgDetails. Returns
-- one row per editable field showing where the current value came from,
-- when it was observed, who/what the source is, and whether it's locked
-- (pinned by an operator).
--
-- For each field we list ALL active/promoted observations so the UI can
-- show alternates ("Pulse says 'Senior', REA listing said 'Property
-- Partner'"). The promoted row is flagged is_promoted=true.
CREATE OR REPLACE FUNCTION pulse_get_field_provenance(
  p_entity_type text,   -- 'agent' or 'agency' (the link RPC names)
  p_crm_id      uuid
)
RETURNS TABLE (
  field_name        text,
  field_label       text,
  legacy_column     text,
  -- Per-observation details
  source_id         uuid,
  value_display     text,
  source            text,
  confidence        numeric,
  observed_at       timestamptz,
  status            text,
  is_promoted       boolean,
  is_locked         boolean,
  locked_at         timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_efs_type text;
BEGIN
  IF p_entity_type NOT IN ('agent','agency') THEN
    RAISE EXCEPTION 'pulse_get_field_provenance: invalid entity_type %', p_entity_type;
  END IF;

  v_efs_type := CASE p_entity_type WHEN 'agent' THEN 'contact' ELSE 'organization' END;

  RETURN QUERY
  WITH fields AS (
    SELECT
      m.field_name,
      CASE m.field_name
        WHEN 'full_name'  THEN 'Name'
        WHEN 'name'       THEN 'Name'
        WHEN 'email'      THEN 'Email'
        WHEN 'phone'      THEN 'Phone'
        WHEN 'mobile'     THEN 'Mobile'
        WHEN 'job_title'  THEN 'Title'
        WHEN 'address'    THEN 'Address'
        ELSE m.field_name
      END AS field_label,
      m.column_name AS legacy_column
    FROM safr_legacy_field_map m
    WHERE m.entity_type = v_efs_type
  )
  SELECT
    f.field_name,
    f.field_label,
    f.legacy_column,
    efs.id                          AS source_id,
    efs.value_display,
    efs.source,
    efs.confidence,
    efs.observed_at,
    efs.status,
    (efs.status = 'promoted')       AS is_promoted,
    (efs.locked_at IS NOT NULL)     AS is_locked,
    efs.locked_at
  FROM fields f
  LEFT JOIN entity_field_sources efs
    ON efs.entity_type = v_efs_type
   AND efs.entity_id   = p_crm_id
   AND efs.field_name  = f.field_name
   AND efs.status IN ('active', 'promoted')
  ORDER BY f.field_name, efs.status DESC, efs.confidence DESC;
END;
$fn$;

GRANT EXECUTE ON FUNCTION pulse_get_field_provenance(text, uuid) TO authenticated;
COMMENT ON FUNCTION pulse_get_field_provenance IS
  'Returns per-field provenance (current promoted value + active alternates) for the contact/organization side of a CRM record. Used by the audit panel on PersonDetails / OrgDetails.';

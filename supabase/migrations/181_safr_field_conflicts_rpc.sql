-- ════════════════════════════════════════════════════════════════════════════
-- Migration 181 — SAFR Data Consistency RPCs
-- ════════════════════════════════════════════════════════════════════════════
--
-- Backs the /Settings/DataConsistency page:
--
--   pulse_list_field_conflicts(p_entity_type?, p_field_name?, p_limit, p_offset)
--     → rows where an entity's current (promoted) field value disagrees with
--       an active (not-dismissed, not-superseded) alternate. One row per
--       (entity, field, alternate). The user can "Keep current", "Use
--       alternate", or "Dismiss alternate" inline.
--
--   pulse_list_locked_fields(p_limit, p_offset)
--     → rows where entity_field_sources.locked_at IS NOT NULL. Admin-only
--       unlock target for the "Locked fields" tab.
--
--   pulse_data_consistency_stats() → jsonb
--     → summary strip: totals, conflicts, locked, auto-resolved in 7d.
--
-- All three are STABLE and SECURITY INVOKER — the caller's RLS on
-- entity_field_sources applies (admin+manager per the schema agent's grants).
--
-- The resolver's "entity_name" column uses a small COALESCE lookup against
-- the three entity tables we care about (contacts, organizations, agents).
-- Unknown entity_type values fall through to the entity's id.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── entity_name resolver ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION safr_lookup_entity_name(p_entity_type text, p_entity_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_name text;
BEGIN
  IF p_entity_id IS NULL THEN RETURN NULL; END IF;

  -- FlexMedia naming: the SAFR entity_type strings ("contact" / "organization")
  -- intentionally disagree with the physical table names ("agents" /
  -- "agencies"). The resolver consumer cares about stable API strings; the
  -- lookup here just joins back to whichever table actually holds the name.
  CASE p_entity_type
    WHEN 'contact', 'person', 'agent' THEN
      SELECT name INTO v_name FROM agents WHERE id = p_entity_id;
      IF v_name IS NULL THEN
        SELECT full_name INTO v_name FROM pulse_agents WHERE id = p_entity_id;
      END IF;
    WHEN 'organization', 'organisation', 'org', 'agency' THEN
      SELECT name INTO v_name FROM agencies WHERE id = p_entity_id;
      IF v_name IS NULL THEN
        SELECT name INTO v_name FROM pulse_agencies WHERE id = p_entity_id;
      END IF;
    WHEN 'prospect' THEN
      -- prospects table doesn't have a standard name column across environments;
      -- swallow any lookup error and fall through to the id.
      BEGIN
        EXECUTE 'SELECT COALESCE(full_name, name, contact_name) FROM prospects WHERE id = $1'
          INTO v_name USING p_entity_id;
      EXCEPTION WHEN OTHERS THEN
        v_name := NULL;
      END;
    ELSE
      v_name := NULL;
  END CASE;

  RETURN COALESCE(NULLIF(v_name, ''), p_entity_id::text);
EXCEPTION WHEN OTHERS THEN
  -- Any missing table / column just returns the id.
  RETURN p_entity_id::text;
END;
$$;

COMMENT ON FUNCTION safr_lookup_entity_name(text, uuid) IS
  'Best-effort display name for an (entity_type, entity_id) pair. Used by SAFR UI.';

-- ── Conflicts RPC ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_list_field_conflicts(
  p_entity_type text DEFAULT NULL,
  p_field_name  text DEFAULT NULL,
  p_limit       int  DEFAULT 50,
  p_offset      int  DEFAULT 0
)
RETURNS TABLE(
  entity_type         text,
  entity_id           uuid,
  entity_name         text,
  field_name          text,
  current_source_id   uuid,
  current_value       text,
  current_source      text,
  current_confidence  numeric,
  alt_source_id       uuid,
  alt_value           text,
  alt_source          text,
  alt_confidence      numeric,
  observed_delta_days int,
  total_alternates    int
)
LANGUAGE sql
STABLE
AS $$
  WITH promoted AS (
    SELECT
      efs.id            AS promoted_id,
      efs.entity_type,
      efs.entity_id,
      efs.field_name,
      COALESCE(efs.value_display, efs.value_normalized) AS value_txt,
      efs.source,
      efs.confidence,
      efs.observed_at,
      efs.value_normalized AS norm
    FROM entity_field_sources efs
    WHERE efs.status = 'promoted'
      AND efs.dismissed_at IS NULL
      AND (p_entity_type IS NULL OR efs.entity_type = p_entity_type)
      AND (p_field_name IS NULL OR efs.field_name  = p_field_name)
  ),
  alternates AS (
    SELECT
      efs.id AS alt_id,
      efs.entity_type,
      efs.entity_id,
      efs.field_name,
      COALESCE(efs.value_display, efs.value_normalized) AS value_txt,
      efs.source,
      efs.confidence,
      efs.observed_at,
      efs.value_normalized AS norm
    FROM entity_field_sources efs
    WHERE efs.status = 'active'
      AND efs.dismissed_at IS NULL
      AND (p_entity_type IS NULL OR efs.entity_type = p_entity_type)
      AND (p_field_name IS NULL OR efs.field_name  = p_field_name)
  ),
  conflicts AS (
    SELECT
      p.entity_type,
      p.entity_id,
      p.field_name,
      p.promoted_id   AS current_source_id,
      p.value_txt     AS current_value,
      p.source        AS current_source,
      p.confidence    AS current_confidence,
      p.observed_at   AS current_observed_at,
      a.alt_id,
      a.value_txt     AS alt_value,
      a.source        AS alt_source,
      a.confidence    AS alt_confidence,
      a.observed_at   AS alt_observed_at,
      count(*) OVER (PARTITION BY p.entity_type, p.entity_id, p.field_name) AS total_alternates
    FROM promoted p
    JOIN alternates a
      ON a.entity_type = p.entity_type
     AND a.entity_id   = p.entity_id
     AND a.field_name  = p.field_name
     AND a.norm IS DISTINCT FROM p.norm
  )
  SELECT
    c.entity_type,
    c.entity_id,
    safr_lookup_entity_name(c.entity_type, c.entity_id) AS entity_name,
    c.field_name,
    c.current_source_id,
    c.current_value,
    c.current_source,
    c.current_confidence,
    c.alt_id          AS alt_source_id,
    c.alt_value,
    c.alt_source,
    c.alt_confidence,
    GREATEST(0, EXTRACT(DAY FROM (c.alt_observed_at - c.current_observed_at))::int) AS observed_delta_days,
    c.total_alternates::int
  FROM conflicts c
  ORDER BY c.alt_confidence DESC NULLS LAST, c.alt_observed_at DESC
  LIMIT GREATEST(1, COALESCE(p_limit, 50))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

COMMENT ON FUNCTION pulse_list_field_conflicts(text, text, int, int) IS
  'SAFR Data Consistency: (entity,field) pairs whose promoted value has active alternates.';

-- ── Locked fields RPC ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_list_locked_fields(
  p_limit  int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  source_id        uuid,
  entity_type      text,
  entity_id        uuid,
  entity_name      text,
  field_name       text,
  value            text,
  source           text,
  locked_at        timestamptz,
  locked_by_user_id uuid,
  locked_by_email  text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    efs.id                                                AS source_id,
    efs.entity_type,
    efs.entity_id,
    safr_lookup_entity_name(efs.entity_type, efs.entity_id) AS entity_name,
    efs.field_name,
    COALESCE(efs.value_display, efs.value_normalized) AS value,
    efs.source,
    efs.locked_at,
    efs.locked_by_user_id,
    u.email                                               AS locked_by_email
  FROM entity_field_sources efs
  LEFT JOIN users u ON u.id = efs.locked_by_user_id
  WHERE efs.locked_at IS NOT NULL
    AND efs.dismissed_at IS NULL
  ORDER BY efs.locked_at DESC
  LIMIT GREATEST(1, COALESCE(p_limit, 100))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

COMMENT ON FUNCTION pulse_list_locked_fields(int, int) IS
  'SAFR Data Consistency: all fields with an active user lock.';

-- ── Dashboard stats RPC ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_data_consistency_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH
    conflict_pairs AS (
      SELECT entity_type, entity_id, field_name
      FROM entity_field_sources
      WHERE dismissed_at IS NULL
      GROUP BY entity_type, entity_id, field_name
      HAVING count(DISTINCT value_normalized) > 1
    ),
    locked_count AS (
      SELECT count(*) AS n FROM entity_field_sources
      WHERE locked_at IS NOT NULL AND dismissed_at IS NULL
    ),
    auto_resolved_7d AS (
      SELECT count(*) AS n FROM entity_field_sources
      WHERE promoted_at >= now() - interval '7 days'
        AND locked_at IS NULL
        AND status = 'promoted'
    ),
    entities_with_conflicts AS (
      SELECT count(DISTINCT (entity_type, entity_id)) AS n FROM conflict_pairs
    )
  SELECT jsonb_build_object(
    'entities_with_conflicts', COALESCE((SELECT n FROM entities_with_conflicts), 0),
    'locked_fields',           COALESCE((SELECT n FROM locked_count), 0),
    'conflict_pairs',          COALESCE((SELECT count(*) FROM conflict_pairs), 0),
    'auto_resolved_7d',        COALESCE((SELECT n FROM auto_resolved_7d), 0)
  );
$$;

COMMENT ON FUNCTION pulse_data_consistency_stats() IS
  'SAFR Data Consistency: header stat strip for the admin settings page.';

-- ── Grants ───────────────────────────────────────────────────────────────
-- Admin+manager roles ride on the same RLS that protects entity_field_sources;
-- we just grant execute to authenticated. RLS decides visibility.

GRANT EXECUTE ON FUNCTION safr_lookup_entity_name(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_list_field_conflicts(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_list_locked_fields(int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_data_consistency_stats() TO authenticated;

COMMIT;

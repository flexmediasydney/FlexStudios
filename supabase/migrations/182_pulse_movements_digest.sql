-- 182_pulse_movements_digest.sql
-- SAFR (Source-Aware Field Resolution) surfaces: "Movements this week" digest
-- powering the PulseCommandCenter "Movements this week" widget + the Signals
-- tab's movement-category cards.
--
-- Signals of interest (installed by migration 180 via entity_field_sources
-- promotion triggers):
--   • agent_movement  (level=high)   — agent.agency_name / agent.agency_rea_id
--   • contact_change  (level=low)    — contact.email / mobile / phone
--   • role_change     (level=medium) — contact.job_title
--
-- Each signal row has source_data jsonb with:
--   { entity_type, entity_id, field_name, from_value, to_value,
--     from_source, to_source, confidence, observed_at, times_seen }
--
-- This RPC aggregates the last p_days of those signals into a single jsonb
-- payload so the Command Center can render counts + top-5 chronological list
-- in one round trip. Safe to call without parameters (defaults to 7 days).
--
-- NOTE: pulse_signals.category was widened to include 'agent_movement',
-- 'contact_change', 'role_change' by migration 180 (schema agent). This
-- migration only reads from the widened table.

BEGIN;

-- == pulse_get_movements_digest =============================================
-- Returns:
-- {
--   "agent_moves_count":    int,
--   "contact_changes_count": int,
--   "role_changes_count":   int,
--   "recent": [
--     { signal_id, category, title, entity_type, entity_id, entity_name,
--       from_value, to_value, created_at }, ...
--   ]
-- }
-- "recent" is capped at 10 rows, newest first, across ALL three categories
-- so the cockpit widget can show top-5 and the tab navigation can page.

CREATE OR REPLACE FUNCTION pulse_get_movements_digest(p_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH win AS (
    SELECT (now() - make_interval(days => p_days)) AS since
  ),
  scoped AS (
    SELECT s.*
    FROM pulse_signals s, win w
    WHERE s.created_at >= w.since
      AND s.category IN ('agent_movement','contact_change','role_change')
  ),
  counts AS (
    SELECT
      count(*) FILTER (WHERE category = 'agent_movement')  AS agent_moves_count,
      count(*) FILTER (WHERE category = 'contact_change')  AS contact_changes_count,
      count(*) FILTER (WHERE category = 'role_change')     AS role_changes_count
    FROM scoped
  ),
  recent_rows AS (
    SELECT
      s.id          AS signal_id,
      s.category,
      s.title,
      s.created_at,
      (s.source_data->>'entity_type')   AS entity_type,
      (s.source_data->>'entity_id')     AS entity_id,
      (s.source_data->>'field_name')    AS field_name,
      (s.source_data->>'from_value')    AS from_value,
      (s.source_data->>'to_value')      AS to_value,
      (s.source_data->>'from_source')   AS from_source,
      (s.source_data->>'to_source')     AS to_source
    FROM scoped s
    ORDER BY s.created_at DESC
    LIMIT 10
  ),
  named AS (
    -- Resolve entity_name for each row.
    --   agent   → prefers pulse_agents.full_name (SAFR source of truth for
    --             real-estate graph), falls back to agents.name (CRM).
    --   agency  → pulse_agencies.name, falls back to agencies.name.
    --   contact → agents.name (contact_change / role_change signals write
    --             against the CRM contact/agent record).
    -- The UUID cast is tolerant: invalid text returns NULL without erroring.
    SELECT
      r.*,
      COALESCE(
        CASE WHEN r.entity_type = 'agent'   THEN (SELECT full_name FROM pulse_agents   WHERE id::text = r.entity_id) END,
        CASE WHEN r.entity_type = 'agent'   THEN (SELECT name      FROM agents         WHERE id::text = r.entity_id) END,
        CASE WHEN r.entity_type = 'agency'  THEN (SELECT name      FROM pulse_agencies WHERE id::text = r.entity_id) END,
        CASE WHEN r.entity_type = 'agency'  THEN (SELECT name      FROM agencies       WHERE id::text = r.entity_id) END,
        CASE WHEN r.entity_type = 'contact' THEN (SELECT name      FROM agents         WHERE id::text = r.entity_id) END
      ) AS entity_name
    FROM recent_rows r
  )
  SELECT jsonb_build_object(
    'agent_moves_count',     COALESCE((SELECT agent_moves_count     FROM counts), 0),
    'contact_changes_count', COALESCE((SELECT contact_changes_count FROM counts), 0),
    'role_changes_count',    COALESCE((SELECT role_changes_count    FROM counts), 0),
    'window_days',           p_days,
    'recent', COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'signal_id',    signal_id,
          'category',     category,
          'title',        title,
          'entity_type',  entity_type,
          'entity_id',    entity_id,
          'entity_name',  entity_name,
          'field_name',   field_name,
          'from_value',   from_value,
          'to_value',     to_value,
          'from_source',  from_source,
          'to_source',    to_source,
          'created_at',   created_at
        ) ORDER BY created_at DESC
      ) FROM named),
      '[]'::jsonb
    )
  );
$$;

-- Allow the authenticated role to call it from the browser.
GRANT EXECUTE ON FUNCTION pulse_get_movements_digest(int) TO authenticated, anon;

COMMENT ON FUNCTION pulse_get_movements_digest(int) IS
'Aggregates last N days of SAFR-emitted agent_movement / contact_change / '
'role_change signals into a jsonb payload for the "Movements this week" '
'Command Center widget. Returns counts per category + top 10 recent rows '
'with resolved entity_name.';

COMMIT;

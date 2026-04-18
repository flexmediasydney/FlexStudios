-- Migration 131 — pulseReconcileOrphans RPCs + daily cron
--
-- ── Why ──────────────────────────────────────────────────────────────────
-- Migrations 122 + 123 installed triggers that prevent new orphan rows from
-- entering the pulse_* graph. They don't FIX historical drift, and can't
-- cover every edge case (race with AFTER-INSERT sweeper, manual UPDATE
-- scripts, rows where agent_name was NULL at bridge-time and thus skipped).
--
-- pulseReconcileOrphans is the daily sweep that finds + fixes that drift.
-- This migration provides:
--   1. SECURITY DEFINER SQL RPCs the edge function calls. Pushing the SQL
--      server-side keeps the round-trips to one per check (not one per row)
--      and lets us return a single rowcount via the Postgres RETURNING
--      GET DIAGNOSTICS pattern.
--   2. A `pulse_timeline_event_types` registration for
--      `integrity_drift_warning` so the drift-warning insert passes the
--      migration-116 trigger without logging a WARNING.
--   3. The pg_cron schedule entry firing daily at 03:00 UTC (13:00 AEST).
--
-- ── Idempotency ──────────────────────────────────────────────────────────
-- All RPCs are composed of INSERT … ON CONFLICT DO UPDATE COALESCE / UPDATE
-- … WHERE col IS NULL. Re-running is safe; repeated execution returns 0.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1. Register the `integrity_drift_warning` timeline event type
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  ('integrity_drift_warning', 'system',
   'pulseReconcileOrphans detected drift above threshold and emitted a warning')
ON CONFLICT (event_type) DO UPDATE SET
  category = EXCLUDED.category,
  description = EXCLUDED.description;

-- ════════════════════════════════════════════════════════════════════════
-- 2. RPC — bridge-create missing pulse_agents from pulse_listings
-- ════════════════════════════════════════════════════════════════════════
-- Mirrors migration 122 Part A.1. Returns the number of NEW rows inserted.
CREATE OR REPLACE FUNCTION public.pulse_reconcile_bridge_agents_from_listings()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.pulse_reconcile_bridge_agents_from_listings() IS
  'pulseReconcileOrphans: bridge-create missing pulse_agents from '
  'pulse_listings.agent_rea_id references. Idempotent. Returns insert count.';

-- ════════════════════════════════════════════════════════════════════════
-- 3. RPC — bridge-create missing pulse_agencies from listings + agents
-- ════════════════════════════════════════════════════════════════════════
-- Mirrors migration 122 Part A.2. Unique key is lower(trim(name)) per the
-- existing schema. DISTINCT ON + UNION ALL prevents "row affected twice".
CREATE OR REPLACE FUNCTION public.pulse_reconcile_bridge_agencies_from_refs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
      -- (a) Bridge from listings
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

      -- (b) Bridge from pulse_agents whose agency has no matching agency row
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
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.pulse_reconcile_bridge_agencies_from_refs() IS
  'pulseReconcileOrphans: bridge-create missing pulse_agencies from '
  'listing + agent references. Idempotent. Returns insert count.';

-- ════════════════════════════════════════════════════════════════════════
-- 4. RPC — backfill pulse_listings.agent_pulse_id from agent_rea_id
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.pulse_reconcile_backfill_agent_pulse_id()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  WITH upd AS (
    UPDATE pulse_listings l
    SET agent_pulse_id = pa.id
    FROM pulse_agents pa
    WHERE l.agent_rea_id  IS NOT NULL
      AND l.agent_pulse_id IS NULL
      AND l.agent_rea_id  = pa.rea_agent_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_updated FROM upd;
  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.pulse_reconcile_backfill_agent_pulse_id() IS
  'pulseReconcileOrphans: backfill pulse_listings.agent_pulse_id from '
  'agent_rea_id. Batched UPDATE. Idempotent.';

-- ════════════════════════════════════════════════════════════════════════
-- 5. RPC — backfill pulse_listings.agency_pulse_id from agency_rea_id
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.pulse_reconcile_backfill_agency_pulse_id()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  WITH upd AS (
    UPDATE pulse_listings l
    SET agency_pulse_id = ag.id
    FROM pulse_agencies ag
    WHERE l.agency_rea_id   IS NOT NULL
      AND l.agency_pulse_id IS NULL
      AND l.agency_rea_id   = ag.rea_agency_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_updated FROM upd;
  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.pulse_reconcile_backfill_agency_pulse_id() IS
  'pulseReconcileOrphans: backfill pulse_listings.agency_pulse_id from '
  'agency_rea_id. Batched UPDATE. Idempotent.';

-- ════════════════════════════════════════════════════════════════════════
-- 6. RPC — backfill pulse_agents.linked_agency_pulse_id from agency_rea_id
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.pulse_reconcile_backfill_linked_agency_pulse_id()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  WITH upd AS (
    UPDATE pulse_agents pa
    SET linked_agency_pulse_id = ag.id
    FROM pulse_agencies ag
    WHERE pa.agency_rea_id          IS NOT NULL
      AND pa.linked_agency_pulse_id IS NULL
      AND pa.agency_rea_id          = ag.rea_agency_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_updated FROM upd;
  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.pulse_reconcile_backfill_linked_agency_pulse_id() IS
  'pulseReconcileOrphans: backfill pulse_agents.linked_agency_pulse_id from '
  'agency_rea_id. Batched UPDATE. Idempotent.';

-- ════════════════════════════════════════════════════════════════════════
-- 7. RPC — backfill pulse_crm_mappings.pulse_entity_id from rea_id
-- ════════════════════════════════════════════════════════════════════════
-- Two shapes: entity_type='agent' resolves via pulse_agents.rea_agent_id,
-- entity_type='agency' resolves via pulse_agencies.rea_agency_id.
CREATE OR REPLACE FUNCTION public.pulse_reconcile_backfill_crm_mapping_pulse_entity_id()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_agents integer := 0;
  v_agencies integer := 0;
BEGIN
  WITH upd_agents AS (
    UPDATE pulse_crm_mappings m
    SET pulse_entity_id = pa.id
    FROM pulse_agents pa
    WHERE m.pulse_entity_id IS NULL
      AND m.entity_type     = 'agent'
      AND m.rea_id          IS NOT NULL
      AND m.rea_id          = pa.rea_agent_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_agents FROM upd_agents;

  WITH upd_agencies AS (
    UPDATE pulse_crm_mappings m
    SET pulse_entity_id = ag.id
    FROM pulse_agencies ag
    WHERE m.pulse_entity_id IS NULL
      AND m.entity_type     = 'agency'
      AND m.rea_id          IS NOT NULL
      AND m.rea_id          = ag.rea_agency_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_agencies FROM upd_agencies;

  RETURN v_agents + v_agencies;
END;
$$;

COMMENT ON FUNCTION public.pulse_reconcile_backfill_crm_mapping_pulse_entity_id() IS
  'pulseReconcileOrphans: backfill pulse_crm_mappings.pulse_entity_id from '
  'rea_id when a matching pulse row exists. Runs agent + agency shapes. '
  'Idempotent.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- 8. Cron — daily sweep at 03:00 UTC (13:00 AEST, 14:00 AEDT)
-- ════════════════════════════════════════════════════════════════════════
-- Fire after the nightly bulk scrapes but before peak morning usage. Uses
-- the `pulse_cron_jwt` vault secret — same pattern as migrations 125/126/130.
-- Unschedule-first-then-schedule so re-running this migration won't error.
DO $$
BEGIN
  PERFORM cron.unschedule('pulse-reconcile-orphans');
EXCEPTION WHEN OTHERS THEN
  -- Not scheduled yet → fine, move on.
  NULL;
END $$;

SELECT cron.schedule(
  'pulse-reconcile-orphans',
  '0 3 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseReconcileOrphans',
    headers := jsonb_build_object(
      'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',     'application/json',
      'x-caller-context', 'cron:pulse-reconcile-orphans'
    ),
    body := '{"trigger":"cron"}'::jsonb
  );
  $cron$
);

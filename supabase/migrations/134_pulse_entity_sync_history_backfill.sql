-- Migration 134 — Backfill pulse_entity_sync_history + bridge-trigger emit
--
-- ── Problem ─────────────────────────────────────────────────────────────
-- The "View source history" drill-through on every pulse entity
-- (agent / agency / listing) is empty for almost every record.
--
-- Audit at migration time (18 Apr 2026):
--   * pulse_entity_sync_history total rows:           322
--   * distinct actions:                                 1   (`detail_enriched` only)
--   * distinct entity_types:                            1   (`listing` only)
--   * pulse_agents with no history rows:           3,567 / 3,567  (100%)
--   * pulse_agencies with no history rows:         1,510 / 1,510  (100%)
--   * pulse_listings with no history rows:         6,220 / 6,542  ( 95%)
--
-- Root cause:
--   1. `pulseDataSync` (the main daily/weekly sync that upserts
--      pulse_agents / pulse_agencies / pulse_listings) never writes to
--      pulse_entity_sync_history — only `pulseDetailEnrich` does, and only
--      for one action (`detail_enriched`) on listings.
--   2. The bridge trigger `pulse_bridge_from_listing()` (migration 122)
--      auto-creates pulse_agents / pulse_agencies rows when a listing
--      references an agent/agency we've never seen — but doesn't emit a
--      sync_history row for those synthetic creates either.
--
-- Result: EntitySyncHistoryDialog.jsx queries the table filtered by
-- (entity_type, entity_id), gets zero rows for almost every entity, and
-- renders the empty state "No sync history recorded for this X yet."
--
-- ── Fix ─────────────────────────────────────────────────────────────────
-- PART A: Backfill a synthetic `created` row for every pulse_agent /
--         pulse_agency / pulse_listing that currently has zero history
--         rows. Dated to the row's first_seen_at (falling back to
--         last_synced_at / now()). Tagged `backfilled: true` in
--         `changes_summary` so it's obvious these are synthetic.
--
-- PART B: Patch `pulse_bridge_from_listing()` trigger so that when it
--         inserts a fresh pulse_agent / pulse_agency row, it also writes
--         a `created` row to pulse_entity_sync_history. (Going-forward
--         emit for the bridge-create path.)
--
-- NB: `pulseDataSync` (edge function) is patched in a separate commit to
--      emit `created` / `updated` rows going forward for its own upserts.
--
-- Guarantees:
--   * Idempotent: re-running this migration inserts 0 rows.
--   * Non-destructive: existing rows in pulse_entity_sync_history are not
--     touched.
--   * After apply: every existing pulse entity has >= 1 history row, so
--     the drill-through dialog always renders at least one entry.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- PART A.1 — Backfill pulse_agents
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO pulse_entity_sync_history (
  entity_type,
  entity_id,
  entity_key,
  sync_log_id,
  action,
  changes_summary,
  source,
  seen_at
)
SELECT
  'agent'                                                          AS entity_type,
  a.id                                                             AS entity_id,
  a.rea_agent_id                                                   AS entity_key,
  a.last_sync_log_id                                               AS sync_log_id,
  'created'                                                        AS action,
  jsonb_build_object(
    'source',      COALESCE(a.source, 'unknown'),
    'full_name',   a.full_name,
    'backfilled',  true
  )                                                                AS changes_summary,
  COALESCE(a.source, 'pulse_dataSync')                             AS source,
  COALESCE(a.first_seen_at, a.last_synced_at, a.created_at, now()) AS seen_at
FROM pulse_agents a
WHERE NOT EXISTS (
  SELECT 1 FROM pulse_entity_sync_history h
  WHERE h.entity_type = 'agent' AND h.entity_id = a.id
);

-- ════════════════════════════════════════════════════════════════════════
-- PART A.2 — Backfill pulse_agencies
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO pulse_entity_sync_history (
  entity_type,
  entity_id,
  entity_key,
  sync_log_id,
  action,
  changes_summary,
  source,
  seen_at
)
SELECT
  'agency'                                                         AS entity_type,
  ag.id                                                            AS entity_id,
  ag.rea_agency_id                                                 AS entity_key,
  ag.last_sync_log_id                                              AS sync_log_id,
  'created'                                                        AS action,
  jsonb_build_object(
    'source',      COALESCE(ag.source, 'unknown'),
    'name',        ag.name,
    'backfilled',  true
  )                                                                AS changes_summary,
  COALESCE(ag.source, 'pulse_dataSync')                            AS source,
  COALESCE(ag.first_seen_at, ag.last_synced_at, ag.created_at, now()) AS seen_at
FROM pulse_agencies ag
WHERE NOT EXISTS (
  SELECT 1 FROM pulse_entity_sync_history h
  WHERE h.entity_type = 'agency' AND h.entity_id = ag.id
);

-- ════════════════════════════════════════════════════════════════════════
-- PART A.3 — Backfill pulse_listings
-- ════════════════════════════════════════════════════════════════════════
INSERT INTO pulse_entity_sync_history (
  entity_type,
  entity_id,
  entity_key,
  sync_log_id,
  action,
  changes_summary,
  source,
  seen_at
)
SELECT
  'listing'                                                        AS entity_type,
  l.id                                                             AS entity_id,
  l.source_listing_id                                              AS entity_key,
  l.last_sync_log_id                                               AS sync_log_id,
  'created'                                                        AS action,
  jsonb_build_object(
    'source',       COALESCE(l.source, 'unknown'),
    'listing_type', l.listing_type,
    'address',      l.address,
    'backfilled',   true
  )                                                                AS changes_summary,
  COALESCE(l.source, 'pulse_dataSync')                             AS source,
  COALESCE(l.first_seen_at, l.last_synced_at, l.created_at, now()) AS seen_at
FROM pulse_listings l
WHERE NOT EXISTS (
  SELECT 1 FROM pulse_entity_sync_history h
  WHERE h.entity_type = 'listing' AND h.entity_id = l.id
);

-- ════════════════════════════════════════════════════════════════════════
-- PART B — Patch pulse_bridge_from_listing() to emit sync_history rows
-- ════════════════════════════════════════════════════════════════════════
-- The original trigger (migration 122) inserts into pulse_agents /
-- pulse_agencies but never records anything in pulse_entity_sync_history.
-- Here we replace it with a version that writes a `created` history row
-- whenever it actually inserts a brand-new pulse_agent / pulse_agency
-- (detected by checking xmax = 0 after the INSERT...ON CONFLICT).
CREATE OR REPLACE FUNCTION public.pulse_bridge_from_listing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_agent_id      UUID;
  v_agent_created BOOLEAN;
  v_agency_id     UUID;
  v_agency_created BOOLEAN;
BEGIN
  -- Agent bridge ─────────────────────────────────────────────────────────
  IF NEW.agent_rea_id IS NOT NULL AND NEW.agent_name IS NOT NULL THEN
    WITH up AS (
      INSERT INTO pulse_agents (
        rea_agent_id,
        full_name,
        agency_name,
        agency_rea_id,
        source,
        data_sources,
        data_integrity_score,
        first_seen_at,
        last_synced_at,
        last_sync_log_id,
        is_in_crm,
        is_prospect
      )
      VALUES (
        NEW.agent_rea_id,
        NEW.agent_name,
        NEW.agency_name,
        NEW.agency_rea_id,
        'rea_listings_bridge',
        '["rea_listings"]'::jsonb,
        30,
        COALESCE(NEW.first_seen_at, now()),
        COALESCE(NEW.last_synced_at, now()),
        NEW.last_sync_log_id,
        false,
        false
      )
      ON CONFLICT (rea_agent_id) DO UPDATE SET
        full_name        = COALESCE(pulse_agents.full_name, EXCLUDED.full_name),
        agency_name      = COALESCE(pulse_agents.agency_name, EXCLUDED.agency_name),
        agency_rea_id    = COALESCE(pulse_agents.agency_rea_id, EXCLUDED.agency_rea_id),
        last_synced_at   = GREATEST(
                             COALESCE(pulse_agents.last_synced_at, EXCLUDED.last_synced_at),
                             EXCLUDED.last_synced_at
                           ),
        last_sync_log_id = COALESCE(EXCLUDED.last_sync_log_id, pulse_agents.last_sync_log_id)
      RETURNING id, (xmax = 0) AS inserted
    )
    SELECT id, inserted INTO v_agent_id, v_agent_created FROM up;

    -- Only emit sync_history row on fresh insert (not ON CONFLICT update).
    IF v_agent_created THEN
      INSERT INTO pulse_entity_sync_history (
        entity_type, entity_id, entity_key, sync_log_id,
        action, changes_summary, source, seen_at
      )
      VALUES (
        'agent', v_agent_id, NEW.agent_rea_id, NEW.last_sync_log_id,
        'created',
        jsonb_build_object(
          'source',       'rea_listings_bridge',
          'full_name',    NEW.agent_name,
          'agency_name',  NEW.agency_name,
          'from_listing', NEW.id
        ),
        'rea_listings_bridge',
        COALESCE(NEW.last_synced_at, now())
      );
    END IF;
  END IF;

  -- Agency bridge ────────────────────────────────────────────────────────
  IF NEW.agency_rea_id IS NOT NULL AND NEW.agency_name IS NOT NULL THEN
    WITH up AS (
      INSERT INTO pulse_agencies (
        rea_agency_id,
        name,
        source,
        data_sources,
        first_seen_at,
        last_synced_at,
        last_sync_log_id,
        is_in_crm
      )
      VALUES (
        NEW.agency_rea_id,
        NEW.agency_name,
        'rea_listings_bridge',
        '["rea_listings"]'::jsonb,
        COALESCE(NEW.first_seen_at, now()),
        COALESCE(NEW.last_synced_at, now()),
        NEW.last_sync_log_id,
        false
      )
      ON CONFLICT (lower(trim(name))) DO UPDATE SET
        rea_agency_id    = COALESCE(pulse_agencies.rea_agency_id, EXCLUDED.rea_agency_id),
        last_synced_at   = GREATEST(
                             COALESCE(pulse_agencies.last_synced_at, EXCLUDED.last_synced_at),
                             EXCLUDED.last_synced_at
                           ),
        last_sync_log_id = COALESCE(EXCLUDED.last_sync_log_id, pulse_agencies.last_sync_log_id)
      RETURNING id, (xmax = 0) AS inserted
    )
    SELECT id, inserted INTO v_agency_id, v_agency_created FROM up;

    IF v_agency_created THEN
      INSERT INTO pulse_entity_sync_history (
        entity_type, entity_id, entity_key, sync_log_id,
        action, changes_summary, source, seen_at
      )
      VALUES (
        'agency', v_agency_id, NEW.agency_rea_id, NEW.last_sync_log_id,
        'created',
        jsonb_build_object(
          'source',       'rea_listings_bridge',
          'name',         NEW.agency_name,
          'from_listing', NEW.id
        ),
        'rea_listings_bridge',
        COALESCE(NEW.last_synced_at, now())
      );
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a listing upsert on a bridge failure. Log and move on.
  RAISE WARNING 'pulse_bridge_from_listing failed for listing % (agent_rea_id=%, agency_rea_id=%): %',
    NEW.id, NEW.agent_rea_id, NEW.agency_rea_id, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pulse_bridge_from_listing() IS
  'AFTER INSERT/UPDATE trigger on pulse_listings. Ensures every agent_rea_id and agency_rea_id referenced on a listing has at least a minimal row in pulse_agents / pulse_agencies so the UI never shows "not yet synced" for an agent we clearly know exists. Idempotent and non-destructive: never overwrites non-null fields on existing rows. Tagged source=rea_listings_bridge, data_integrity_score=30. Migration 134: also writes a `created` row to pulse_entity_sync_history when a fresh bridge row is inserted (detected via xmax=0), so the "View source history" drill has a baseline entry even for bridge-created entities.';

-- Trigger definition itself is unchanged from migration 122.
COMMIT;

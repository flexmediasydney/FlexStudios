-- Migration 122 — Listing → agent/agency bridge backfill + AFTER INSERT/UPDATE trigger
--
-- ── Problem ───────────────────────────────────────────────────────────────
-- azzouzana list scrapes carry `agent_rea_id`, `agent_name`, `agency_rea_id`,
-- `agency_name` EMBEDDED on every listing. These get stamped onto
-- `pulse_listings` as denormalized reference columns — but minimal
-- `pulse_agents` / `pulse_agencies` rows have never been auto-created from
-- that embedded data unless pulseDataSync's Step 7 cross-enrichment pass
-- happened to process that same run AND the listing record had an agent on
-- `_allAgents`. That path misses many real cases, leaving agent_rea_id as
-- an orphan FK on the listing (UI shows "not yet synced").
--
-- Pre-backfill measurement (prod, 18 April 2026):
--   * 3,263 distinct agent_rea_ids on pulse_listings
--   *   958 rows in pulse_agents
--   * 2,609 agent_rea_ids referenced but not in pulse_agents (80% orphaned)
--   * 1,417 distinct agency_rea_ids on pulse_listings
--   * 1,484 rows in pulse_agencies (existing rows may carry null rea_agency_id)
--   *    36 agency_rea_ids referenced but not in pulse_agencies
--
-- ── Fix ───────────────────────────────────────────────────────────────────
-- Part A: backfill missing pulse_agents / pulse_agencies rows from the
--         denormalized references on pulse_listings. Never overwrite
--         non-null data on existing rows — ON CONFLICT DO NOTHING / COALESCE
--         only.
-- Part B: install AFTER INSERT OR UPDATE trigger on pulse_listings that
--         invokes a SECURITY DEFINER bridge function. New listings whose
--         agent/agency hasn't been seen yet get a minimal row immediately,
--         so the UI never shows orphan references.
--
-- ── Guarantees ────────────────────────────────────────────────────────────
-- 1. Idempotent: re-running the backfill / trigger inserts 0 rows.
-- 2. Non-destructive: existing pulse_agents / pulse_agencies rows keep all
--    their enriched data. The bridge path only fills NULLs.
-- 3. Bridge-created rows are tagged `source = 'rea_listings_bridge'` and
--    `data_integrity_score = 30` so the UI can distinguish them from
--    websift / detail-enrich records.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- PART A.1 — Backfill missing pulse_agents from pulse_listings references
-- ════════════════════════════════════════════════════════════════════════
-- For every distinct agent_rea_id observed on pulse_listings where no
-- pulse_agents row currently carries that rea_agent_id, insert a minimal
-- row. Collapse multiple listings for the same agent: pick the longest
-- name (most likely to be the fully-spelled version), earliest
-- first_seen_at, latest last_synced_at + last_sync_log_id.
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
  'rea_listings_bridge'::text              AS source,
  '["rea_listings"]'::jsonb                AS data_sources,
  30                                       AS data_integrity_score,
  src.total_listings_active,
  src.first_seen_at,
  src.last_synced_at,
  src.last_sync_log_id,
  false                                    AS is_in_crm,
  false                                    AS is_prospect
FROM (
  SELECT
    l.agent_rea_id,
    -- Longest name wins (most likely the fully-spelled one).
    (array_agg(l.agent_name ORDER BY length(l.agent_name) DESC NULLS LAST))[1]          AS full_name,
    (array_agg(l.agency_name ORDER BY length(l.agency_name) DESC NULLS LAST))[1]        AS agency_name,
    (array_agg(l.agency_rea_id) FILTER (WHERE l.agency_rea_id IS NOT NULL))[1]          AS agency_rea_id,
    count(*)::int                                                                       AS total_listings_active,
    min(l.first_seen_at)                                                                AS first_seen_at,
    max(l.last_synced_at)                                                               AS last_synced_at,
    (array_agg(l.last_sync_log_id ORDER BY l.last_synced_at DESC NULLS LAST)
       FILTER (WHERE l.last_sync_log_id IS NOT NULL))[1]                                AS last_sync_log_id
  FROM pulse_listings l
  WHERE l.agent_rea_id IS NOT NULL
    AND l.agent_name   IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pulse_agents pa WHERE pa.rea_agent_id = l.agent_rea_id
    )
  GROUP BY l.agent_rea_id
) src
ON CONFLICT (rea_agent_id)
DO UPDATE SET
  -- Never clobber non-null fields on an existing row.
  full_name            = COALESCE(pulse_agents.full_name, EXCLUDED.full_name),
  agency_name          = COALESCE(pulse_agents.agency_name, EXCLUDED.agency_name),
  agency_rea_id        = COALESCE(pulse_agents.agency_rea_id, EXCLUDED.agency_rea_id),
  last_synced_at       = GREATEST(
                           COALESCE(pulse_agents.last_synced_at, EXCLUDED.last_synced_at),
                           EXCLUDED.last_synced_at
                         ),
  last_sync_log_id     = COALESCE(pulse_agents.last_sync_log_id, EXCLUDED.last_sync_log_id),
  first_seen_at        = LEAST(
                           COALESCE(pulse_agents.first_seen_at, EXCLUDED.first_seen_at),
                           EXCLUDED.first_seen_at
                         );

-- ════════════════════════════════════════════════════════════════════════
-- PART A.2 — Backfill missing pulse_agencies from pulse_listings + agents
-- ════════════════════════════════════════════════════════════════════════
-- pulse_agencies' unique key is lower(trim(name)) — NOT rea_agency_id —
-- so we ON CONFLICT against that expression.
--
-- Two sources of truth for "agency referenced but not in pulse_agencies":
--   a) pulse_listings.agency_rea_id (denormalized from list scrapes), and
--   b) pulse_agents.agency_rea_id   (websift / detail-enrich stamped).
-- Union them, then dedupe by lower(trim(name)) so the same name doesn't
-- appear twice in a single INSERT (Postgres rejects that even with
-- ON CONFLICT DO UPDATE — the affected-row-twice error).
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
  'rea_listings_bridge'::text              AS source,
  '["rea_listings"]'::jsonb                AS data_sources,
  src.active_listings,
  src.first_seen_at,
  src.last_synced_at,
  src.last_sync_log_id,
  false                                    AS is_in_crm
FROM (
  -- (a) Bridge from listings
  SELECT
    l.agency_rea_id                                                                     AS rea_agency_id,
    (array_agg(l.agency_name ORDER BY length(l.agency_name) DESC NULLS LAST))[1]        AS name,
    count(*)::int                                                                       AS active_listings,
    min(l.first_seen_at)                                                                AS first_seen_at,
    max(l.last_synced_at)                                                               AS last_synced_at,
    (array_agg(l.last_sync_log_id ORDER BY l.last_synced_at DESC NULLS LAST)
       FILTER (WHERE l.last_sync_log_id IS NOT NULL))[1]                                AS last_sync_log_id
  FROM pulse_listings l
  WHERE l.agency_rea_id IS NOT NULL
    AND l.agency_name   IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = l.agency_rea_id
    )
  GROUP BY l.agency_rea_id

  UNION ALL

  -- (b) Bridge from pulse_agents whose agency_rea_id has no matching agency
  SELECT
    pa.agency_rea_id                                                                    AS rea_agency_id,
    (array_agg(pa.agency_name ORDER BY length(pa.agency_name) DESC NULLS LAST))[1]      AS name,
    NULL::int                                                                           AS active_listings,
    min(pa.first_seen_at)                                                               AS first_seen_at,
    max(pa.last_synced_at)                                                              AS last_synced_at,
    NULL::uuid                                                                          AS last_sync_log_id
  FROM pulse_agents pa
  WHERE pa.agency_rea_id IS NOT NULL
    AND pa.agency_name   IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = pa.agency_rea_id
    )
  GROUP BY pa.agency_rea_id
) src
-- DISTINCT ON: richer row wins (the one with active_listings > 0 — i.e.
-- from listings — because ordering puts non-null first).
ORDER BY lower(trim(src.name)), src.active_listings DESC NULLS LAST
ON CONFLICT (lower(trim(name)))
DO UPDATE SET
  rea_agency_id        = COALESCE(pulse_agencies.rea_agency_id, EXCLUDED.rea_agency_id),
  last_synced_at       = GREATEST(
                           COALESCE(pulse_agencies.last_synced_at, EXCLUDED.last_synced_at),
                           EXCLUDED.last_synced_at
                         ),
  last_sync_log_id     = COALESCE(pulse_agencies.last_sync_log_id, EXCLUDED.last_sync_log_id),
  first_seen_at        = LEAST(
                           COALESCE(pulse_agencies.first_seen_at, EXCLUDED.first_seen_at),
                           EXCLUDED.first_seen_at
                         );

-- ════════════════════════════════════════════════════════════════════════
-- PART A.3 — Recompute integrity scores for freshly bridged agents
-- ════════════════════════════════════════════════════════════════════════
-- Bridge agents were inserted with score=30 as a safe baseline. Run the
-- canonical recompute so (e.g.) an agent whose `agency_name` was populated
-- from the listing bumps a few points above the raw baseline.
DO $$
DECLARE
  agent_row RECORD;
BEGIN
  FOR agent_row IN
    SELECT id FROM pulse_agents WHERE source = 'rea_listings_bridge'
  LOOP
    PERFORM pulse_recompute_agent_score(agent_row.id);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- PART B — AFTER INSERT OR UPDATE trigger on pulse_listings
-- ════════════════════════════════════════════════════════════════════════
-- Every new listing (or updated listing whose agent/agency references
-- changed) runs this. Idempotent: ON CONFLICT DO NOTHING so a follow-up
-- websift run never gets clobbered.
CREATE OR REPLACE FUNCTION public.pulse_bridge_from_listing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Agent bridge ─────────────────────────────────────────────────────────
  IF NEW.agent_rea_id IS NOT NULL AND NEW.agent_name IS NOT NULL THEN
    -- INSERT first (majority case: brand-new agent). Fall back to an
    -- idempotent NULL-only UPDATE if the row already exists — so we don't
    -- overwrite websift-gathered email/mobile/photo.
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
      last_sync_log_id = COALESCE(EXCLUDED.last_sync_log_id, pulse_agents.last_sync_log_id);
  END IF;

  -- Agency bridge ────────────────────────────────────────────────────────
  IF NEW.agency_rea_id IS NOT NULL AND NEW.agency_name IS NOT NULL THEN
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
      last_sync_log_id = COALESCE(EXCLUDED.last_sync_log_id, pulse_agencies.last_sync_log_id);
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
  'AFTER INSERT/UPDATE trigger on pulse_listings. Ensures every agent_rea_id and agency_rea_id referenced on a listing has at least a minimal row in pulse_agents / pulse_agencies so the UI never shows "not yet synced" for an agent we clearly know exists. Idempotent and non-destructive: never overwrites non-null fields on existing rows. Tagged source=rea_listings_bridge, data_integrity_score=30. Added migration 122.';

-- Drop & recreate to stay idempotent when the migration is re-applied.
DROP TRIGGER IF EXISTS trg_pulse_bridge_from_listing ON pulse_listings;
CREATE TRIGGER trg_pulse_bridge_from_listing
  AFTER INSERT OR UPDATE OF agent_rea_id, agency_rea_id, agent_name, agency_name
  ON pulse_listings
  FOR EACH ROW
  WHEN (NEW.agent_rea_id IS NOT NULL OR NEW.agency_rea_id IS NOT NULL)
  EXECUTE FUNCTION pulse_bridge_from_listing();

COMMIT;

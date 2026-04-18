-- Migration 123 — DB integrity hardening (DB01 FKs, DB02 timeline anchors,
--                                        DB03 denormalized UUID backfill,
--                                        DB09 sold_date proxy)
--
-- ── Scope ────────────────────────────────────────────────────────────────
-- Audit finding DB01: only 3 FKs exist on pulse_* tables; the three most
--   consequential referential relationships (listing→agent, listing→agency,
--   agent→agency) are unenforced. Add them DEFERRABLE INITIALLY DEFERRED
--   ON DELETE SET NULL so a deleted agency doesn't cascade to listings but
--   the reference is cleared.
--
-- Audit finding DB02: 2,275 pulse_timeline rows with no pulse_entity_id.
--   Backfill agent events via `rea_id` lookup (exact match, fast,
--   unambiguous). Listing events are structurally aggregate rollups
--   ("500 new listings detected") and don't have a single entity to anchor
--   to — leave them as-is with a note. Report how many are genuinely
--   unanchorable.
--
-- Audit finding DB03: 6,378 listings missing `agent_pulse_id`, 6,305
--   missing `agency_pulse_id`, 2,854 agents missing `linked_agency_pulse_id`.
--   Backfill via rea_id joins and install a BEFORE INSERT/UPDATE trigger
--   that keeps these denormalized UUID columns in sync with the rea_id
--   references on every write.
--
-- Audit finding DB09: 794 sold listings with NULL sold_date. Inspection
--   shows all 794 also have NULL first_seen_at (they're direct websift
--   inserts that bypassed the list-scrape path). Fallback proxy chain:
--   COALESCE(first_seen_at, created_at) — all 794 created_at values are
--   within the last 12 months, so the 12-month recency guard still applies.
--   Mark filled rows with sold_date_inferred=true so downstream code knows
--   it's a proxy.
--
-- ── Safety ──────────────────────────────────────────────────────────────
-- * FK adds use NOT VALID + separate VALIDATE CONSTRAINT so no table lock.
-- * Before VALIDATE, null-out orphan references (they point to nothing
--   real — so preserving them enforces nothing). The bridge trigger from
--   migration 122 will re-create proper rows the next time those refs
--   appear on a scrape, and the denormalized-UUID trigger in Part C keeps
--   them correct thereafter.
-- * All backfills are idempotent: re-running this migration is a no-op.

-- NB: this migration is split into five transactions. Postgres disallows
-- ALTER TABLE ... VALIDATE CONSTRAINT in the same transaction as data
-- UPDATEs on that table with pending trigger events. Running the DDL in
-- its own transaction keeps each step simple and recoverable.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- PART A — Pre-FK cleanup: null out orphan rea_id references
-- ════════════════════════════════════════════════════════════════════════
-- There are currently:
--   * 0   listings with agent_rea_id not in pulse_agents (migration 122 fixed)
--   * ~15 listings with agency_rea_id not in pulse_agencies (corner cases
--         where agency_rea_id arrived without agency_name, so the bridge
--         skipped them)
--   * ~10 agents with agency_rea_id not in pulse_agencies (same cause)
-- Null them so the FK VALIDATE succeeds. The bridge trigger will re-fill
-- them the moment real data for that agency arrives.

UPDATE pulse_listings l
SET agency_rea_id = NULL
WHERE l.agency_rea_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = l.agency_rea_id
  );

UPDATE pulse_agents pa
SET agency_rea_id = NULL
WHERE pa.agency_rea_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = pa.agency_rea_id
  );

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- PART B — DB01: Add three foreign keys (DEFERRABLE, ON DELETE SET NULL)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;
-- pulse_agents.rea_agent_id   already has UNIQUE constraint.
-- pulse_agencies.rea_agency_id is indexed but not UNIQUE — add UNIQUE so
-- we can reference it. rea_agency_id already has 1,483 distinct values
-- across 1,483 non-null rows (verified) so UNIQUE succeeds.

-- B.1 — Add UNIQUE constraint on pulse_agencies.rea_agency_id (required by FK)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pulse_agencies_rea_agency_id_unique'
      AND conrelid = 'public.pulse_agencies'::regclass
  ) THEN
    ALTER TABLE pulse_agencies
      ADD CONSTRAINT pulse_agencies_rea_agency_id_unique
      UNIQUE (rea_agency_id);
  END IF;
END $$;

-- B.2 — pulse_listings.agent_rea_id → pulse_agents.rea_agent_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pulse_listings_agent_rea_id_fkey'
      AND conrelid = 'public.pulse_listings'::regclass
  ) THEN
    ALTER TABLE pulse_listings
      ADD CONSTRAINT pulse_listings_agent_rea_id_fkey
      FOREIGN KEY (agent_rea_id)
      REFERENCES pulse_agents(rea_agent_id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

ALTER TABLE pulse_listings
  VALIDATE CONSTRAINT pulse_listings_agent_rea_id_fkey;

-- B.3 — pulse_listings.agency_rea_id → pulse_agencies.rea_agency_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pulse_listings_agency_rea_id_fkey'
      AND conrelid = 'public.pulse_listings'::regclass
  ) THEN
    ALTER TABLE pulse_listings
      ADD CONSTRAINT pulse_listings_agency_rea_id_fkey
      FOREIGN KEY (agency_rea_id)
      REFERENCES pulse_agencies(rea_agency_id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

ALTER TABLE pulse_listings
  VALIDATE CONSTRAINT pulse_listings_agency_rea_id_fkey;

-- B.4 — pulse_agents.agency_rea_id → pulse_agencies.rea_agency_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pulse_agents_agency_rea_id_fkey'
      AND conrelid = 'public.pulse_agents'::regclass
  ) THEN
    ALTER TABLE pulse_agents
      ADD CONSTRAINT pulse_agents_agency_rea_id_fkey
      FOREIGN KEY (agency_rea_id)
      REFERENCES pulse_agencies(rea_agency_id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED
      NOT VALID;
  END IF;
END $$;

ALTER TABLE pulse_agents
  VALIDATE CONSTRAINT pulse_agents_agency_rea_id_fkey;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- PART C — DB03: Backfill denormalized UUID columns + trigger
-- ════════════════════════════════════════════════════════════════════════
BEGIN;
-- Listing -> agent
UPDATE pulse_listings l
SET agent_pulse_id = pa.id
FROM pulse_agents pa
WHERE l.agent_rea_id = pa.rea_agent_id
  AND l.agent_pulse_id IS NULL;

-- Listing -> agency
UPDATE pulse_listings l
SET agency_pulse_id = ag.id
FROM pulse_agencies ag
WHERE l.agency_rea_id = ag.rea_agency_id
  AND l.agency_pulse_id IS NULL;

-- Agent -> agency (linked_agency_pulse_id)
UPDATE pulse_agents pa
SET linked_agency_pulse_id = ag.id
FROM pulse_agencies ag
WHERE pa.agency_rea_id = ag.rea_agency_id
  AND pa.linked_agency_pulse_id IS NULL;

-- C.1 — Trigger function: maintain denormalized UUIDs on pulse_listings
CREATE OR REPLACE FUNCTION public.pulse_listings_sync_denorm_ids()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- agent_pulse_id mirrors agent_rea_id -> pulse_agents.id
  IF NEW.agent_rea_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.agent_rea_id IS DISTINCT FROM OLD.agent_rea_id
          OR NEW.agent_pulse_id IS NULL) THEN
    SELECT pa.id
      INTO NEW.agent_pulse_id
      FROM pulse_agents pa
     WHERE pa.rea_agent_id = NEW.agent_rea_id
     LIMIT 1;
  ELSIF NEW.agent_rea_id IS NULL THEN
    NEW.agent_pulse_id := NULL;
  END IF;

  -- agency_pulse_id mirrors agency_rea_id -> pulse_agencies.id
  IF NEW.agency_rea_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.agency_rea_id IS DISTINCT FROM OLD.agency_rea_id
          OR NEW.agency_pulse_id IS NULL) THEN
    SELECT ag.id
      INTO NEW.agency_pulse_id
      FROM pulse_agencies ag
     WHERE ag.rea_agency_id = NEW.agency_rea_id
     LIMIT 1;
  ELSIF NEW.agency_rea_id IS NULL THEN
    NEW.agency_pulse_id := NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pulse_listings_sync_denorm_ids() IS
  'BEFORE INSERT/UPDATE trigger on pulse_listings. Keeps agent_pulse_id and agency_pulse_id in sync with agent_rea_id / agency_rea_id. Prevents denormalized UUID drift. Added migration 123.';

DROP TRIGGER IF EXISTS trg_pulse_listings_sync_denorm_ids ON pulse_listings;
CREATE TRIGGER trg_pulse_listings_sync_denorm_ids
  BEFORE INSERT OR UPDATE OF agent_rea_id, agency_rea_id, agent_pulse_id, agency_pulse_id
  ON pulse_listings
  FOR EACH ROW
  EXECUTE FUNCTION pulse_listings_sync_denorm_ids();

-- C.1b — AFTER INSERT fallback to close the race with trg_pulse_bridge_from_listing
-- When a listing arrives with a never-before-seen agent_rea_id, the BEFORE
-- sync trigger finds no matching pulse_agents row and sets agent_pulse_id=NULL.
-- The AFTER bridge trigger (migration 122) then creates the minimal
-- pulse_agents row. This AFTER-INSERT sweep runs last and backfills the
-- NULL. Guarded by pg_trigger_depth() to prevent recursion.
CREATE OR REPLACE FUNCTION public.pulse_listings_resolve_denorm_ids_after()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_agent_id uuid;
  v_agency_id uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_pulse_id IS NULL AND NEW.agent_rea_id IS NOT NULL THEN
    SELECT id INTO v_agent_id FROM pulse_agents WHERE rea_agent_id = NEW.agent_rea_id LIMIT 1;
  END IF;
  IF NEW.agency_pulse_id IS NULL AND NEW.agency_rea_id IS NOT NULL THEN
    SELECT id INTO v_agency_id FROM pulse_agencies WHERE rea_agency_id = NEW.agency_rea_id LIMIT 1;
  END IF;

  IF v_agent_id IS NOT NULL OR v_agency_id IS NOT NULL THEN
    UPDATE pulse_listings
       SET agent_pulse_id  = COALESCE(v_agent_id,  agent_pulse_id),
           agency_pulse_id = COALESCE(v_agency_id, agency_pulse_id)
     WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pulse_listings_resolve_denorm_ids_after() IS
  'AFTER INSERT trigger on pulse_listings. Closes the race where the BEFORE sync trigger runs before the AFTER bridge trigger has created the pulse_agents/pulse_agencies row. pg_trigger_depth guard prevents recursion. Added migration 123.';

DROP TRIGGER IF EXISTS trg_pulse_listings_resolve_denorm_ids_after ON pulse_listings;
CREATE TRIGGER trg_pulse_listings_resolve_denorm_ids_after
  AFTER INSERT ON pulse_listings
  FOR EACH ROW
  WHEN (NEW.agent_pulse_id IS NULL OR NEW.agency_pulse_id IS NULL)
  EXECUTE FUNCTION pulse_listings_resolve_denorm_ids_after();

-- C.2 — Trigger function: maintain linked_agency_pulse_id on pulse_agents
CREATE OR REPLACE FUNCTION public.pulse_agents_sync_denorm_ids()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.agency_rea_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.agency_rea_id IS DISTINCT FROM OLD.agency_rea_id
          OR NEW.linked_agency_pulse_id IS NULL) THEN
    SELECT ag.id
      INTO NEW.linked_agency_pulse_id
      FROM pulse_agencies ag
     WHERE ag.rea_agency_id = NEW.agency_rea_id
     LIMIT 1;
  ELSIF NEW.agency_rea_id IS NULL THEN
    NEW.linked_agency_pulse_id := NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.pulse_agents_sync_denorm_ids() IS
  'BEFORE INSERT/UPDATE trigger on pulse_agents. Keeps linked_agency_pulse_id in sync with agency_rea_id. Prevents denormalized UUID drift. Added migration 123.';

DROP TRIGGER IF EXISTS trg_pulse_agents_sync_denorm_ids ON pulse_agents;
CREATE TRIGGER trg_pulse_agents_sync_denorm_ids
  BEFORE INSERT OR UPDATE OF agency_rea_id, linked_agency_pulse_id
  ON pulse_agents
  FOR EACH ROW
  EXECUTE FUNCTION pulse_agents_sync_denorm_ids();

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- PART D — DB02: Backfill pulse_timeline.pulse_entity_id where inferable
-- ════════════════════════════════════════════════════════════════════════
BEGIN;
-- Anchor agent events by exact rea_id match. 590 of 693 unanchored agent
-- rows are recoverable this way. Listing events are almost entirely
-- aggregate rollups ("500 new listings detected" — no single entity to
-- anchor to). Leave them as-is; the report at the end quantifies what
-- remained.

UPDATE pulse_timeline t
SET pulse_entity_id = pa.id
FROM pulse_agents pa
WHERE t.entity_type = 'agent'
  AND t.pulse_entity_id IS NULL
  AND t.rea_id IS NOT NULL
  AND t.rea_id = pa.rea_agent_id;

-- Listing status_change / price_change events with a single-item
-- description ("<address>: <before> → <after>") — attempt to extract the
-- address and match against pulse_listings by address. Only anchor when
-- the match is unambiguous (exactly one listing found).
UPDATE pulse_timeline t
SET pulse_entity_id = matched.listing_id
FROM (
  SELECT
    tt.id AS timeline_id,
    (array_agg(l.id))[1] AS listing_id,
    COUNT(l.id) AS match_count
  FROM pulse_timeline tt
  LEFT JOIN pulse_listings l
    ON l.address IS NOT NULL
   AND tt.description LIKE (l.address || ':%')
  WHERE tt.entity_type = 'listing'
    AND tt.pulse_entity_id IS NULL
    AND tt.event_type IN ('status_change', 'price_change')
    AND tt.description ~ '^[^;]+:'
    AND tt.description NOT LIKE '%;%'  -- single-item only
  GROUP BY tt.id
) matched
WHERE t.id = matched.timeline_id
  AND matched.match_count = 1
  AND matched.listing_id IS NOT NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- PART E — DB09: Backfill sold_date for sold listings (recent only)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;
-- Add sold_date_inferred marker column first (idempotent).
ALTER TABLE pulse_listings
  ADD COLUMN IF NOT EXISTS sold_date_inferred BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pulse_listings.sold_date_inferred IS
  'TRUE when sold_date was inferred from COALESCE(first_seen_at, created_at) rather than pulled from source data. Downstream consumers should treat inferred dates as approximate. Added migration 123 (DB09).';

-- All 794 sold-no-date rows happen to have NULL first_seen_at (they came
-- from a websift path that bypassed list-scrape). Fall back to created_at,
-- which is always non-null. Still honour the 12-month recency guard so we
-- never mark ancient rows as "recently sold".
UPDATE pulse_listings
SET sold_date = COALESCE(first_seen_at, created_at)::date,
    sold_date_inferred = TRUE
WHERE lower(status) = 'sold'
  AND sold_date IS NULL
  AND COALESCE(first_seen_at, created_at) >= now() - interval '12 months'
  AND COALESCE(first_seen_at, created_at) IS NOT NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- PART F — Post-migration integrity report (logged via RAISE NOTICE)
-- ════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v_listing_agent_orphans int;
  v_listing_agency_orphans int;
  v_agent_agency_orphans int;
  v_timeline_unanchored int;
  v_timeline_agent_unanchored int;
  v_timeline_listing_unanchored int;
  v_listings_missing_agent_pulse int;
  v_listings_missing_agency_pulse int;
  v_agents_missing_agency_pulse int;
  v_sold_no_date int;
  v_sold_inferred int;
BEGIN
  SELECT COUNT(*) INTO v_listing_agent_orphans
    FROM pulse_listings l
   WHERE l.agent_rea_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pulse_agents pa WHERE pa.rea_agent_id = l.agent_rea_id);

  SELECT COUNT(*) INTO v_listing_agency_orphans
    FROM pulse_listings l
   WHERE l.agency_rea_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = l.agency_rea_id);

  SELECT COUNT(*) INTO v_agent_agency_orphans
    FROM pulse_agents pa
   WHERE pa.agency_rea_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = pa.agency_rea_id);

  SELECT
    COUNT(*) FILTER (WHERE pulse_entity_id IS NULL),
    COUNT(*) FILTER (WHERE pulse_entity_id IS NULL AND entity_type = 'agent'),
    COUNT(*) FILTER (WHERE pulse_entity_id IS NULL AND entity_type = 'listing')
    INTO v_timeline_unanchored, v_timeline_agent_unanchored, v_timeline_listing_unanchored
    FROM pulse_timeline;

  SELECT
    COUNT(*) FILTER (WHERE agent_pulse_id IS NULL AND agent_rea_id IS NOT NULL),
    COUNT(*) FILTER (WHERE agency_pulse_id IS NULL AND agency_rea_id IS NOT NULL)
    INTO v_listings_missing_agent_pulse, v_listings_missing_agency_pulse
    FROM pulse_listings;

  SELECT COUNT(*) INTO v_agents_missing_agency_pulse
    FROM pulse_agents
   WHERE linked_agency_pulse_id IS NULL AND agency_rea_id IS NOT NULL;

  SELECT
    COUNT(*) FILTER (WHERE lower(status) = 'sold' AND sold_date IS NULL),
    COUNT(*) FILTER (WHERE sold_date_inferred = TRUE)
    INTO v_sold_no_date, v_sold_inferred
    FROM pulse_listings;

  RAISE NOTICE '=== Migration 123 post-integrity report ===';
  RAISE NOTICE 'DB01 (orphan FK references): listing->agent=%, listing->agency=%, agent->agency=%',
    v_listing_agent_orphans, v_listing_agency_orphans, v_agent_agency_orphans;
  RAISE NOTICE 'DB02 (timeline unanchored): total=%, agent=%, listing=%',
    v_timeline_unanchored, v_timeline_agent_unanchored, v_timeline_listing_unanchored;
  RAISE NOTICE 'DB03 (denormalized UUID gaps): listings missing agent_pulse_id=%, listings missing agency_pulse_id=%, agents missing linked_agency_pulse_id=%',
    v_listings_missing_agent_pulse, v_listings_missing_agency_pulse, v_agents_missing_agency_pulse;
  RAISE NOTICE 'DB09 (sold listings): still missing sold_date=%, inferred=%',
    v_sold_no_date, v_sold_inferred;
END $$;

COMMIT;

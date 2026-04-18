-- 124_performance_indexes.sql
-- Performance round-5: indexes + search_text for pulse_listings that mirror
-- the pulse_agents/pulse_agencies pattern from migration 114. Addresses:
--
--   PF02  OR-ilike on pulse_listings replaced by single ilike on search_text
--         backed by a GIN trigram index (same path as agents/agencies).
--   PF05  created_at DESC + last_synced_at DESC btree indexes.
--   PF07  Case-insensitive agency_name indexes on pulse_listings + pulse_agents
--         for the reconciler's agency-name fallback join.
--   PF12  GIN trigram on pulse_agents.agency_name for the agency_name ilike
--         column filter in the Agents tab.
--
-- Plus: drop three duplicate indexes surfaced by the index audit.
--
-- The CONCURRENTLY index operations and the drops run OUTSIDE the transaction
-- via the Management API (each -- ^^ CONCURRENT ^^ block is a separate
-- statement). Only the ALTER TABLE / trigger / backfill pieces run in the
-- explicit BEGIN..COMMIT below, matching the pattern used by migration 114.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── PF02: pulse_listings.search_text ─────────────────────────────────────
ALTER TABLE pulse_listings ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE OR REPLACE FUNCTION pulse_listings_build_search_text() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := LOWER(
    COALESCE(NEW.address, '') || ' ' ||
    COALESCE(NEW.suburb, '') || ' ' ||
    COALESCE(NEW.postcode, '') || ' ' ||
    COALESCE(NEW.agent_name, '') || ' ' ||
    COALESCE(NEW.agency_name, '') || ' ' ||
    COALESCE(NEW.price_text, '') || ' ' ||
    COALESCE(NEW.property_type, '') || ' ' ||
    COALESCE(NEW.listing_type, '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_listings_search_text_trg ON pulse_listings;
CREATE TRIGGER pulse_listings_search_text_trg
  BEFORE INSERT OR UPDATE ON pulse_listings
  FOR EACH ROW EXECUTE FUNCTION pulse_listings_build_search_text();

-- Backfill: trigger fires on UPDATE. Touch every row that hasn't been indexed.
UPDATE pulse_listings
   SET address = address
 WHERE search_text IS NULL OR search_text = '';

COMMENT ON COLUMN pulse_listings.search_text IS
  'Trigger-maintained lowercased concat of address, suburb, postcode, '
  'agent_name, agency_name, price_text, property_type, listing_type. '
  'Backed by GIN trigram index for fast ilike substring search.';

COMMIT;

-- ── CONCURRENT index creations (run outside tx, one at a time) ───────────
-- Each of these is a separate statement submitted without an explicit BEGIN
-- (postgres rejects CONCURRENTLY inside a txn). The migration runner posts
-- each as its own Management API query call.

-- PF02: trigram on the new search_text column
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_search_text_trgm
  ON pulse_listings USING gin (search_text gin_trgm_ops);

-- PF05: created_at and last_synced_at for default ordering + staleness queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_created_at
  ON pulse_listings (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_last_synced_at
  ON pulse_listings (last_synced_at DESC);

-- PF07: case-insensitive agency_name for reconciler fallback joins
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_agency_name_lower
  ON pulse_listings (lower(trim(agency_name)))
  WHERE agency_name IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_agency_name_lower
  ON pulse_agents (lower(trim(agency_name)))
  WHERE agency_name IS NOT NULL;

-- PF12: trigram on pulse_agents.agency_name for the column-filter ilike
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_agency_name_trgm
  ON pulse_agents USING gin (agency_name gin_trgm_ops);

-- ── Drop verified duplicate indexes ──────────────────────────────────────
-- Verified via pg_indexes on 2026-04-18:
--   pulse_listings: idx_pulse_listings_agency_rea == idx_pulse_listings_agency_rea_id
--                   idx_pulse_listings_agent_rea  == idx_pulse_listings_agent_rea_id
--   pulse_agents:   idx_pulse_agents_rea_agent_id (non-unique) vs
--                   idx_pulse_agents_rea_id (UNIQUE) — drop the non-unique one
--                   so the UNIQUE stays as the enforcement index.

DROP INDEX IF EXISTS idx_pulse_listings_agency_rea_id;
DROP INDEX IF EXISTS idx_pulse_listings_agent_rea_id;
DROP INDEX IF EXISTS idx_pulse_agents_rea_agent_id;

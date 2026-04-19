-- 200_legacy_reconciliation_perf.sql
-- Fix the Legacy Pulse Reconciliation page (/Settings/LegacyCrmReconciliation)
-- hanging / not loading. The review RPC runs similarity() on
-- legacy_normalize_person_name(full_name) but the existing trigram indexes
-- target the raw `full_name` / `name` columns, so PG falls back to a Seq Scan
-- per row — 1.6s × 25 rows = ~40s, which makes the page look dead.
--
-- Add functional GIN indexes on the normalized expression. legacy_normalize_*
-- are IMMUTABLE so they're safely indexable. After this the similarity
-- sort can use the index and each candidate lookup drops from ~1.5s to ~5ms.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction — this
-- migration intentionally does NOT wrap in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_normfullname_trgm
  ON pulse_agents USING gin (legacy_normalize_person_name(full_name) gin_trgm_ops)
  WHERE full_name IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agencies_normname_trgm
  ON pulse_agencies USING gin (legacy_normalize_person_name(name) gin_trgm_ops)
  WHERE name IS NOT NULL;

-- Also create indexes for agency_name matches on pulse_agents (the "agency
-- name of the agent's agency" path — used elsewhere in reconciliation):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_normagencyname_trgm
  ON pulse_agents USING gin (legacy_normalize_person_name(agency_name) gin_trgm_ops)
  WHERE agency_name IS NOT NULL;

ANALYZE pulse_agents;
ANALYZE pulse_agencies;

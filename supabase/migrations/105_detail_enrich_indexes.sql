-- 105_detail_enrich_indexes.sql
-- Indexes required to keep detail-enrichment + alternates-aware CRM matching
-- performant. All CONCURRENTLY so no table lock on prod.
--
-- Postgres requires CONCURRENTLY CREATE INDEX to be OUTSIDE a transaction
-- block. The migration runner must invoke this file in autocommit mode.

-- ── GIN on alternate jsonb columns ────────────────────────────────────────
-- Needed for pulseDataSync Step 10a CRM mapping expansion:
--   WHERE alternate_mobiles @> '[{"value":"0414xxx"}]'
-- Without this: every cron run sequential-scans pulse_agents.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_alternate_emails
  ON pulse_agents USING gin (alternate_emails);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_alternate_mobiles
  ON pulse_agents USING gin (alternate_mobiles);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agents_alternate_phones
  ON pulse_agents USING gin (alternate_phones);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agencies_alternate_emails
  ON pulse_agencies USING gin (alternate_emails);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_agencies_alternate_phones
  ON pulse_agencies USING gin (alternate_phones);

-- ── Index for "listings needing enrich" (ORDER BY hot path) ──────────────
-- The pulseDetailEnrich candidate-selection query sorts by
-- detail_enriched_at NULLS FIRST, then last_synced_at DESC, to pick the
-- stalest first. Postgres rejects a partial predicate involving column-to-
-- column arithmetic (requires IMMUTABLE), so we use a plain btree and let
-- the query planner handle the WHERE clause.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_needs_detail_enrich
  ON pulse_listings (detail_enriched_at NULLS FIRST, last_synced_at DESC);

-- ── Secondary index on listing_withdrawn_at for timeline queries ─────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_withdrawn_at
  ON pulse_listings (listing_withdrawn_at DESC)
  WHERE listing_withdrawn_at IS NOT NULL;

-- ── GIN on media_items for potential future drill queries ────────────────
-- Not expected to be hot; include for future-proofing. Small index.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_media_items
  ON pulse_listings USING gin (media_items)
  WHERE media_items IS NOT NULL;

-- Comments
COMMENT ON INDEX idx_pulse_agents_alternate_emails IS
  'Supports alternates-aware CRM email matching in pulseDataSync Step 10.';
COMMENT ON INDEX idx_pulse_listings_needs_detail_enrich IS
  'Partial index covering only rows that pulseDetailEnrich needs to consider.';

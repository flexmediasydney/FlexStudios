-- 100_pulse_entity_sync_history_plus_backfill.sql
-- Part of the multi-tier Industry Pulse quality overhaul (Apr 2026).
--
-- Does three things:
--   (1) Creates pulse_entity_sync_history — full audit trail of which sync
--       runs touched each pulse entity (agent / agency / listing). Backbone
--       for the "View source payload" drill-through on every record (Tier 4).
--   (2) Backfills historical sold_price / listed_date data: azzouzana
--       payloads never return soldPrice / listedDate fields, so our extractor
--       wrote the sold price to asking_price (wrong column) and left
--       listed_date NULL. Fixes 1,908 sold listings and 6,432 null dates.
--   (3) Adds a last_sync_log_id pointer on pulse_agents/agencies/listings
--       for the "single-source drill" convenience, even though the full
--       history lives in pulse_entity_sync_history.

BEGIN;

-- ── (1) pulse_entity_sync_history ────────────────────────────────────────
-- One row per (entity, sync_log) pair capturing what happened in that run.
-- When an entity gets touched N times by N different syncs, we get N rows.
-- Used by:
--   - UI "View source" drill on every agent/agency/listing surface
--   - Debugging "which run gave us this bad data"
--   - Detecting agents/listings that haven't been refreshed in X days
CREATE TABLE IF NOT EXISTS pulse_entity_sync_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('agent', 'agency', 'listing')),
  entity_id        UUID NOT NULL,        -- FK to pulse_agents.id / pulse_agencies.id / pulse_listings.id
  entity_key       TEXT,                  -- rea_agent_id / rea_agency_id / source_listing_id (for easy lookup)
  sync_log_id      UUID,                  -- FK to pulse_sync_logs.id (nullable since pulse_sync_logs may be TTL'd)
  action           TEXT NOT NULL CHECK (action IN ('created', 'updated', 'cross_enriched', 'reconciled', 'flagged')),
  changes_summary  JSONB,                 -- { fields_changed: [...], old/new snippets }
  source           TEXT,                  -- e.g. 'rea_agents', 'rea_listings_bb_buy', 'reconciler'
  seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: "show me the history for THIS entity" (drill dialog query)
CREATE INDEX IF NOT EXISTS idx_pulse_entity_sync_history_entity
  ON pulse_entity_sync_history (entity_type, entity_id, seen_at DESC);

-- Lookup by sync_log_id for "what did this run touch"
CREATE INDEX IF NOT EXISTS idx_pulse_entity_sync_history_sync_log
  ON pulse_entity_sync_history (sync_log_id) WHERE sync_log_id IS NOT NULL;

-- Lookup by external key (agent's rea_id, listing's source_listing_id)
CREATE INDEX IF NOT EXISTS idx_pulse_entity_sync_history_key
  ON pulse_entity_sync_history (entity_type, entity_key) WHERE entity_key IS NOT NULL;

COMMENT ON TABLE pulse_entity_sync_history IS
  'Per-entity audit trail of which pulse sync runs touched each agent/agency/listing. '
  'Backs the "View source" drill-through UI and debugging workflows. Full history — '
  'NOT deduped per entity. Use sync_log_id to join back to pulse_sync_logs. Subject '
  'to TTL (future migration).';

-- ── (2) last_sync_log_id convenience columns ────────────────────────────
-- Most-recent sync_log_id per entity, for the "quick drill" affordance.
-- Maintained by pulseDataSync on every upsert. Derived data — if it drifts,
-- pulse_entity_sync_history is the source of truth.
ALTER TABLE pulse_agents    ADD COLUMN IF NOT EXISTS last_sync_log_id UUID;
ALTER TABLE pulse_agencies  ADD COLUMN IF NOT EXISTS last_sync_log_id UUID;
ALTER TABLE pulse_listings  ADD COLUMN IF NOT EXISTS last_sync_log_id UUID;

-- ── (3) Historical data backfill ────────────────────────────────────────
-- (3a) sold_price lives in asking_price for historical sold listings.
-- Fix: copy asking_price → sold_price for all sold listings where sold_price
-- is NULL. Also null out asking_price on those rows (it's not the asking
-- price, it's the sold price — having it in both columns would let UIs
-- showing asking_price silently show the wrong number).
UPDATE pulse_listings
   SET sold_price   = asking_price,
       asking_price = NULL
 WHERE listing_type = 'sold'
   AND sold_price IS NULL
   AND asking_price IS NOT NULL;

-- (3b) listed_date: azzouzana doesn't return this field. first_seen_at is
-- the next best proxy — when we first captured this listing.
UPDATE pulse_listings
   SET listed_date = first_seen_at::date
 WHERE listed_date IS NULL
   AND first_seen_at IS NOT NULL;

-- (3c) sold_date: if sold and first_seen_at exists, treat first_seen_at as
-- approximate sold_date (we first saw it in "sold" state).
-- Best-effort; imperfect but better than NULL.
UPDATE pulse_listings
   SET sold_date = first_seen_at::date
 WHERE listing_type = 'sold'
   AND sold_date IS NULL
   AND first_seen_at IS NOT NULL;

-- (3d) days_on_market: if we have listed_date and (sold_date OR still active), compute.
UPDATE pulse_listings
   SET days_on_market = CASE
     WHEN sold_date IS NOT NULL AND listed_date IS NOT NULL
       THEN GREATEST(0, (sold_date - listed_date))
     WHEN listing_type IN ('for_sale', 'for_rent', 'under_contract') AND listed_date IS NOT NULL
       THEN GREATEST(0, (CURRENT_DATE - listed_date))
     ELSE days_on_market
   END
 WHERE days_on_market IS NULL
   AND listed_date IS NOT NULL;

COMMIT;

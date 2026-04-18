-- 103_detail_enrich_schema.sql
-- Schema foundation for the REA detail-page enrichment pipeline (Apr 2026).
--
-- Three things:
--   (1) New columns on pulse_listings for fields only available on the detail
--       page (exact dates, floorplans/video, rentals, withdrawn detection)
--   (2) Multi-value contact model on pulse_agents + pulse_agencies — primary
--       text column stays as the "best" value for UI, new JSONB alternates
--       store every other value seen across sources (dedup by value, sources
--       stacked). New source+confidence columns on the primary for provenance.
--   (3) Extend pulse_entity_sync_history.action CHECK constraint to include
--       detail-enrich-specific action types.
--
-- All changes are ADDITIVE — no column drops, no type changes (see 108 for the
-- auction_date type change which comes later). Safe to ship independently.
--
-- Upstream context: see /Users/josephsaad/.claude/plans/quizzical-pondering-valley.md
-- and prior session analysis — direct REA scrape confirmed blocked by Kasada;
-- memo23/realestate-au-listings Apify actor is the enrichment source
-- ($0.001/listing, returns listing.dateSold/auctionTime/dateAvailable + direct
-- lister/agency contacts + floorplan/video tagged media).

BEGIN;

-- ── (1) pulse_listings detail-enrich columns ─────────────────────────────
ALTER TABLE pulse_listings
  ADD COLUMN IF NOT EXISTS detail_enriched_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS detail_enrich_count  INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS date_available       DATE,         -- rentals: dateAvailable.date
  ADD COLUMN IF NOT EXISTS land_size_sqm        NUMERIC,      -- parsed numeric alongside text land_size
  ADD COLUMN IF NOT EXISTS floorplan_urls       TEXT[],       -- array — some listings have 2+ floorplans
  ADD COLUMN IF NOT EXISTS video_url            TEXT,         -- YouTube URL (REA only embeds 1 video)
  ADD COLUMN IF NOT EXISTS video_thumb_url      TEXT,         -- for lightweight UI preview
  ADD COLUMN IF NOT EXISTS media_items          JSONB,        -- full structured [{type, url, thumb, order_index}]
  ADD COLUMN IF NOT EXISTS listing_withdrawn_at TIMESTAMPTZ,  -- set when URL absent from memo23 response
  ADD COLUMN IF NOT EXISTS listing_withdrawn_reason TEXT;     -- 'absent_from_rea' | 'moved_to_sold' | ...

COMMENT ON COLUMN pulse_listings.detail_enriched_at IS
  'Most recent successful pulseDetailEnrich run. NULL = never enriched. Used by the cron''s candidate-selection query (enrich stale first).';
COMMENT ON COLUMN pulse_listings.date_available IS
  'Rental availability date from listing.dateAvailable.date on the detail page. NULL for sale/sold.';
COMMENT ON COLUMN pulse_listings.floorplan_urls IS
  'Full URLs of floorplan images (from listing.images[].name=="floorplan"). Empty array = no floorplan disclosed.';
COMMENT ON COLUMN pulse_listings.video_url IS
  'YouTube video URL (https://www.youtube.com/watch?v=...). NULL = no video disclosed.';
COMMENT ON COLUMN pulse_listings.media_items IS
  'Full structured media list from detail page: [{type: photo|floorplan|video, url, thumb, order_index}]. Use this over the flat images[] array when present.';
COMMENT ON COLUMN pulse_listings.listing_withdrawn_at IS
  'When pulseDetailEnrich detected the listing had disappeared from REA (URL returned empty, not moved to sold). Proxy for withdrawn-from-sale date.';

-- ── (2a) pulse_agents multi-value contact columns ─────────────────────────
ALTER TABLE pulse_agents
  ADD COLUMN IF NOT EXISTS email_source           TEXT,              -- 'detail_page_lister' | 'websift_profile' | 'list_enrich' | 'legacy'
  ADD COLUMN IF NOT EXISTS email_confidence       SMALLINT,          -- 0-100, driven by source trust tier
  ADD COLUMN IF NOT EXISTS alternate_emails       JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mobile_source          TEXT,
  ADD COLUMN IF NOT EXISTS mobile_confidence      SMALLINT,
  ADD COLUMN IF NOT EXISTS alternate_mobiles      JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS business_phone_source  TEXT,
  ADD COLUMN IF NOT EXISTS business_phone_confidence SMALLINT,
  ADD COLUMN IF NOT EXISTS alternate_phones       JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN pulse_agents.alternate_emails IS
  'Every email value seen across sources, deduped by value. Shape: [{"value":"x@y.com","sources":["detail_page","websift"],"confidence":95,"first_seen_at":"...","last_seen_at":"..."}]. Primary email lives in email column. Capped at 10 entries (LRU).';
COMMENT ON COLUMN pulse_agents.email_source IS
  'Source that contributed the current primary email. Detail > websift > list_enrich > legacy.';
COMMENT ON COLUMN pulse_agents.email_confidence IS
  'Trust score for the current primary email (0-100). Detail-sourced = 95, websift = 90, list = 70, legacy = 60.';

-- ── (2b) pulse_agencies — email is NEW (never had one before), + multi-value ─
ALTER TABLE pulse_agencies
  ADD COLUMN IF NOT EXISTS email                TEXT,              -- new — detail page gives us agency.email directly
  ADD COLUMN IF NOT EXISTS email_source         TEXT,
  ADD COLUMN IF NOT EXISTS email_confidence     SMALLINT,
  ADD COLUMN IF NOT EXISTS alternate_emails     JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS phone_source         TEXT,
  ADD COLUMN IF NOT EXISTS phone_confidence     SMALLINT,
  ADD COLUMN IF NOT EXISTS alternate_phones     JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS website              TEXT,              -- listing.agency.website
  ADD COLUMN IF NOT EXISTS address_street       TEXT,              -- listing.agency.address.streetAddress
  ADD COLUMN IF NOT EXISTS brand_color_primary  TEXT,              -- listing.agency.brandingColors.primary
  ADD COLUMN IF NOT EXISTS brand_color_text     TEXT;              -- listing.agency.brandingColors.text

COMMENT ON COLUMN pulse_agencies.email IS
  'Primary agency email from detail page listing.agency._links or scraped body. NEW column — previously agencies had no email.';
COMMENT ON COLUMN pulse_agencies.brand_color_primary IS
  'Agency brand primary colour (hex). From listing.agency.brandingColors.primary. Useful for rendering branded agency tiles.';

-- ── (3) Extend pulse_entity_sync_history.action CHECK constraint ──────────
-- Migration 100 restricted action to 5 values; detail enrich needs 4 more.
-- CHECK constraints don''t support ALTER ADD VALUE, so drop-and-re-add.
ALTER TABLE pulse_entity_sync_history
  DROP CONSTRAINT IF EXISTS pulse_entity_sync_history_action_check;
ALTER TABLE pulse_entity_sync_history
  ADD CONSTRAINT pulse_entity_sync_history_action_check
  CHECK (action IN (
    'created', 'updated', 'cross_enriched', 'reconciled', 'flagged',
    'detail_enriched',        -- NEW: pulseDetailEnrich ran against this entity
    'withdrawn_detected',     -- NEW: listing disappeared from REA
    'alternate_value_added',  -- NEW: new email/phone added to alternates without primary change
    'primary_promoted'        -- NEW: primary email/phone was swapped because higher-confidence source arrived
  ));

-- ── (4) Backfill: migrate all_emails → alternate_emails ──────────────────
-- pulse_agents.all_emails (from migration 064) is SUPPOSED to be a jsonb
-- array of strings, but some rows have scalar values (old migrations' drift).
-- Defensive CASE avoids calling jsonb_array_elements_text on a scalar.
UPDATE pulse_agents a
SET alternate_emails = CASE
  WHEN jsonb_typeof(a.all_emails) = 'array' AND jsonb_array_length(a.all_emails) > 0 THEN
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'value',         lower(trim(e)),
          'sources',       '["legacy_all_emails"]'::jsonb,
          'confidence',    50,
          'first_seen_at', COALESCE(a.first_seen_at, a.last_synced_at, now()),
          'last_seen_at',  COALESCE(a.last_synced_at, now())
        )
      )
      FROM jsonb_array_elements_text(a.all_emails) AS e
      WHERE trim(e) <> '' AND e LIKE '%@%'
    ), '[]'::jsonb)
  ELSE '[]'::jsonb
END
WHERE a.all_emails IS NOT NULL
  AND (a.alternate_emails IS NULL OR a.alternate_emails = '[]'::jsonb);

-- Primary-email provenance: stamp existing rows as 'legacy' source
UPDATE pulse_agents
SET email_source = 'legacy',
    email_confidence = 60
WHERE email IS NOT NULL
  AND email_source IS NULL;

UPDATE pulse_agents
SET mobile_source = 'legacy',
    mobile_confidence = 60
WHERE mobile IS NOT NULL
  AND mobile_source IS NULL;

UPDATE pulse_agents
SET business_phone_source = 'legacy',
    business_phone_confidence = 60
WHERE business_phone IS NOT NULL
  AND business_phone_source IS NULL;

UPDATE pulse_agencies
SET phone_source = 'legacy',
    phone_confidence = 60
WHERE phone IS NOT NULL
  AND phone_source IS NULL;

COMMIT;

-- ── Sanity check (run manually after COMMIT) ─────────────────────────────
-- SELECT count(*) FILTER (WHERE email_source IS NOT NULL) AS agents_with_source_stamp,
--        count(*) FILTER (WHERE jsonb_array_length(alternate_emails) > 0) AS agents_with_alternates,
--        count(*) FILTER (WHERE email IS NOT NULL) AS agents_with_primary_email
-- FROM pulse_agents;

-- Migration 154: Schema hygiene
-- ───────────────────────────────────────────────────────────────────
-- Q3 plan Sections A/B/D/E applied in one pass, plus Section E dead-
-- column drops that are safe (grep-confirmed: no pulse_* writer).
--
-- NOTE on CONCURRENTLY: `CREATE INDEX CONCURRENTLY` and `DROP INDEX
-- CONCURRENTLY` cannot run inside a transaction. Supabase's supabase_
-- migrations runner wraps each migration in an implicit tx, so when
-- this file is applied locally via the CLI the CONCURRENTLY clauses
-- must be omitted. We author it this way for the prod rollout which
-- is staged statement-by-statement via the mgmt-API SQL endpoint (no
-- implicit tx wrap there). The IF NOT EXISTS / IF EXISTS guards make
-- each stmt idempotent.
-- ───────────────────────────────────────────────────────────────────

-- ─── Section A: create missing hot-path indexes ─────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_agent_pulse_id
  ON pulse_listings (agent_pulse_id) WHERE agent_pulse_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_agency_pulse_id
  ON pulse_listings (agency_pulse_id) WHERE agency_pulse_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_timeline_event_type_created
  ON pulse_timeline (event_type, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_first_seen_at
  ON pulse_listings (first_seen_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pulse_listings_type_suburb_sold_date
  ON pulse_listings (listing_type, suburb, sold_date DESC) WHERE sold_date IS NOT NULL;

-- ─── Section B: drop redundant indexes ──────────────────────────────
-- Each is a proven duplicate of a canonical *_unique index (verified
-- via pg_indexes in the Q3 audit — see migration commit message).
DROP INDEX CONCURRENTLY IF EXISTS idx_pulse_agents_rea_id;            -- dup of pulse_agents_rea_agent_id_unique
DROP INDEX CONCURRENTLY IF EXISTS idx_pulse_agencies_rea_agency_id;   -- dup of pulse_agencies_rea_agency_id_unique
DROP INDEX CONCURRENTLY IF EXISTS idx_pulse_listings_source_id;       -- dup of pulse_listings_source_listing_id_unique
DROP INDEX CONCURRENTLY IF EXISTS idx_pulse_target_suburbs_region_notnull;  -- subset of idx_pulse_target_suburbs_region
DROP INDEX CONCURRENTLY IF EXISTS idx_pulse_events_date;              -- dup of idx_pulse_events_event_date
DROP INDEX CONCURRENTLY IF EXISTS idx_pulse_crm_mappings_domain;      -- dup of idx_pulse_crm_map_domain

-- ─── Section C: drop dead columns (pulse_* only) ────────────────────
-- Grep-audit of supabase/functions:
--   domain_agent_id          → writers only on `agents` table (CRM) → safe on pulse_agents
--   domain_listing_id        → writers only on `retention_alerts` → safe on pulse_listings
--   search_sales_breakdown   → LIVE writer pulseDataSync:857 → SKIPPED
--   all other domain_*, reinsw_member, agent_domain_id, agency_domain_id → 0 pulse writers → drop
ALTER TABLE pulse_agents
  DROP COLUMN IF EXISTS domain_agent_id,
  DROP COLUMN IF EXISTS domain_profile_url,
  DROP COLUMN IF EXISTS domain_avg_sold_price,
  DROP COLUMN IF EXISTS domain_avg_dom,
  DROP COLUMN IF EXISTS domain_rating,
  DROP COLUMN IF EXISTS domain_review_count,
  DROP COLUMN IF EXISTS reinsw_member;
-- NOTE: pulse_agents.search_sales_breakdown INTENTIONALLY NOT DROPPED —
-- pulseDataSync/index.ts:857 actively writes this column (suburb-scoped
-- sales breakdown used by Pulse intelligence features).

ALTER TABLE pulse_agencies
  DROP COLUMN IF EXISTS domain_agency_id,
  DROP COLUMN IF EXISTS domain_profile_url;

-- pulse_listings: property_prospects_v SELECTs the dead columns in its
-- LATERAL subquery (harmless but blocks DROP COLUMN). Drop the view,
-- drop the columns, then recreate the view without the dead columns.
DROP VIEW IF EXISTS property_prospects_v;

ALTER TABLE pulse_listings
  DROP COLUMN IF EXISTS domain_listing_id,
  DROP COLUMN IF EXISTS domain_listing_url,
  DROP COLUMN IF EXISTS agent_domain_id,
  DROP COLUMN IF EXISTS agency_domain_id;

CREATE OR REPLACE VIEW property_prospects_v AS
SELECT pv.id,
    pv.property_key,
    pv.display_address,
    pv.suburb,
    pv.postcode,
    pv.latitude,
    pv.longitude,
    pv.hero_image,
    pv.bedrooms,
    pv.bathrooms,
    pv.parking,
    pv.property_type,
    pv.project_count,
    pv.listing_count,
    p.id AS project_id,
    p.title AS project_title,
    p.shoot_date AS project_shoot_date,
    p.tonomo_package AS project_package_name,
    p.agent_id AS project_agent_id,
    p.agent_name AS project_agent_name,
    p.agency_id AS project_agency_id,
    a.rea_agent_id AS project_agent_rea_id,
    ag.name AS project_agency_name,
    l.id AS current_listing_id,
    l.source_listing_id AS current_source_listing_id,
    l.listing_type AS current_listing_type,
    l.listed_date AS current_listed_date,
    l.asking_price AS current_asking_price,
    l.sold_price AS current_sold_price,
    l.sold_date AS current_sold_date,
    l.agent_name AS prospect_agent_name,
    l.agent_rea_id AS prospect_agent_rea_id,
    l.agent_phone AS prospect_agent_phone,
    l.agency_name AS prospect_agency_name,
    l.agency_rea_id AS prospect_agency_rea_id,
    l.source_url AS prospect_listing_url,
    l.last_synced_at AS prospect_last_seen,
    ( SELECT count(DISTINCT pl.property_key) AS count
           FROM pulse_listings pl
          WHERE pl.agent_rea_id = l.agent_rea_id
            AND (EXISTS ( SELECT 1
                   FROM projects pr
                  WHERE pr.property_key = pl.property_key))) AS prospect_agent_our_properties_count,
    ( SELECT agents.id
           FROM agents
          WHERE agents.rea_agent_id = l.agent_rea_id
         LIMIT 1) AS prospect_agent_crm_id
   FROM property_full_v pv
     JOIN projects p ON p.property_key = pv.property_key
       AND (p.status <> ALL (ARRAY['cancelled'::text, 'archived'::text]))
     LEFT JOIN agents a ON a.id = p.agent_id
     LEFT JOIN agencies ag ON ag.id = p.agency_id
     JOIN LATERAL ( SELECT pulse_listings.id,
            pulse_listings.address,
            pulse_listings.suburb,
            pulse_listings.postcode,
            pulse_listings.property_type,
            pulse_listings.bedrooms,
            pulse_listings.bathrooms,
            pulse_listings.listing_type,
            pulse_listings.asking_price,
            pulse_listings.sold_price,
            pulse_listings.listed_date,
            pulse_listings.sold_date,
            pulse_listings.days_on_market,
            pulse_listings.agent_name,
            pulse_listings.agent_phone,
            pulse_listings.agency_name,
            pulse_listings.linked_agent_id,
            pulse_listings.source,
            pulse_listings.source_url,
            pulse_listings.source_listing_id,
            pulse_listings.last_synced_at,
            pulse_listings.created_at,
            pulse_listings.parking,
            pulse_listings.land_size,
            pulse_listings.description,
            pulse_listings.image_url,
            pulse_listings.first_seen_at,
            pulse_listings.next_inspection,
            pulse_listings.status,
            pulse_listings.images,
            pulse_listings.hero_image,
            pulse_listings.has_video,
            pulse_listings.latitude,
            pulse_listings.longitude,
            pulse_listings.features,
            pulse_listings.promo_level,
            pulse_listings.agent_photo,
            pulse_listings.agency_logo,
            pulse_listings.agency_brand_colour,
            pulse_listings.created_date,
            pulse_listings.auction_date,
            pulse_listings.agent_rea_id,
            pulse_listings.agency_rea_id,
            pulse_listings.agent_pulse_id,
            pulse_listings.agency_pulse_id,
            pulse_listings.previous_asking_price,
            pulse_listings.price_changed_at,
            pulse_listings.previous_listing_type,
            pulse_listings.status_changed_at,
            pulse_listings.price_text,
            pulse_listings.property_key
           FROM pulse_listings
          WHERE pulse_listings.property_key = pv.property_key
          ORDER BY pulse_listings.listed_date DESC NULLS LAST,
                   pulse_listings.last_synced_at DESC NULLS LAST
         LIMIT 1) l ON true
  WHERE pv.listing_count > 0
    AND pv.project_count > 0
    AND l.agent_rea_id IS NOT NULL
    AND a.rea_agent_id IS NOT NULL
    AND l.agent_rea_id <> a.rea_agent_id
  ORDER BY l.listed_date DESC NULLS LAST, l.last_synced_at DESC NULLS LAST;

-- ─── Section D: NOT NULL enforcement ────────────────────────────────
-- Prod audit: each column = 0 NULLs at time of migration authoring.
-- SKIPPED: pulse_listings.first_seen_at (603 NULLs) and
--          pulse_agents.first_seen_at   (202 NULLs) — needs backfill.
ALTER TABLE pulse_listings ALTER COLUMN suburb            SET NOT NULL;
ALTER TABLE pulse_listings ALTER COLUMN listing_type      SET NOT NULL;
ALTER TABLE pulse_listings ALTER COLUMN source_listing_id SET NOT NULL;
ALTER TABLE pulse_listings ALTER COLUMN last_synced_at    SET NOT NULL;
ALTER TABLE pulse_agents   ALTER COLUMN rea_agent_id      SET NOT NULL;

-- ─── Section E: listing_type CHECK constraint ───────────────────────
-- Prod audit: distinct values = {for_sale, for_rent, sold, under_contract}
-- all ⊂ allowed set. No violation, safe to add NOT VALID-less.
ALTER TABLE pulse_listings
  ADD CONSTRAINT pulse_listings_listing_type_chk
  CHECK (listing_type IN ('for_sale','for_rent','sold','under_contract','withdrawn'));

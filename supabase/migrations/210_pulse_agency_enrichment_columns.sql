-- Migration 210 — pulse_agencies enrichment columns + source config
--
-- Until now, pulse_agencies.total_sold_12m / avg_sold_price / avg_days_on_market
-- etc. existed as columns but no pipeline ever populated them — agency rows are
-- derived from agent observations by migration 152 and never scraped directly.
--
-- This migration adds the agency-level stats we CAN only get by scraping the
-- REA agency page (https://www.realestate.com.au/agency/{slug}-{rea_id}) plus
-- the fetch-status bookkeeping columns the new `pulseAgencyEnrich` edge
-- function uses to pick stalest candidates.
--
-- The enrichment function inspects REA's SSR'd JSON payload
-- (`window.ArgonautExchange` or `__NEXT_DATA__`) via Apify's web-scraper actor
-- and backfills these columns for every pulse_agencies row that has a
-- rea_agency_id.

BEGIN;

-- ── Agency-level stats (from scraped agency profile) ──────────────────────
ALTER TABLE pulse_agencies
  ADD COLUMN IF NOT EXISTS total_sold_volume_aud   bigint,
  ADD COLUMN IF NOT EXISTS median_sold_price       numeric,
  ADD COLUMN IF NOT EXISTS median_days_on_market   integer,
  ADD COLUMN IF NOT EXISTS team_size               integer,
  ADD COLUMN IF NOT EXISTS awards                  jsonb,
  ADD COLUMN IF NOT EXISTS franchise_brand         text,
  ADD COLUMN IF NOT EXISTS about_text              text,
  ADD COLUMN IF NOT EXISTS agency_testimonials     jsonb,
  ADD COLUMN IF NOT EXISTS office_photo_urls       jsonb,
  ADD COLUMN IF NOT EXISTS declared_suburbs_served jsonb,
  ADD COLUMN IF NOT EXISTS trading_name            text,
  ADD COLUMN IF NOT EXISTS abn                     text;

-- ── Fetch bookkeeping ─────────────────────────────────────────────────────
ALTER TABLE pulse_agencies
  ADD COLUMN IF NOT EXISTS agency_profile_fetched_at   timestamptz,
  ADD COLUMN IF NOT EXISTS agency_profile_fetch_status text,
  ADD COLUMN IF NOT EXISTS agency_profile_fetch_error  text;

-- Candidate-selection index: stalest / never-fetched rows first.
CREATE INDEX IF NOT EXISTS idx_pulse_agencies_profile_fetched_at
  ON pulse_agencies (agency_profile_fetched_at ASC NULLS FIRST)
  WHERE rea_agency_id IS NOT NULL;

-- ── Register the enrichment source ────────────────────────────────────────
-- pulseAgencyEnrich is an enrich-layer function (like rea_detail_enrich), not
-- a per-suburb list scraper. We still record it in pulse_source_configs so the
-- source-card UI, cron helpers, and circuit-breaker dashboards pick it up.
-- Weekly Sunday 04:00 Sydney (18:00 UTC Saturday) — enough to track team
-- churn / sold-volume movement without over-spending.
INSERT INTO pulse_source_configs (
  source_id, label, description, is_enabled, schedule_cron, approach, actor_slug, actor_input
) VALUES (
  'pulse_agency_enrich',
  'REA Agency Profile Enrichment',
  'Scrapes realestate.com.au agency profile pages for team size, sold volume, awards, testimonials, franchise brand, and about text. Populates pulse_agencies columns that cannot be derived from agent-level observations.',
  true,
  '0 18 * * 6',  -- 18:00 UTC Saturday = 04:00 Sunday Sydney (AEST+10)
  'enrich',
  'apify/web-scraper',
  '{}'::jsonb
)
ON CONFLICT (source_id) DO UPDATE SET
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  is_enabled  = EXCLUDED.is_enabled,
  approach    = EXCLUDED.approach,
  actor_slug  = EXCLUDED.actor_slug,
  updated_at  = now();

-- Seed a closed circuit breaker row so breakerRecordSuccess/Failure upserts
-- always find threshold/cooldown defaults without a race on first run.
INSERT INTO pulse_source_circuit_breakers (source_id, state, consecutive_failures)
VALUES ('pulse_agency_enrich', 'closed', 0)
ON CONFLICT (source_id) DO NOTHING;

COMMIT;

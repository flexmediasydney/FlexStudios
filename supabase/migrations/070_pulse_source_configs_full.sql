-- Migration 070: Extend pulse_source_configs to be the single source of truth
-- for all Apify scraping input parameters.
--
-- Prior to this migration, the actor input (URL, maxItems, maxPages, etc.)
-- was hardcoded in 3 places:
--   1. flexmedia-src/src/components/pulse/tabs/PulseDataSources.jsx (SOURCES)
--   2. supabase/functions/pulseFireScrapes/index.ts (SOURCE_PARAMS)
--   3. supabase/functions/pulseScheduledScrape/index.ts (SOURCE_PARAMS)
-- This drift is a cross-cutting issue. With this migration, all three read
-- from pulse_source_configs.actor_input (a jsonb template that supports
-- {suburb} and {suburb-slug} placeholders for per-suburb mode).

-- ── Schema extensions ──────────────────────────────────────────────────────
ALTER TABLE pulse_source_configs ADD COLUMN IF NOT EXISTS approach         text;          -- 'per_suburb' or 'bounding_box'
ALTER TABLE pulse_source_configs ADD COLUMN IF NOT EXISTS actor_input      jsonb DEFAULT '{}'::jsonb;  -- Apify input template
ALTER TABLE pulse_source_configs ADD COLUMN IF NOT EXISTS apify_store_url  text;
ALTER TABLE pulse_source_configs ADD COLUMN IF NOT EXISTS max_suburbs      int;           -- cap per cron run (per_suburb mode)
ALTER TABLE pulse_source_configs ADD COLUMN IF NOT EXISTS min_priority     int DEFAULT 0;
ALTER TABLE pulse_source_configs ADD COLUMN IF NOT EXISTS notes            text;

-- Ensure UNIQUE constraint on source_id (may already exist from migration 059)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pulse_source_configs_source_id_key'
      AND conrelid = 'pulse_source_configs'::regclass
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pulse_source_configs_source_id_unique'
      AND conrelid = 'pulse_source_configs'::regclass
  ) THEN
    ALTER TABLE pulse_source_configs
      ADD CONSTRAINT pulse_source_configs_source_id_unique UNIQUE (source_id);
  END IF;
END $$;

-- ── Seed / upsert the 5 REA sources ────────────────────────────────────────
-- actor_input uses {suburb} and {suburb-slug} placeholders in per_suburb mode.
-- Bounding-box sources have the full startUrl baked into actor_input directly.

INSERT INTO pulse_source_configs (
  source_id, label, description, actor_slug, apify_store_url, approach,
  actor_input, max_results_per_suburb, max_suburbs, min_priority, is_enabled,
  schedule_cron, notes, created_at, updated_at
)
VALUES
  (
    'rea_agents',
    'REA Agent Profiles',
    'websift — Agent profiles, stats, reviews, awards from realestate.com.au',
    'websift/realestateau',
    'https://apify.com/websift/realestateau',
    'per_suburb',
    '{"location":"{suburb} NSW","maxPages":3,"fullScrape":true,"sortBy":"SUBURB_SALES_PERFORMANCE"}'::jsonb,
    30, 20, 7, true,
    '0 18 * * 0',  -- Sunday 6pm UTC (Mon 4am AEST)
    'Iterates per suburb. maxPages=3 -> ~30 agents/suburb. Weekly (Sundays).',
    now(), now()
  ),
  (
    'rea_listings',
    'REA Listings (per-suburb)',
    'azzouzana — Listings with agent emails, photos, REA IDs',
    'azzouzana/real-estate-au-scraper-pro',
    'https://apify.com/azzouzana/real-estate-au-scraper-pro',
    'per_suburb',
    '{"startUrl":"https://www.realestate.com.au/buy/in-{suburb-slug},+nsw/list-1","maxItems":20}'::jsonb,
    20, 20, 7, true,
    null,
    'On-demand. maxItems=20 per suburb. Used for per-suburb email cross-enrichment.',
    now(), now()
  ),
  (
    'rea_listings_bb_buy',
    'REA Sales (Greater Sydney)',
    'azzouzana — All Sydney sales via bounding box URL',
    'azzouzana/real-estate-au-scraper-pro',
    'https://apify.com/azzouzana/real-estate-au-scraper-pro',
    'bounding_box',
    '{"startUrl":"https://www.realestate.com.au/buy/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date&sourcePage=rea:buy:srp-map&sourceElement=tab-headers","maxItems":500}'::jsonb,
    500, null, 0, true,
    '0 20,4 * * *',  -- 8pm UTC + 4am UTC = 6am + 2pm AEST
    'Single bounding-box URL covers Greater Sydney. Sort: newest first. Runs twice daily.',
    now(), now()
  ),
  (
    'rea_listings_bb_rent',
    'REA Rentals (Greater Sydney)',
    'azzouzana — All Sydney rentals via bounding box URL',
    'azzouzana/real-estate-au-scraper-pro',
    'https://apify.com/azzouzana/real-estate-au-scraper-pro',
    'bounding_box',
    '{"startUrl":"https://www.realestate.com.au/rent/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date&source=refinement","maxItems":500}'::jsonb,
    500, null, 0, true,
    '0 21,5 * * *',
    'Single bounding-box URL covers Greater Sydney rentals. Runs twice daily.',
    now(), now()
  ),
  (
    'rea_listings_bb_sold',
    'REA Recently Sold (Greater Sydney)',
    'azzouzana — All Sydney recently sold via bounding box URL',
    'azzouzana/real-estate-au-scraper-pro',
    'https://apify.com/azzouzana/real-estate-au-scraper-pro',
    'bounding_box',
    '{"startUrl":"https://www.realestate.com.au/sold/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&source=refinement","maxItems":500}'::jsonb,
    500, null, 0, true,
    '0 22 * * *',
    'Single bounding-box URL covers Greater Sydney sold. Daily 8am AEST.',
    now(), now()
  )
ON CONFLICT (source_id) DO UPDATE SET
  label                   = EXCLUDED.label,
  description             = EXCLUDED.description,
  actor_slug              = EXCLUDED.actor_slug,
  apify_store_url         = EXCLUDED.apify_store_url,
  approach                = EXCLUDED.approach,
  actor_input             = EXCLUDED.actor_input,
  max_results_per_suburb  = EXCLUDED.max_results_per_suburb,
  max_suburbs             = EXCLUDED.max_suburbs,
  min_priority            = EXCLUDED.min_priority,
  is_enabled              = EXCLUDED.is_enabled,
  schedule_cron           = EXCLUDED.schedule_cron,
  notes                   = EXCLUDED.notes,
  updated_at              = now();

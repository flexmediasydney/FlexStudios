-- 107_detail_enrich_source_config.sql
-- Register the rea_detail_enrich source in pulse_source_configs (disabled
-- initially; enabled in migration 109 after edge function is deployed +
-- manually verified).
--
-- This source bypasses pulse_fire_queue (suburb-based semantics don''t fit
-- URL-list work). It has its own edge function pulseDetailEnrich and its
-- own cron schedule. The circuit_breakers auto-seed (migration 093 line 138)
-- still provisions a breaker row, and pulseDetailEnrich maintains it by
-- writing success/failure transitions directly.

BEGIN;

INSERT INTO pulse_source_configs (
  source_id,
  label,
  description,
  actor_slug,
  apify_store_url,
  approach,
  actor_input,
  max_results_per_suburb,
  max_suburbs,
  min_priority,
  is_enabled,
  schedule_cron,
  notes,
  created_at,
  updated_at
)
VALUES (
  'rea_detail_enrich',
  'REA Detail Enrichment',
  'Per-URL detail page fetch via memo23 actor. Surfaces exact dates (dateSold, auctionTime, dateAvailable), direct agent + agency contacts (email, mobile, phone, website), floorplans, YouTube videos, full inspection schedule, and withdrawn detection. ~$0.001/listing.',
  'memo23/realestate-au-listings',
  'https://apify.com/memo23/realestate-au-listings',
  'detail_enrich',
  -- actor_input template; the edge function inflates {{URL_BATCH}} per run
  jsonb_build_object(
    'startUrls',       jsonb_build_array('{{URL_BATCH}}'),
    'maxItems',        50,
    'flattenOutput',   true
  ),
  NULL,
  NULL,
  0,
  FALSE,  -- disabled; 109 flips to true
  '0 4 * * *',  -- daily 4am UTC (2pm AEST) — runs after list scrapes land
  'Per-URL enrichment. Picks listings WHERE detail_enriched_at IS NULL OR stale (>14d), LIMIT 500 per run. Runs in 10 batches of 50 URLs sequentially (Apify wall-clock safety). Separate edge function pulseDetailEnrich, bypasses pulse_fire_queue. Cost model: $0.001/listing + $0.007/run-start = ~$17/mo steady state.',
  now(),
  now()
)
ON CONFLICT (source_id) DO UPDATE SET
  label            = EXCLUDED.label,
  description      = EXCLUDED.description,
  actor_slug       = EXCLUDED.actor_slug,
  apify_store_url  = EXCLUDED.apify_store_url,
  approach         = EXCLUDED.approach,
  actor_input      = EXCLUDED.actor_input,
  schedule_cron    = EXCLUDED.schedule_cron,
  notes            = EXCLUDED.notes,
  updated_at       = now();

-- The circuit_breakers auto-seed trigger (migration 093) should
-- have already inserted a row for the new source_id. Ensure it exists.
INSERT INTO pulse_source_circuit_breakers (source_id, state, consecutive_failures)
VALUES ('rea_detail_enrich', 'closed', 0)
ON CONFLICT (source_id) DO NOTHING;

COMMIT;

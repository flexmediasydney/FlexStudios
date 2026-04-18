-- 109_detail_enrich_cron.sql
-- Turn on the rea_detail_enrich pipeline.
--
-- Prerequisites (enforced by ship order, not code):
--   (a) Migrations 103–108 applied
--   (b) pulseDetailEnrich edge function deployed
--   (c) Manual dry-run on ~10 listings verified OK
--   (d) Frontend display updates shipped
--
-- Two crons:
--   pulse-detail-enrich        — daily 4am UTC, main run, picks 500 stalest
--   pulse-alternate-prune      — monthly 1st 6am UTC, caps jsonb arrays

BEGIN;

-- Flip source on
UPDATE pulse_source_configs
   SET is_enabled = TRUE,
       updated_at = now()
 WHERE source_id = 'rea_detail_enrich';

-- Schedule daily enrichment run
SELECT cron.schedule(
  'pulse-detail-enrich',
  '0 4 * * *',  -- 4am UTC = 2pm AEST
  $$
  SELECT net.http_post(
    url := (SELECT project_ref_url || '/functions/v1/pulseDetailEnrich'
              FROM (SELECT 'https://rjzdznwkxnzfekgcdkei.supabase.co' AS project_ref_url) q),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt'),
      'Content-Type',  'application/json',
      'x-caller-context', 'cron:pulse-detail-enrich'
    ),
    body := jsonb_build_object(
      'trigger', 'cron',
      'max_listings', 500,
      'priority_mode', 'auto'
    )
  );
  $$
);

-- Schedule monthly alternates LRU prune (keeps jsonb arrays bounded)
SELECT cron.schedule(
  'pulse-alternate-prune',
  '0 6 1 * *',  -- 1st of month, 6am UTC
  $$
  SELECT pulse_prune_alternates(10);
  $$
);

COMMIT;

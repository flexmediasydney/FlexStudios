-- 113_detail_enrich_backfill_acceleration.sql
-- Fix B01: cron throughput. The previous cron ran daily at 30 listings/invocation
-- which would take 210 days to clear the 6,315 backlog. Bump to every 15 min
-- during active backlog; once backlog clears, the cron becomes idempotent
-- (nothing to enrich) so no harm in running often.
--
-- Also drop the daily schedule and replace it with the new one.
--
-- Rate at 30 listings/15min = 120/hr = 2,880/day — backlog clears in ~2.2 days.
-- Apify cost: 120 runs/day × ($0.007 start + 15 × $0.001 items) = $2.64/day
-- during active backlog; drops to near-zero once caught up (idempotent runs).

BEGIN;

-- Drop the old daily schedule
SELECT cron.unschedule('pulse-detail-enrich')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-detail-enrich');

-- Re-schedule every 15 min. Will be a no-op once backlog drains (candidate
-- selection returns 0 rows and edge function exits early).
SELECT cron.schedule(
  'pulse-detail-enrich',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseDetailEnrich',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt'),
      'Content-Type',  'application/json',
      'x-caller-context', 'cron:pulse-detail-enrich'
    ),
    body := jsonb_build_object(
      'trigger', 'cron',
      'max_listings', 30,
      'priority_mode', 'auto'
    )
  );
  $$
);

COMMIT;

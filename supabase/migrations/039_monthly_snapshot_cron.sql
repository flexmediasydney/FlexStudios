-- Schedule unified monthly catalog snapshots (products + packages + price matrices)
-- Runs on the 1st of each month at 16:00 UTC (~2am AEST / ~3am AEDT Sydney)

SELECT cron.schedule(
  'monthly-catalog-snapshots',
  '0 16 1 * *',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/generateMonthlySnapshots',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"snapshot_type": "monthly"}'::jsonb
  );
  $$
);

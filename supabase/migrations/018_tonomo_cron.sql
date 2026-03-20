-- Enable pg_cron and pg_net extensions (for calling Edge Functions from cron)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Schedule processTonomoQueue to run every minute
SELECT cron.schedule(
  'process-tonomo-queue',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/processTonomoQueue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{"source": "pg_cron"}'::jsonb
  );
  $$
);

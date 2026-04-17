-- 080_fix_cron_auth.sql
-- Three crons (detect-at-risk-contacts, sync-google-calendar, monthly-catalog-snapshots)
-- authenticated via current_setting('app.settings.service_role_key'), which returns
-- NULL since Supabase's platform migration — leading to 100% 401 rates. Switch to
-- a vault lookup that runs at each cron invocation.

DO $$
BEGIN
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='detect-at-risk-contacts'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/detectAtRiskContacts', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1), 'Content-Type', 'application/json'), body := '{}'::jsonb) AS request_id$cmd$
  );
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='sync-google-calendar'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/syncGoogleCalendar', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1), 'Content-Type', 'application/json'), body := '{}'::jsonb) AS request_id$cmd$
  );
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='monthly-catalog-snapshots'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/generateMonthlySnapshots', headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1), 'Content-Type', 'application/json'), body := '{"snapshot_type":"monthly"}'::jsonb) AS request_id$cmd$
  );
END $$;

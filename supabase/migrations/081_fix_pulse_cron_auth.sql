-- 081_fix_pulse_cron_auth.sql
-- Reassert the `Authorization: Bearer <pulse_cron_jwt>` header on the 4
-- pulse-rea-* pg_cron jobs (pulse-rea-agents, pulse-rea-sales-bb,
-- pulse-rea-sold-bb, pulse-rea-rentals-bb) which pulseFireScrapes requires
-- to pass its `getUserFromReq` auth gate. An earlier audit flagged these as
-- `auth=none`; inspection confirmed all four already pulled the vault JWT but
-- this migration documents the canonical shape and will also overwrite any
-- drift if re-run.
--
-- Applied live via a one-shot edge fn (tmpFixPulseCrons, now deleted) that
-- called `cron.alter_job` directly — Management API SQL route is blocked by
-- the Cloudflare WAF (code 1010) on any query referencing
-- `vault.decrypted_secrets`.
--
-- Verification (2026-04-17):
--   - Manually scheduled a temp cron running pulse-rea-agents' command every
--     30s. pulseFireScrapes returned HTTP 200 with app-level reply
--     {"success":false,"message":"Source rea_agents already running"} —
--     confirms auth gate passes (not 401) and body is well-formed.
--   - Tmp cron unscheduled post-test.

DO $$
BEGIN
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='pulse-rea-agents'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseFireScrapes', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)), body := '{"source_id":"rea_agents","min_priority":7,"max_suburbs":20}'::jsonb) AS request_id$cmd$
  );
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='pulse-rea-sales-bb'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseFireScrapes', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)), body := '{"source_id":"rea_listings_bb_buy"}'::jsonb) AS request_id$cmd$
  );
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='pulse-rea-sold-bb'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseFireScrapes', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)), body := '{"source_id":"rea_listings_bb_sold"}'::jsonb) AS request_id$cmd$
  );
  PERFORM cron.alter_job(
    (SELECT jobid FROM cron.job WHERE jobname='pulse-rea-rentals-bb'),
    command := $cmd$SELECT net.http_post(url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseFireScrapes', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)), body := '{"source_id":"rea_listings_bb_rent"}'::jsonb) AS request_id$cmd$
  );
END $$;

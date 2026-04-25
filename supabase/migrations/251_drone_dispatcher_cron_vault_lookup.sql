-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 251: drone-job-dispatcher cron — replace plaintext JWT with vault lookup
-- ───────────────────────────────────────────────────────────────────────────
-- Bug: migration 232 used `format()` to inject the vault secret into the cron
-- command at MIGRATION TIME, baking the literal JWT into cron.job.command.
-- That breaks vault rotation — rotating pulse_cron_jwt has no effect because
-- the cron still uses the snapshot from migration time.
--
-- Fix: mirror dropbox-reconcile-nightly (migration 224) which embeds the
-- vault SELECT INSIDE the cron command body so it re-resolves every run.
--
-- Required vault secret: pulse_cron_jwt
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Sanity check: ensure the vault secret still exists before recreating.
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt'
  ) THEN
    RAISE EXCEPTION 'pulse_cron_jwt missing from vault — refusing to recreate cron without secret';
  END IF;

  -- Unschedule the existing job (idempotent).
  PERFORM cron.unschedule('drone-job-dispatcher')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drone-job-dispatcher');

  -- Recreate using vault SELECT inline in the command body so the JWT is
  -- re-resolved at each tick. NOTE the literal $job$ delimiters are stored
  -- AS-IS (no format() interpolation).
  PERFORM cron.schedule(
    'drone-job-dispatcher',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/drone-job-dispatcher',
        headers := jsonb_build_object(
          'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
          'Content-Type',     'application/json',
          'x-caller-context', 'cron:drone-job-dispatcher'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 145000
      );
    $job$
  );
END$$;

COMMENT ON EXTENSION pg_cron IS
  'Drone Phase 3 Stream I.C: drone-job-dispatcher every minute. JWT resolved from vault at each tick (rotation-safe).';

-- 096_db_hygiene_ttl_analyze.sql
-- Phase 2 of the DB-overload RCA remediation.
--
-- Three things in one migration (they're all small and related):
--   (1) Apply the same split-payload pattern to tonomo_webhook_logs
--       (raw_payload + request_headers moved to tonomo_webhook_log_payloads).
--   (2) TTL crons: purge old rows to prevent unbounded growth.
--   (3) Nightly ANALYZE cron on all hot tables — Postgres stats were
--       completely absent (n_live_tup=0 everywhere), making the query
--       planner fly blind. Defence against this regression.

BEGIN;

-- ── (1) tonomo_webhook_logs split ────────────────────────────────────────
-- Same pattern as pulse_sync_logs (migration 095). 2,170 rows currently
-- carrying ~7 MB of raw_payload and ~2.3 MB of request_headers. UI queries
-- the webhook log list with SELECT * — keep it slim.
--
-- NOTE (post-apply): SettingsTonomoWebhooks.jsx parses raw_payload on every
-- row render to display orderId / photographer / agent / etc. Splitting it
-- silently breaks that page. Post-apply recovery:
--   1. Restored raw_payload + request_headers back to the main row via
--      UPDATE ... FROM tonomo_webhook_log_payloads.
--   2. receiveTonomoWebhook kept writing to main row (not the side table).
-- The side-table + index stays in place as scaffolding for a future
-- refactor where we pre-compute those display fields and move raw to a
-- drill-only path. 11 MB total isn't urgent; TTL cron (below) caps growth.
CREATE TABLE IF NOT EXISTS tonomo_webhook_log_payloads (
  webhook_log_id   UUID PRIMARY KEY,
  raw_payload      TEXT,
  request_headers  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tonomo_webhook_log_payloads_created
  ON tonomo_webhook_log_payloads (created_at DESC);

INSERT INTO tonomo_webhook_log_payloads (webhook_log_id, raw_payload, request_headers, created_at)
SELECT id, raw_payload, request_headers, COALESCE(received_at, created_at, NOW())
FROM tonomo_webhook_logs
WHERE raw_payload IS NOT NULL OR request_headers IS NOT NULL
ON CONFLICT (webhook_log_id) DO NOTHING;

UPDATE tonomo_webhook_logs
   SET raw_payload = NULL,
       request_headers = NULL
 WHERE raw_payload IS NOT NULL OR request_headers IS NOT NULL;

COMMENT ON TABLE tonomo_webhook_log_payloads IS
  'Heavy TEXT payloads for tonomo_webhook_logs, separated so the UI list '
  'query does not pull 54KB of raw JSON per row. Loaded on-demand only by '
  'the webhook drill dialog.';

-- ── (2) TTL crons ────────────────────────────────────────────────────────
-- pulse_sync_log_payloads: 30 day retention. Operators occasionally drill
-- into older sync runs for debugging, but 30d is a reasonable window.
-- The main pulse_sync_logs header row stays (it's tiny) — just the payload
-- side-table row gets nuked. If you ever need to dig older: SQL only.
--
-- tonomo_webhook_logs + payloads: 90 day retention. Webhooks are more
-- audit-sensitive (regulatory/debugging) so keep 3 months. Tonomo itself
-- retains longer; we can re-pull if needed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-sync-payload-ttl') THEN
    PERFORM cron.unschedule('pulse-sync-payload-ttl');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tonomo-webhook-ttl') THEN
    PERFORM cron.unschedule('tonomo-webhook-ttl');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'db-hot-tables-analyze') THEN
    PERFORM cron.unschedule('db-hot-tables-analyze');
  END IF;
END $$;

-- Run TTLs at off-peak hours (UTC): 3:05am, 3:10am
SELECT cron.schedule(
  'pulse-sync-payload-ttl',
  '5 3 * * *',
  $ttl$
  DELETE FROM pulse_sync_log_payloads
  WHERE created_at < NOW() - INTERVAL '30 days';
  $ttl$
);

SELECT cron.schedule(
  'tonomo-webhook-ttl',
  '10 3 * * *',
  $ttl$
  DELETE FROM tonomo_webhook_log_payloads
  WHERE created_at < NOW() - INTERVAL '90 days';
  -- Also purge the header row if very old (180d) — audit trail stays much
  -- longer than payloads but isn't forever.
  DELETE FROM tonomo_webhook_logs
  WHERE received_at < NOW() - INTERVAL '180 days';
  $ttl$
);

-- ── (3) Nightly ANALYZE cron ────────────────────────────────────────────
-- Postgres statistics were completely absent on every hot table when we
-- audited. `n_live_tup=0, last_analyze=NULL` means the planner had no
-- row count estimates, which is how the `pulse_sync_logs SELECT *` ended
-- up 6.6s (no idea how big the rows would be to detoast).
--
-- ANALYZE on 10-ish tables is cheap — seconds total, no locks.
SELECT cron.schedule(
  'db-hot-tables-analyze',
  '20 3 * * *',
  $analyze$
  ANALYZE pulse_sync_logs;
  ANALYZE pulse_sync_log_payloads;
  ANALYZE pulse_listings;
  ANALYZE pulse_agents;
  ANALYZE pulse_agencies;
  ANALYZE pulse_timeline;
  ANALYZE pulse_fire_queue;
  ANALYZE pulse_fire_batches;
  ANALYZE tonomo_webhook_logs;
  ANALYZE tonomo_webhook_log_payloads;
  ANALYZE tonomo_processing_queue;
  ANALYZE tonomo_audit_logs;
  ANALYZE projects;
  ANALYZE calendar_events;
  ANALYZE email_messages;
  ANALYZE email_conversations;
  $analyze$
);

COMMIT;

-- Reclaim the tonomo_webhook_logs table size immediately (outside transaction)
-- VACUUM (FULL, ANALYZE) tonomo_webhook_logs;

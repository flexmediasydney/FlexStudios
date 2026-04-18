-- 095_pulse_sync_logs_split_payload.sql
-- Phase 1 of the DB-overload RCA remediation.
--
-- ── The problem ──────────────────────────────────────────────────────────
-- pulse_sync_logs had 4 heavy JSONB columns (raw_payload, input_config,
-- result_summary, records_detail) averaging 55 KB per row. With 1,460 rows
-- that's 77 MB of TOAST data on a logically-small table. Frontend calls
-- `SELECT * FROM pulse_sync_logs LIMIT 100 ORDER BY started_at DESC` on
-- every Industry Pulse page load — which detoasts 100 rows × 55 KB =
-- 5.4 MB of JSON per request. Measured 6.6 SECONDS per call in pg_stat_statements
-- (vs. single-digit ms if TOAST isn't touched).
--
-- Root cause: PostgREST's `select=*` pulls every column including TOAST'd
-- ones, even though the UI only renders 12 header fields (status, timestamps,
-- record counts, etc.). The heavy columns are only needed by the drill-through
-- "View raw payload" dialog — a rare action.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- Split into two tables:
--   pulse_sync_logs          → slim header (UI loads hundreds at a time)
--   pulse_sync_log_payloads  → heavy JSONB columns, 1-row-at-a-time drill access
--
-- After this migration, `SELECT * FROM pulse_sync_logs LIMIT 100` never
-- touches TOAST storage — goes from 6.6s to single-digit milliseconds.
--
-- Side benefits:
--   - TTL: drop old rows from pulse_sync_log_payloads while keeping headers
--   - Partitioning: can monthly-partition the side-table (migration 098)
--   - Future Storage migration: payloads table is the one that moves to
--     Supabase Storage if we ever do phase 3(j)

BEGIN;

-- ── Side-table for heavy payloads ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pulse_sync_log_payloads (
  sync_log_id      UUID PRIMARY KEY,
  raw_payload      JSONB,
  result_summary   JSONB,
  input_config     JSONB,
  records_detail   JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup index for TTL cleanup cron (created_at range scan)
CREATE INDEX IF NOT EXISTS idx_pulse_sync_log_payloads_created
  ON pulse_sync_log_payloads (created_at DESC);

COMMENT ON TABLE pulse_sync_log_payloads IS
  'Heavy JSONB payloads for pulse_sync_logs, separated so the UI list query '
  'never touches TOAST. Loaded on-demand by the drill-through dialog only. '
  'TTL: rows older than 30 days auto-purged by cron (migration 096).';

-- ── Migrate existing data ────────────────────────────────────────────────
-- Copy non-null payload data into the new table. Use WHERE to skip rows
-- that don't have any payload content (avoids pointless empty rows).
INSERT INTO pulse_sync_log_payloads (sync_log_id, raw_payload, result_summary, input_config, records_detail, created_at)
SELECT
  id,
  raw_payload,
  result_summary,
  input_config,
  records_detail,
  COALESCE(started_at, NOW())
FROM pulse_sync_logs
WHERE raw_payload IS NOT NULL
   OR result_summary IS NOT NULL
   OR input_config IS NOT NULL
   OR records_detail IS NOT NULL
ON CONFLICT (sync_log_id) DO NOTHING;

-- ── NULL the heavy columns on pulse_sync_logs ────────────────────────────
-- We keep the columns for backward compat (in case any code still reads them
-- before we deploy the patched edge functions), but empty them out so the
-- table stops carrying the TOAST weight.
UPDATE pulse_sync_logs
   SET raw_payload = NULL,
       result_summary = NULL,
       input_config = NULL,
       records_detail = NULL
 WHERE raw_payload IS NOT NULL
    OR result_summary IS NOT NULL
    OR input_config IS NOT NULL
    OR records_detail IS NOT NULL;

COMMIT;

-- ── Reclaim space ────────────────────────────────────────────────────────
-- VACUUM FULL must run outside a transaction; documented here for the
-- deploy runbook. Management-API will run it immediately after this commits.
--   VACUUM (FULL, ANALYZE) pulse_sync_logs;
--   ANALYZE pulse_sync_log_payloads;

-- 088: pulse_sync_logs — batch attribution columns
--
-- Purpose: when pulseFireScrapes chunks a cron dispatch into N batches of M
-- suburbs each, each per-suburb pulseDataSync call writes its own
-- pulse_sync_logs row — but until now, the sync-logs row had NO way to say
-- "I came from batch 3 of 10". Batch info lived only in the pulse_fire_batches
-- table and the cron_dispatch_batch timeline events, making it impossible to
-- correlate sync_logs rows back to their dispatch cohort.
--
-- This migration adds three columns:
--   batch_id        — FK to pulse_fire_batches.id (nullable; SET NULL on delete)
--   batch_number    — 1-based index of this suburb's dispatch batch
--   total_batches   — total batches in the parent dispatch
--
-- pulseFireScrapes.ts is updated to pass these in the per-suburb POST body,
-- pulseDataSync.ts is updated to read them from the body and persist them.
-- The SyncHistory table in PulseDataSources.jsx gains a "Batch" column
-- rendering "batch_number / total_batches" (e.g. "3/10").

ALTER TABLE pulse_sync_logs
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES pulse_fire_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_number INT,
  ADD COLUMN IF NOT EXISTS total_batches INT;

-- Partial index: only rows that came from a chunked dispatch have batch_id.
-- Bounded UI queries that filter by batch_id are rare but should be O(log n).
CREATE INDEX IF NOT EXISTS idx_pulse_sync_logs_batch_id
  ON pulse_sync_logs(batch_id) WHERE batch_id IS NOT NULL;

-- Composite index for the common "all logs from batch N of run X" query,
-- which PulseDataSources displays inside a run-card expansion.
CREATE INDEX IF NOT EXISTS idx_pulse_sync_logs_source_batch
  ON pulse_sync_logs(source_id, batch_id, batch_number)
  WHERE batch_id IS NOT NULL;

COMMENT ON COLUMN pulse_sync_logs.batch_id IS
  'FK to pulse_fire_batches.id when this log row was dispatched as part of a chunked cron run. NULL for ad-hoc/manual syncs.';
COMMENT ON COLUMN pulse_sync_logs.batch_number IS
  '1-based index of the batch this suburb was dispatched in. Paired with total_batches.';
COMMENT ON COLUMN pulse_sync_logs.total_batches IS
  'Total batch count for the parent dispatch. With batch_number forms "3 of 10" label.';

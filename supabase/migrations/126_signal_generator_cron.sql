-- 126_signal_generator_cron.sql
-- Add source_data jsonb + idempotency infrastructure to pulse_signals and
-- register the daily pulseSignalGenerator cron.
--
-- Why:
--   pulse_signals originally only had free-text title/description fields. The
--   new pulseSignalGenerator needs to record the source row (a timeline event
--   id, a listing id, a pulse_crm_mappings id) AND needs to be safe to re-run
--   without duplicating signals. We add:
--     - source_data jsonb         — full provenance (entity id, run id, raw row)
--     - source_generator text     — 'pulseSignalGenerator' so UI can filter
--     - source_run_id uuid        — identifies the run that produced the row
--     - idempotency_key text      — <generator>:<class>:<entity_key> for dedup
--
-- All columns are nullable so hand-captured signals (QuickAdd) still insert
-- without a source. The unique index is partial so legacy rows don't collide.

BEGIN;

ALTER TABLE pulse_signals
  ADD COLUMN IF NOT EXISTS source_data       JSONB,
  ADD COLUMN IF NOT EXISTS source_generator  TEXT,
  ADD COLUMN IF NOT EXISTS source_run_id     UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key   TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_signals_idempotency
  ON pulse_signals (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_signals_source_generator
  ON pulse_signals (source_generator, created_at DESC)
  WHERE source_generator IS NOT NULL;

COMMENT ON COLUMN pulse_signals.idempotency_key IS
  'Dedup key, format <generator>:<class>:<entity_key>. Partial-unique — re-runs are no-ops.';
COMMENT ON COLUMN pulse_signals.source_data IS
  'Provenance jsonb. For generator rows: {source_type, entity_id, entity_type, raw_row, ...}.';
COMMENT ON COLUMN pulse_signals.source_generator IS
  'Name of the generator that created the row (e.g. pulseSignalGenerator). NULL for hand-captured signals.';

-- ── Cron: daily signal generation at 05:00 UTC (15:00 AEST) ─────────────
-- 4am UTC is taken by pulse-detail-enrich; we run an hour later so the
-- generator sees the freshest timeline events from that run.
SELECT cron.schedule(
  'pulse-signal-generator',
  '0 5 * * *',
  $$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseSignalGenerator',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',  'application/json',
      'x-caller-context', 'cron:pulse-signal-generator'
    ),
    body := jsonb_build_object(
      'trigger',      'cron',
      'lookback_hours', 24
    )
  );
  $$
);

COMMIT;

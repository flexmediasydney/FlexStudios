-- 110_pulse_timeline_idempotency.sql
-- Post-ship hotfix: pulse_timeline had no idempotency_key column, so
-- pulseDetailEnrich inserts were silently failing (Supabase swallowed the
-- "column does not exist" errors because emitTimeline() only surfaces
-- errors that don''t include "duplicate" in the message).
--
-- Add the column + unique index so:
--   - Future event emissions are dedup-safe at the DB layer
--   - Backfill runs re-running against the same listing don''t multiply events

BEGIN;

ALTER TABLE pulse_timeline
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index — non-null keys only (so legacy rows without keys
-- don''t collide). Matches the pattern used by notifications.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_timeline_idempotency
  ON pulse_timeline (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN pulse_timeline.idempotency_key IS
  'Dedup key for event emission. Format: <event_type>:<entity_key>[:<sub>]. '
  'Re-running the same detection logic against the same entity produces the '
  'same key, and the unique index prevents duplicate events.';

COMMIT;

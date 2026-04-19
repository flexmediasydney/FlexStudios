-- 146_pulse_timeline_full_unique_idempotency.sql
--
-- Fix: emitTimeline() helper calls `.upsert(batch, { onConflict: 'idempotency_key',
-- ignoreDuplicates: true })` which Supabase client translates to
-- `ON CONFLICT (idempotency_key)` (plain, no predicate). Postgres rejects that
-- against our PARTIAL unique index (`WHERE idempotency_key IS NOT NULL`) with
-- error 42P10: "no unique or exclusion constraint matches the ON CONFLICT
-- specification". The helper swallows the error via console.warn and silently
-- fails, so no timeline rows from recent pulseDataSync runs actually land.
--
-- Verification (2026-04-19):
--   - Plain INSERT ... ON CONFLICT (idempotency_key) DO NOTHING → 42P10 error
--   - INSERT ... ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING → works
--   - Supabase-js doesn't support a WHERE predicate on onConflict.
--
-- Fix: make the unique index FULL (no partial WHERE), which makes plain
-- ON CONFLICT (idempotency_key) work. To do that we must first ensure every
-- row has a non-null, unique idempotency_key so the unique index is buildable.
--
-- Historical rows (pre-key-enforcement, 17,780 rows at time of writing) have
-- NULL idempotency_key. We backfill them with `legacy:<row.id>` — guaranteed
-- unique because row id is a UUID primary key.

BEGIN;

-- 1. Backfill NULL idempotency_keys with legacy synthetic keys
UPDATE pulse_timeline
   SET idempotency_key = 'legacy:' || id::text
 WHERE idempotency_key IS NULL;

-- 2. Drop the old partial unique index
DROP INDEX IF EXISTS idx_pulse_timeline_idempotency;

-- 3. Create a full unique index (now that every row has a unique non-null key)
CREATE UNIQUE INDEX idx_pulse_timeline_idempotency
  ON pulse_timeline (idempotency_key);

-- 4. Enforce NOT NULL so future bugs can't reintroduce null keys
ALTER TABLE pulse_timeline
  ALTER COLUMN idempotency_key SET NOT NULL;

-- Verify: count rows with non-null keys + confirm index coverage
-- (manual check after apply; no DO block to keep it simple and transaction-safe)

COMMIT;

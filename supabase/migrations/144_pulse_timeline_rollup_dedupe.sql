-- 144_pulse_timeline_rollup_dedupe.sql
-- ────────────────────────────────────────────────────────────────────────────
-- Purpose
--   Dedupe the four broken rollup/NULL-entity event types audited by Agent D:
--     • new_listings_detected   (~2,167 keyless rollup rows)
--     • client_new_listing      (~161   keyless rollup rows)
--     • price_change            (~13    rollup + per-listing mix)
--     • status_change           (~10    rollup + per-listing mix)
--
-- Root cause
--   Writers in pulseDataSync/index.ts (lines 1412-1458, 1795-1806 at the time
--   of Agent D's audit) emitted rows without an `idempotency_key`, so every
--   re-run of the same sync created a fresh row. Migration 141 added the
--   UNIQUE partial index `idx_pulse_timeline_idempotency`, but the partial
--   index excludes NULL — so unkeyed rows could still duplicate.
--
-- Fix (this migration)
--   Dedupe by the strongest logical key we can reconstruct from row contents:
--     • new_listings_detected / client_new_listing: one row per (source,
--       sync_log_id) if sync_log_id is available, else one row per
--       (source, created_at::date) as a weaker fallback.
--     • price_change / status_change: the writer also emitted keyless
--       rollup rows — keep the earliest per (entity_type, pulse_entity_id)
--       when entity_id is set, and one per (source, title, description) for
--       the NULL-entity rollups.
--
-- Writer fix (separate commit)
--   Same commit as this migration rewrites the four writers to use the
--   new `_shared/timeline.ts` helper with `makeIdempotencyKey(...)`. Going
--   forward, the UNIQUE partial index absorbs re-emits.
--
-- Safety
--   • Earliest row (by created_at, then id) is preserved for each logical key.
--   • All DELETEs are scoped to the four affected event_types.
--   • Running this twice is a no-op — once the table is clean, all ranked
--     CTEs yield rn=1 for every row.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. new_listings_detected ──────────────────────────────────────────────────
-- One rollup row per (source, sync_log_id). If sync_log_id is NULL (older
-- rows predate migration 141's backfill), fall back to (source, day).
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY
        event_type,
        source,
        COALESCE(sync_log_id::text, 'null-log:' || created_at::date::text)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'new_listings_detected'
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. client_new_listing ─────────────────────────────────────────────────────
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY
        event_type,
        source,
        COALESCE(sync_log_id::text, 'null-log:' || created_at::date::text)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'client_new_listing'
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. price_change ───────────────────────────────────────────────────────────
-- Two passes: entity-scoped rows first (earliest per listing per day), then
-- NULL-entity rollup rows (earliest per source/title/description).
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY entity_type, pulse_entity_id, event_type, created_at::date
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'price_change'
    AND pulse_entity_id IS NOT NULL
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

WITH ranked_null AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY event_type, source, title, description
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'price_change'
    AND pulse_entity_id IS NULL
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked_null WHERE rn > 1);

-- 4. status_change ──────────────────────────────────────────────────────────
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY entity_type, pulse_entity_id, event_type, created_at::date
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'status_change'
    AND pulse_entity_id IS NOT NULL
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

WITH ranked_null AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY event_type, source, title, description
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'status_change'
    AND pulse_entity_id IS NULL
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked_null WHERE rn > 1);

COMMIT;

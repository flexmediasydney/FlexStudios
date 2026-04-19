-- 143_pulse_timeline_first_seen_dedupe.sql
-- Dedupe first_seen events: keep only the earliest row per
-- (entity_type, pulse_entity_id, event_type='first_seen'). Cause: the
-- bridge-create path in pulseDataSync emitted first_seen on every
-- rediscovery instead of only on genuine inserts (fixed separately by
-- Agent E). Motivating case: Simon So (agent_id
-- 324cb330-b228-4417-9cf9-f9213072562c) accumulated ~19 first_seen rows.
--
-- Safe & idempotent: deletes only rows that duplicate an earlier row per
-- (entity_type, pulse_entity_id, event_type). Preserves the earliest row
-- (by created_at, then id) as the canonical first_seen. Running twice is
-- a no-op once the table is clean.

BEGIN;

-- Dedupe rows with a pulse_entity_id, scoped by entity_type so that
-- listing/agent/agency namespaces don't collide.
WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY entity_type, pulse_entity_id, event_type
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'first_seen'
    AND pulse_entity_id IS NOT NULL
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Dedupe rows with NULL pulse_entity_id that share (entity_type, rea_id).
WITH ranked_rea AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY entity_type, rea_id, event_type
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM pulse_timeline
  WHERE event_type = 'first_seen'
    AND pulse_entity_id IS NULL
    AND rea_id IS NOT NULL
)
DELETE FROM pulse_timeline
 WHERE id IN (SELECT id FROM ranked_rea WHERE rn > 1);

COMMIT;

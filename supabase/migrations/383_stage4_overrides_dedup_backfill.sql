-- 383_stage4_overrides_dedup_backfill.sql
--
-- W11.7.1 hygiene: shortlisting_stage4_overrides was written with a pure
-- INSERT on every Stage 4 run, so each regen appended a duplicate batch.
-- Rainbow Cres round c55374b1 accumulated 15 audit rows across 4 runs but
-- only 6 unique (stem, field) keys.
--
-- Two parts in one migration:
--
-- 1) BACKFILL: collapse existing dupes by keeping ONLY the most recent row
--    per (round_id, stem, field) triple. ROW_NUMBER() partitions and ranks
--    by created_at DESC; rn>1 are stale dupes, deleted.
--
-- 2) HARD INVARIANT: add a unique index on (round_id, stem, field) so any
--    future regression in the function code is rejected at the DB layer
--    rather than silently growing the audit table again. The matching
--    edge-function fix (delete-then-insert in persistStage4Overrides) lives
--    in supabase/functions/shortlisting-shape-d-stage4/index.ts.

-- Step 1: Backfill dedup. Keep newest per (round_id, stem, field).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY round_id, stem, field
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM shortlisting_stage4_overrides
)
DELETE FROM shortlisting_stage4_overrides sso
USING ranked r
WHERE sso.id = r.id
  AND r.rn > 1;

-- Step 2: Hard-enforce the invariant going forward.
-- Partial-index syntax not strictly needed here (no NULL columns in the
-- key triple — round_id, stem, field are all NOT NULL), but use IF NOT
-- EXISTS so the migration is replay-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_stage4_overrides_round_stem_field
  ON shortlisting_stage4_overrides (round_id, stem, field);

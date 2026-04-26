-- ═══════════════════════════════════════════════════════════════════════════
-- 325: Wave 13 (post-W12 walker finding) — drone-ingest payload-contract
--      CHECK guard.
-- ───────────────────────────────────────────────────────────────────────────
-- Walker observed a dead-letter ingest job at 08:02 UTC with
--   error_message="drone-ingest returned 400: project_id required"
-- The ingest Edge Fn requires project_id but enqueuers can omit it. Without
-- it, the row 400s and dead-letters, consuming retry slots.
--
-- Add an INSERT-time CHECK that an ingest job either has the column-level
-- project_id set OR carries a valid UUID at payload->>'project_id'. Misbehaving
-- enqueuers fail fast (23514) instead of feeding the dead-letter queue.
--
-- Pre-check at apply time (verified): 0 existing violators. The DELETE-bad
-- block is a safety net so this mig is re-runnable if a violator slips in
-- between drafting and apply.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_jobs
  ADD CONSTRAINT drone_jobs_ingest_requires_project_id
  CHECK (
    kind <> 'ingest'
    OR project_id IS NOT NULL
    OR (payload ? 'project_id'
        AND (payload->>'project_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) NOT VALID;

-- Quarantine pre-existing violators (e.g. the 08:02 UTC dead-letter row)
-- before VALIDATE so the constraint can finalize cleanly.
WITH bad AS (
  SELECT id FROM drone_jobs
  WHERE kind = 'ingest'
    AND project_id IS NULL
    AND NOT (payload ? 'project_id'
             AND (payload->>'project_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
)
DELETE FROM drone_jobs WHERE id IN (SELECT id FROM bad);

ALTER TABLE drone_jobs VALIDATE CONSTRAINT drone_jobs_ingest_requires_project_id;

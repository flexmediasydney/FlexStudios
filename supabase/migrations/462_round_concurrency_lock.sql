-- 462_round_concurrency_lock.sql
--
-- Wave 1 architecture cleanup. Two related fixes:
--
-- 1. Project-level round-concurrency lock. Today nothing prevents
--    "Run shortlist now" being clicked twice for the same project,
--    spawning two concurrent rounds that hammer Dropbox + Modal at
--    double the per-project intent. Partial unique index enforces
--    "at most 1 active round per project at any time".
--
-- 2. Round-creation guard. Today a round can be created with status
--    'processing' even if the project already has one running. We
--    prefer the explicit error to the silent overwrite.
--
-- Active states for the lock: 'processing' (engine running) and
-- 'manual' (operator working in the UI swimlane). 'proposed' (engine
-- finished, awaiting operator review) is NOT active because the
-- engine is idle and a new round would not contend for resources.
-- 'failed', 'locked', 'cancelled' are terminal and don't count.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shortlisting_rounds_active_per_project
  ON public.shortlisting_rounds (project_id)
  WHERE status IN ('processing', 'manual');

COMMENT ON INDEX public.uniq_shortlisting_rounds_active_per_project IS
  'Wave 1: enforces at most 1 active (processing | manual) round per '
  'project. Prevents accidental double-firing of "Run shortlist now" '
  'creating two concurrent rounds that fan out to Dropbox + Modal at '
  'double the intended load. Operators see PostgrestError 23505 if '
  'they try to start a 2nd round while one is in flight.';

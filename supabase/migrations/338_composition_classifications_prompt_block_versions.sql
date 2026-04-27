-- Wave 7 P1-10 (W7.6): composition_classifications.prompt_block_versions JSONB.
--
-- Captures the version map (block name → version string) of every prompt
-- block that was assembled into the Pass 1 inference for this row. The new
-- visionPrompts/blocks/ catalogue is versioned per-block (each *_BLOCK_VERSION
-- constant); the pass1 builder aggregates them into a Record<name, version>
-- and persists it here so an ops query like
--
--   SELECT prompt_block_versions, COUNT(*)
--     FROM composition_classifications
--    WHERE created_at > NOW() - INTERVAL '7 days'
--    GROUP BY prompt_block_versions
--    ORDER BY 2 DESC;
--
-- can correlate output drift with prompt-block version changes after the fact.
--
-- Spec: docs/design-specs/W7-6-vision-prompt-blocks.md (Phase B).
--
-- Nullable, no backfill: pre-W7.6 rows have NULL here, which the swimlane
-- diagnostics renderer treats as "spec default — see git history".
--
-- ─── Forward ────────────────────────────────────────────────────────────────

ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS prompt_block_versions JSONB;

COMMENT ON COLUMN composition_classifications.prompt_block_versions IS
  'Wave 7 P1-10 (W7.6): map of block name → version (e.g. {"header":"v1.0","pass1OutputSchema":"v1.0"}). Persists which prompt-block versions ran each Pass 1 inference for run-time provenance.';

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (run MANUALLY if this migration breaks production) ────────────
--
-- ALTER TABLE composition_classifications DROP COLUMN IF EXISTS prompt_block_versions;
-- NOTIFY pgrst, 'reload schema';
--
-- Rollback is data-lossy for any rows that landed after the column existed.
-- Forward callers (shortlisting-pass1) MUST be re-deployed at the prior commit
-- BEFORE dropping the column or every Pass 1 insert 500s on the missing field.
-- To preserve the provenance audit history before dropping:
--
--   CREATE TABLE _rollback_w7_6_composition_classifications AS
--     SELECT id, prompt_block_versions
--     FROM composition_classifications
--     WHERE prompt_block_versions IS NOT NULL;
--
-- Then DROP COLUMN.

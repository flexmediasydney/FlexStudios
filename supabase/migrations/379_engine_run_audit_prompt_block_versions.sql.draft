-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 379 — W11.7 cleanup: engine_run_audit.prompt_block_versions column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md §"Replay
--       reproducibility" — prompt_block_versions stamped at both
--       composition_classifications and engine_run_audit levels.
--
-- ─── WHY THIS COLUMN ──────────────────────────────────────────────────────────
--
-- The W11.7 spec calls out two replay-reproducibility surfaces:
--
--   1. composition_classifications.prompt_block_versions (per-image stamp)
--      Already present from mig 371-376. Populated by shortlisting-shape-d
--      Stage 1 with the version map of every prompt block that contributed
--      to that image's classification.
--
--   2. engine_run_audit.prompt_block_versions (per-round stamp)
--      Captures the round-level merge of all stamps that contributed across
--      all stages. Used by the replay harness to deterministically reconstruct
--      the prompt environment that produced the round, even after individual
--      block versions evolve.
--
-- The column was specced but never landed in mig 376. This migration adds it
-- now, with a NULL backfill — historical rounds simply lack this attribution
-- (they're fine; the per-image rows on composition_classifications still have
-- the stamp). New Stage 1 + Stage 4 runs will populate it from this point.
--
-- ─── SHAPE ────────────────────────────────────────────────────────────────────
--
-- JSONB. Example value:
--   {
--     "voice_anchor": "v1.0",
--     "source_context": "v1.0",
--     "sydney_primer": "v1.0",
--     "self_critique": "v1.0",
--     "stage1_response_schema": "v1.0",
--     "stage4_prompt": "v1.0"
--   }
--
-- Keys are stable identifiers from the visionPrompts/blocks/ module. Values
-- are the version stamps exported from each block module
-- (e.g. SOURCE_CONTEXT_BLOCK_VERSION).
--
-- ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────
--
-- ADD COLUMN IF NOT EXISTS — safe to re-apply.

ALTER TABLE engine_run_audit
  ADD COLUMN IF NOT EXISTS prompt_block_versions JSONB;

COMMENT ON COLUMN engine_run_audit.prompt_block_versions IS
  'Wave 11.7: per-round stamp of prompt block versions that contributed to '
  'this run. Merged from Stage 1 and Stage 4 block module exports. Used by '
  'replay harness to deterministically reconstruct prompt environment. '
  'Example: {"voice_anchor": "v1.0", "source_context": "v1.0", '
  '"stage4_prompt": "v1.0", ...}. NULL on historical rounds that pre-date '
  'this column (their per-image stamps still live on '
  'composition_classifications.prompt_block_versions).';

-- No index needed — replay-harness queries lookup by round_id (PK).

NOTIFY pgrst, 'reload schema';

-- ─── Rollback ─────────────────────────────────────────────────────────────────
-- ALTER TABLE engine_run_audit DROP COLUMN IF EXISTS prompt_block_versions;

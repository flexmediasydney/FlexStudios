-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 397 — Wave 12.6: object_registry.auto_promoted audit columns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/WAVE_PLAN.md line 252 — W12.6 AI auto-suggestion engine for
--       canonical promotion (confidence-gated auto-promote at cosine ≥ 0.92).
--
-- ─── WHY THIS WAVE EXISTS ─────────────────────────────────────────────────────
--
-- W11.6.11 shipped the W12 discovery queue with manual operator-driven promote.
-- Today every candidate row that the canonical-rollup batch produces with
-- top_match_score ≥ 0.92 still requires a human click. W12.6 closes the loop
-- with the new `canonical-auto-suggest` edge fn: when cosine ≥ 0.92, the AI
-- merges the candidate into the matching canonical automatically; cosine
-- 0.75-0.92 stays in the queue for operator review; cosine < 0.75 stays as
-- a fresh candidate.
--
-- For the audit trail we need to distinguish machine-promoted rows from
-- human-promoted rows in `object_registry`. Two new columns:
--
--   * auto_promoted     BOOLEAN (default FALSE)  — TRUE when AI promoted
--   * auto_promoted_at  TIMESTAMPTZ              — when the AI promoted
--
-- These compose with the existing `curated_by` (UUID → auth.users) which
-- stays NULL for AI promotions. So the rule is:
--
--   curated_by IS NOT NULL AND auto_promoted = FALSE  →  human curated
--   curated_by IS NULL     AND auto_promoted = TRUE   →  AI auto-promoted
--   curated_by IS NULL     AND auto_promoted = FALSE  →  bootstrap seed (mig 381)
--
-- The discovery UI surfaces a sparkles badge + faded green background when
-- `auto_promoted = TRUE` so operators can spot machine decisions at a glance.
--
-- ─── COMMENTS / INDEXES ───────────────────────────────────────────────────────
--
-- We index `auto_promoted_at` because the W12.6 cron / manual-trigger smoke
-- output queries it ("rows AI-promoted in the last 7 days"). Partial index on
-- `auto_promoted = TRUE` keeps it small — the bulk of the registry will be
-- human-curated for a long time.
--
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE object_registry
  ADD COLUMN IF NOT EXISTS auto_promoted    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_promoted_at TIMESTAMPTZ;

COMMENT ON COLUMN object_registry.auto_promoted IS
  'Wave 12.6: TRUE when the canonical-auto-suggest edge fn merged this row from a candidate at cosine >= 0.92. Distinguishes AI promotions from human promotions (where curated_by is set). Surfaced in the discovery UI as a sparkles badge.';

COMMENT ON COLUMN object_registry.auto_promoted_at IS
  'Wave 12.6: timestamp of the AI auto-promotion. NULL for human-curated and bootstrap-seeded rows.';

-- Partial index for "what did the AI promote in the last N days?" reports.
CREATE INDEX IF NOT EXISTS idx_object_registry_auto_promoted
  ON object_registry(auto_promoted_at DESC)
  WHERE auto_promoted = TRUE;

-- ─── PostgREST schema reload ────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- ALTER TABLE object_registry DROP COLUMN IF EXISTS auto_promoted_at;
-- ALTER TABLE object_registry DROP COLUMN IF EXISTS auto_promoted;
-- DROP INDEX IF EXISTS idx_object_registry_auto_promoted;

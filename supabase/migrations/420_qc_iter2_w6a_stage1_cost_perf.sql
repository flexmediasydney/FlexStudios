-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 420 — QC iter2 Wave 6a: Stage 1 cost cap + Gemini context cache
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: QC iter 2 Wave 6a — three Stage 1 findings rolled into one wave:
--   F-E-001 (P0): cost cap was advisory; Rainbow Cres blew it 3.5× to $35.82.
--                 Add `stage1_cost_cap_usd` engine setting (separate from the
--                 existing pre-flight `cost_cap_per_round_usd`); orchestrator
--                 enforces it as a HARD-STOP between pool workers via a
--                 running tally. When breached, round transitions to
--                 status='failed' with error_summary='cost_cap_exceeded'.
--   F-E-006 (P1): slice-based fanout (Promise.all over 8-image chunks) wastes
--                 wall time. Replaced with a permit-based pool — the worker
--                 mid-pool cap check ties cleanly into the new running-cost
--                 tally above.
--   F-E-007 (P0): Stage 1 burns $2.06/round of duplicate context (33 calls ×
--                 ~50K shared system tokens × $1.25/M). Wired Gemini explicit
--                 `cachedContents` API: cache the system prompt once per
--                 round, reference it from each per-image call. Cache hit
--                 ratio + cached input tokens persisted to engine_run_audit
--                 via the two new columns added below.
--
-- ─── COLUMNS ADDED ────────────────────────────────────────────────────────────
--
--   stage1_cache_hit_count INT NOT NULL DEFAULT 0
--     Number of per-image calls in Stage 1 that hit the explicit cached
--     content (i.e. usageMetadata.cachedContentTokenCount > 0). Equal to
--     stage1_call_count when the cache is fully effective; lower when the
--     cache failed to create + we fell back to inline prompts on some calls.
--
--   stage1_cached_input_tokens BIGINT NOT NULL DEFAULT 0
--     Sum of cachedContentTokenCount across all Stage 1 per-image calls.
--     Multiplied by 0.25 × (input rate) gives the actual billed cache cost.
--     The non-cached portion sits in stage1_total_input_tokens (already
--     present, mig 376) — the two together reconstruct the full billed
--     prompt size per round.
--
-- ─── ENGINE SETTINGS SEEDED ──────────────────────────────────────────────────
--
--   stage1_cost_cap_usd (default 10) — hard-stop cap enforced mid-pool by the
--     Stage 1 orchestrator. Distinct from the existing
--     cost_cap_per_round_usd (pre-flight estimate cap, mig 378a). The
--     orchestrator reads BOTH: pre-flight rejects if estimate > preflight cap
--     (existing behaviour), running tally trips status=failed if running >
--     stage1 cap (NEW behaviour). Operator can set them to different values
--     to keep a generous pre-flight estimate ceiling while clamping actual
--     observed cost tightly.
--
-- ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────
--
-- ADD COLUMN IF NOT EXISTS preserves any prior partial-shipped column. The
-- engine_settings INSERT uses ON CONFLICT DO NOTHING so an operator-set value
-- (someone bumped the cap manually before this migration ran) is preserved.

BEGIN;

-- ─── 1. engine_run_audit: cache hit accounting ───────────────────────────────

ALTER TABLE engine_run_audit
  ADD COLUMN IF NOT EXISTS stage1_cache_hit_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage1_cached_input_tokens BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN engine_run_audit.stage1_cache_hit_count IS
  'QC iter2 W6a (F-E-007): number of Stage 1 per-image calls that hit the '
  'explicit Gemini cachedContents (cachedContentTokenCount > 0). Equals '
  'stage1_call_count when caching was fully effective; lower if creation '
  'failed and we fell back to inline prompts on some calls.';

COMMENT ON COLUMN engine_run_audit.stage1_cached_input_tokens IS
  'QC iter2 W6a (F-E-007): sum of cachedContentTokenCount across all Stage 1 '
  'per-image calls. Billed at 25% of standard input rate. Combined with '
  'stage1_total_input_tokens (already present, mig 376) reconstructs the '
  'full billed prompt size per round.';

-- ─── 2. engine_settings: stage1 hard-stop cost cap ───────────────────────────

INSERT INTO engine_settings (key, value, description) VALUES
  ('stage1_cost_cap_usd',
   '10'::jsonb,
   'QC iter2 W6a (F-E-001): hard-stop cost ceiling for Stage 1 enforced '
   'mid-pool by shortlisting-shape-d. Distinct from cost_cap_per_round_usd '
   '(pre-flight estimate cap, mig 378a). The orchestrator reads BOTH: '
   'pre-flight rejects if estimate > preflight cap, running tally aborts '
   'the round with status=failed + error_summary=cost_cap_exceeded if any '
   'mid-pool worker pushes runningCostUsd over this cap. Default 10 USD '
   '(matches the code-level fallback).')
ON CONFLICT (key) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ─── Rollback ─────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE engine_run_audit
--   DROP COLUMN IF EXISTS stage1_cache_hit_count,
--   DROP COLUMN IF EXISTS stage1_cached_input_tokens;
-- DELETE FROM engine_settings WHERE key = 'stage1_cost_cap_usd';
-- COMMIT;

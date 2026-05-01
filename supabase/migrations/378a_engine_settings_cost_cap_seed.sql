-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 378 — W11.7 cleanup: engine_settings cost_cap_per_round_usd seed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md
--
-- ─── WHY THIS SEED ────────────────────────────────────────────────────────────
--
-- Both shortlisting-shape-d (Stage 1) and shortlisting-shape-d-stage4 read
-- engine_settings.cost_cap_per_round_usd to enforce a per-round cost ceiling
-- before kicking off vendor calls. Both read with a hardcoded fallback of 10
-- (USD) so the cap exists in code regardless. However, the row was never
-- explicitly seeded into engine_settings — meaning:
--
--   1. The master_admin dashboard showing "configured cap" displays nothing.
--   2. Tweaks to the cap require an INSERT (not an UPDATE) the first time,
--      which is awkward UX.
--   3. There's no audit trail of what value was active when a round ran (the
--      hardcoded fallback is invisible in the engine_settings table).
--
-- Seeding with the same value the code defaults to (10 USD) keeps current
-- behaviour identical while making the configuration explicit and queryable.
--
-- ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────
--
-- ON CONFLICT DO NOTHING preserves any existing operator-set value (if a
-- master_admin pre-emptively configured it). Re-running the migration is a
-- no-op once the row exists.

INSERT INTO engine_settings (key, value, description) VALUES
  ('cost_cap_per_round_usd',
   '10'::jsonb,
   'Wave 11.7: per-round USD cost ceiling enforced by shortlisting-shape-d '
   '(Stage 1) and shortlisting-shape-d-stage4 (Stage 4) before vendor calls. '
   'Default 10 (matches the code-level fallback). master_admin can raise '
   'temporarily for outlier-large shoots; lower to clamp cost in development. '
   'Enforced as a pre-flight check — exceeding the cap aborts the round '
   'before any paid call.')
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- ─── Rollback ─────────────────────────────────────────────────────────────────
-- DELETE FROM engine_settings WHERE key = 'cost_cap_per_round_usd';

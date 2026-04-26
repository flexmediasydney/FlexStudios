-- ═══════════════════════════════════════════════════════════════════════════
-- 323: Wave 13 C — declare success_rate_pct column type/range explicitly in
--      the function comment so future callers don't expect a 0..1 ratio.
-- ───────────────────────────────────────────────────────────────────────────
-- Walker observed callers occasionally treat the column as a 0..1 fraction
-- and multiply by 100 — yielding e.g. 8750%. The RPC actually returns
-- NUMERIC(5,2) in 0..100. Pin the contract in the function comment.
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON FUNCTION public.get_shoot_render_success_rate(uuid, text) IS
  'Wave 10 success-rate RPC. Returns SETOF (expected_shots, rendered_shots, missing_shots, success_rate_pct, per_kind). success_rate_pct is NUMERIC(5,2) — range 0..100, two decimals (e.g. 87.50 means 87.5%). NOT a 0..1 ratio.';

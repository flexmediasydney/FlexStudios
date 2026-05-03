-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 454 — W11.8 gallery_positions instance-aware fields
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: W11.8 Space Instance Clustering. Companion to mig 453 (which adds the
-- shortlisting_space_instances table + composition_groups.space_instance_id).
--
-- This migration teaches `gallery_positions` to target the Nth detected
-- instance of a space_type AND to enforce instance-uniqueness across positions
-- in the same recipe. Examples:
--
--   - Position "Master Bedroom 1": space_type='master_bedroom',
--     instance_index=1.
--   - Position "Master Bedroom 2": space_type='master_bedroom',
--     instance_index=2 — when the round has at least 2 master bedrooms.
--   - All-instances mode: instance_index=NULL, instance_unique_constraint=TRUE
--     means "any instance, but each position fed by a DIFFERENT one".
--
-- ─── DESIGN DECISIONS ───────────────────────────────────────────────────────
-- 1. instance_index is INT, 1-indexed (matches shortlisting_space_instances).
--    NULL = wildcard, "match any instance". 1 = first detected, 2 = second.
-- 2. instance_unique_constraint defaults to FALSE per Joseph's sign-off.
--    Operators opt in per position when they want hard separation. This keeps
--    the existing recipe corpus working unchanged.
-- 3. No CHECK on instance_index range — bound by what the round actually
--    detects at runtime. The Stage 4 prompt + persistence handle the gap.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- ALTER TABLE gallery_positions
--   DROP COLUMN IF EXISTS instance_index,
--   DROP COLUMN IF EXISTS instance_unique_constraint;
-- (Rollback drops authored instance targeting; positions resume "any instance"
-- behaviour by default — safe.)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.gallery_positions
  ADD COLUMN IF NOT EXISTS instance_index INT,
  ADD COLUMN IF NOT EXISTS instance_unique_constraint BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.gallery_positions.instance_index IS
  'W11.8: target the Nth detected space_instance for this position''s '
  'space_type. NULL = match any instance. 1-indexed (1=first detected, '
  '2=second, etc.). The round''s shortlisting_space_instances table is the '
  'source of truth for which indices exist.';

COMMENT ON COLUMN public.gallery_positions.instance_unique_constraint IS
  'W11.8: if true, every position in this scope/recipe with the same '
  'constraint tuple must be matched to a DIFFERENT space_instance_id. If not '
  'enough instances exist, position stays empty (or ai_backfill if enabled). '
  'Defaults to FALSE so existing recipes are unchanged. Operator opts in.';

CREATE INDEX IF NOT EXISTS idx_gallery_positions_instance_index
  ON public.gallery_positions(instance_index)
  WHERE instance_index IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- W11.6.25 — Slot Recipes architecture.
--
-- Joseph confirmed (2026-05-02) the 5 design decisions that shape this wave:
--
--   1. scope_type='package' OVERRIDES scope_type='package_tier'
--      (most-specific wins per scope; precedence chain at resolve time:
--      project_type → package_tier → package → individual_product).
--
--   2. Composition merge: when two scopes hit the same slot_id, SUM
--      allocated_count and ESCALATE classification with the order
--      mandatory > conditional > free_recommendation. priority_rank keeps the
--      MIN (lowest = highest priority); notes are concatenated with newlines;
--      max_count is HIGHER-WINS between the recipe's max_count and the slot's
--      max_images (slot.max_images is the floor, recipes can lift it).
--
--   3. max_count semantics: HIGHER wins between the recipe and slot.max_images.
--
--   4. NO version column on shortlisting_slot_allocations — straight UPDATEs
--      on edits, no replay history.
--
--   5. Tolerance range becomes a per-package setting with a global default in
--      engine_settings. NULL on packages columns falls back to the global.
--
-- Replay safety: all DDL is IF NOT EXISTS / DO NOTHING / DO UPDATE; safe to
-- re-run. No formal FK on slot_id because slot_definitions is keyed on
-- (slot_id, version); resolver soft-validates against the latest active
-- version at round-time.

-- ─── 1. shortlisting_slot_allocations ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.shortlisting_slot_allocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT NOT NULL CHECK (scope_type IN (
    'package','package_tier','project_type','individual_product'
  )),
  scope_ref_id    UUID NOT NULL,
  slot_id         TEXT NOT NULL,
  classification  TEXT NOT NULL CHECK (classification IN (
    'mandatory','conditional','free_recommendation'
  )),
  allocated_count INT  NOT NULL DEFAULT 0 CHECK (allocated_count >= 0),
  max_count       INT  CHECK (max_count IS NULL OR max_count >= 0),
  priority_rank   INT  NOT NULL DEFAULT 100,
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ssa_unique_active
  ON public.shortlisting_slot_allocations (scope_type, scope_ref_id, slot_id)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_ssa_scope_lookup
  ON public.shortlisting_slot_allocations (scope_type, scope_ref_id)
  WHERE is_active = TRUE;

COMMENT ON TABLE public.shortlisting_slot_allocations IS
  'W11.6.25 — Slot Recipes. Per-scope (project_type/package_tier/package/individual_product) allocation rules. Resolver in shortlisting-ingest walks scopes and merges into round.resolved_slot_recipe.';

COMMENT ON COLUMN public.shortlisting_slot_allocations.slot_id IS
  'W11.6.25 — soft reference to shortlisting_slot_definitions.slot_id. No FK because slot_definitions is keyed on (slot_id, version). The resolver joins on the latest active version and skips rows for slot_ids no longer present.';

CREATE OR REPLACE FUNCTION public.tg_slot_allocations_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS slot_allocations_updated_at_trg
  ON public.shortlisting_slot_allocations;
CREATE TRIGGER slot_allocations_updated_at_trg
  BEFORE UPDATE ON public.shortlisting_slot_allocations
  FOR EACH ROW EXECUTE FUNCTION public.tg_slot_allocations_updated_at();

ALTER TABLE public.shortlisting_slot_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slot_alloc_admin_all" ON public.shortlisting_slot_allocations;
CREATE POLICY "slot_alloc_admin_all"
  ON public.shortlisting_slot_allocations
  FOR ALL TO authenticated
  USING (public.get_user_role() = 'master_admin')
  WITH CHECK (public.get_user_role() = 'master_admin');

DROP POLICY IF EXISTS "slot_alloc_manager_read" ON public.shortlisting_slot_allocations;
CREATE POLICY "slot_alloc_manager_read"
  ON public.shortlisting_slot_allocations
  FOR SELECT TO authenticated
  USING (public.get_user_role() IN ('master_admin','admin','manager','photographer','editor'));

DROP POLICY IF EXISTS "slot_alloc_service_role" ON public.shortlisting_slot_allocations;
CREATE POLICY "slot_alloc_service_role"
  ON public.shortlisting_slot_allocations
  FOR ALL TO service_role
  USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS expected_count_tolerance_below INT,
  ADD COLUMN IF NOT EXISTS expected_count_tolerance_above INT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.packages'::regclass
      AND conname = 'packages_tolerance_below_chk') THEN
    ALTER TABLE public.packages
      ADD CONSTRAINT packages_tolerance_below_chk
      CHECK (expected_count_tolerance_below IS NULL OR expected_count_tolerance_below >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.packages'::regclass
      AND conname = 'packages_tolerance_above_chk') THEN
    ALTER TABLE public.packages
      ADD CONSTRAINT packages_tolerance_above_chk
      CHECK (expected_count_tolerance_above IS NULL OR expected_count_tolerance_above >= 0);
  END IF;
END $$;

INSERT INTO public.engine_settings (key, value, description) VALUES
  ('expected_count_tolerance_below', '3'::jsonb, 'W11.6.25 — default tolerance below target.'),
  ('expected_count_tolerance_above', '3'::jsonb, 'W11.6.25 — default tolerance above target.')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.shortlisting_rounds
  ADD COLUMN IF NOT EXISTS resolved_slot_recipe       JSONB,
  ADD COLUMN IF NOT EXISTS resolved_tolerance_below   INT,
  ADD COLUMN IF NOT EXISTS resolved_tolerance_above   INT;

INSERT INTO public.shortlisting_slot_allocations
  (scope_type, scope_ref_id, slot_id, classification, allocated_count, max_count, priority_rank, notes, is_active)
SELECT
  'package_tier',
  t.id,
  s.slot_id,
  CASE s.phase WHEN 1 THEN 'mandatory' WHEN 2 THEN 'conditional' ELSE 'free_recommendation' END,
  COALESCE(s.min_images, 0),
  NULL,
  ((s.phase * 100) +
    (ROW_NUMBER() OVER (PARTITION BY t.id, s.phase ORDER BY s.slot_id)))::INT,
  'W11.6.25 backfill — Joseph tunes via editor.',
  TRUE
FROM public.shortlisting_tiers t
CROSS JOIN (
  SELECT DISTINCT ON (slot_id)
    slot_id, phase, min_images, max_images
  FROM public.shortlisting_slot_definitions
  WHERE is_active = TRUE
  ORDER BY slot_id, version DESC
) s
WHERE t.is_active = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM public.shortlisting_slot_allocations a
    WHERE a.scope_type = 'package_tier'
      AND a.scope_ref_id = t.id
      AND a.slot_id = s.slot_id
      AND a.is_active = TRUE
  );

DO $$
DECLARE
  v_alloc_count INT;
  v_active_tiers INT;
BEGIN
  SELECT COUNT(*) INTO v_alloc_count
    FROM public.shortlisting_slot_allocations
    WHERE is_active = TRUE AND scope_type = 'package_tier';
  SELECT COUNT(*) INTO v_active_tiers
    FROM public.shortlisting_tiers WHERE is_active = TRUE;
  RAISE NOTICE 'W11.6.25 slot recipes: backfilled % package_tier rows across % tiers',
    v_alloc_count, v_active_tiers;
END $$;

NOTIFY pgrst, 'reload schema';

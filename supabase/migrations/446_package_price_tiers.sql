-- ─────────────────────────────────────────────────────────────────────────
-- Mig 446 — package_price_tiers lookup
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-W11.6.28 / Mig 446
-- Author: Joseph Saad (designed) / Stage-3 agent (executed)
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────
--
-- The Recipe Matrix UI shipped in commit b77f370 (W11.6.28) used engine
-- GRADES (Volume / Refined / Editorial) as the matrix's column axis. That
-- was wrong. Joseph's intent was always:
--
--   "Your recipe matrix UI proposal should not be the 'grade', it should
--    be true price matrix tier which is just standard and premium."
--   "Grade doesn't impact slot/position allocations."
--
-- Engine grade is derived per-round from the property's shoot quality and
-- only steers the Stage 4 voice anchor — it doesn't change which positions
-- are allocated. Price tier (Standard / Premium) IS the dimension that
-- changes which positions a package targets. The matrix axes therefore
-- must be:
--
--   rows    = packages (Silver, Gold, AI, …)
--   columns = price_tiers (Standard, Premium)
--
-- Mig 443's scope_type vocabulary already includes 'package_x_price_tier'
-- with scope_ref_id=package_id and scope_ref_id_2=price_tier_id, but no
-- price_tiers table existed. Authors were forced to fall back to grade.
-- This migration introduces a tiny lookup table with stable seed UUIDs so
-- the resolver, the UI, and any downstream tooling can join through one
-- canonical row per tier.
--
-- ─── WHAT THIS MIGRATION DOES ────────────────────────────────────────────
--
-- 1. CREATE TABLE public.package_price_tiers
--    A two-row lookup. The seeded UUIDs are deterministic / hardcoded so
--    the same row exists on every environment without coordination.
--
--    ('a0000000-0000-4000-a000-000000000001', 'standard', 'Standard', 1)
--    ('a0000000-0000-4000-a000-000000000002', 'premium',  'Premium',  2)
--
--    The CHECK on `code` is intentional — only two tiers today, and any
--    expansion must be a deliberate migration.
--
-- 2. RLS — read-only for authenticated; writes go through migrations only.
--    Matches the pattern used by shortlisting_grades / project_types.
--
-- 3. Grants for service_role + authenticated. anon stays revoked (config
--    table; never exposed to logged-out callers).
--
-- 4. NOTIFY pgrst, 'reload schema' so PostgREST picks the new table up
--    immediately for the Recipe Matrix UI.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
--   1. DROP TABLE public.package_price_tiers CASCADE;
--   2. NOTIFY pgrst, 'reload schema';
--
-- (No FKs reference this table at create time. The Recipe Matrix UI's
-- gallery_positions.scope_ref_id_2 is a polymorphic UUID column that
-- doesn't enforce FK integrity, by design.)
--
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1) Lookup table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.package_price_tiers (
  id            uuid        PRIMARY KEY,
  code          text        NOT NULL UNIQUE
                            CHECK (code IN ('standard','premium')),
  display_name  text        NOT NULL,
  display_order int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.package_price_tiers IS
  'W11.6.28b lookup of package PRICE TIERS (Standard / Premium). Distinct '
  'from shortlisting_grades (engine grade Volume/Refined/Editorial), which '
  'is per-round derived. The recipe matrix uses this table as its column '
  'axis — gallery_positions.scope_ref_id_2 references rows from here when '
  'scope_type = ''package_x_price_tier''. UUIDs are stable seeds so cross-'
  'environment recipe authoring lines up without coordination.';

COMMENT ON COLUMN public.package_price_tiers.code IS
  'Stable machine code: ''standard'' or ''premium''. CHECK-constrained so '
  'any new tier requires a deliberate migration.';

COMMENT ON COLUMN public.package_price_tiers.display_order IS
  'Sort key for the recipe matrix column header. Standard=1, Premium=2.';

-- ── 2) Seed the canonical rows with stable UUIDs ─────────────────────────
--
-- Idempotent: ON CONFLICT (id) DO UPDATE keeps the row in sync if the
-- seed is replayed (e.g. a hot-fix that retunes display_name).
INSERT INTO public.package_price_tiers (id, code, display_name, display_order)
VALUES
  ('a0000000-0000-4000-a000-000000000001'::uuid, 'standard', 'Standard', 1),
  ('a0000000-0000-4000-a000-000000000002'::uuid, 'premium',  'Premium',  2)
ON CONFLICT (id) DO UPDATE
  SET code          = EXCLUDED.code,
      display_name  = EXCLUDED.display_name,
      display_order = EXCLUDED.display_order;

-- ── 3) RLS — read-only for authenticated callers ─────────────────────────
ALTER TABLE public.package_price_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS package_price_tiers_select ON public.package_price_tiers;
CREATE POLICY package_price_tiers_select
  ON public.package_price_tiers
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT / UPDATE / DELETE policies — writes flow only through
-- migrations (which run as superuser / service_role and bypass RLS).

REVOKE ALL ON TABLE public.package_price_tiers FROM public, anon;
GRANT  SELECT ON TABLE public.package_price_tiers TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON TABLE public.package_price_tiers TO service_role;

-- ── 4) PostgREST schema reload ──────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

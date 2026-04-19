-- 157_price_matrix_default_tier.sql
-- Adds default_tier to price_matrices so agency/agent/organization matrices
-- can declare authoritative std/prm preference for the Market Share engine's
-- tier resolution cascade (step T1/T2 in pulse_compute_listing_quote).
--
-- Model: when default_tier is set, the engine uses it directly — no proximity
-- inheritance needed. When null, engine falls back to proximity-based tier
-- inheritance from nearest past project.
--
-- Safe to re-run: column add is IF NOT EXISTS; seed uses UPSERT-style match.

BEGIN;

-- ── 1. Add default_tier column ─────────────────────────────────────────────
ALTER TABLE price_matrices
  ADD COLUMN IF NOT EXISTS default_tier TEXT;

-- ── 2. CHECK constraint: only 'standard' | 'premium' | NULL ────────────────
-- NULL = auto-detect via proximity. Any other value rejected.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'price_matrices_default_tier_check'
      AND table_name = 'price_matrices'
  ) THEN
    ALTER TABLE price_matrices
      ADD CONSTRAINT price_matrices_default_tier_check
      CHECK (default_tier IS NULL OR default_tier IN ('standard', 'premium'));
  END IF;
END $$;

-- ── 3. Seed known tier preferences ─────────────────────────────────────────
-- Per user decision 2026-04-19:
--   Belle Property Balmain           → auto-detect (null)
--   Ray White Strathfield            → auto-detect (null)
--   Belle Property - Strathfield     → premium
--   LJ Hooker Bankstown              → auto-detect (null) — no overrides
--   Raine & Horne Concord            → auto-detect (null) — no overrides
--
-- Only Belle Property - Strathfield is explicitly seeded; the rest stay null.
UPDATE price_matrices
SET default_tier = 'premium'
WHERE entity_name = 'Belle Property - Strathfield'
  AND project_type_name = 'Residential Real Estate'
  AND entity_type = 'agency';

-- ── 4. Index for fast tier lookup ──────────────────────────────────────────
-- The Market Share quote RPC will query:
--   SELECT default_tier FROM price_matrices
--   WHERE entity_type=$1 AND entity_id=$2 AND project_type_name=$3
--   AND default_tier IS NOT NULL
-- Add a partial index to skip rows where the field is null (majority today).
CREATE INDEX IF NOT EXISTS idx_price_matrices_default_tier
  ON price_matrices(entity_type, entity_id, project_type_name)
  WHERE default_tier IS NOT NULL;

COMMIT;

-- ── Rollback notes ─────────────────────────────────────────────────────────
-- To reverse: DROP the index, CHECK constraint, then the column.
--   DROP INDEX IF EXISTS idx_price_matrices_default_tier;
--   ALTER TABLE price_matrices DROP CONSTRAINT IF EXISTS price_matrices_default_tier_check;
--   ALTER TABLE price_matrices DROP COLUMN IF EXISTS default_tier;

-- 207_price_matrix_versions_newstate.sql
-- Correct the version-capture semantic: each version row should represent a
-- TRUE STATE of the matrix at a point in time, not the pre-update state.
--
-- Previous trigger (migration 206) archived OLD on UPDATE — so after a
-- matrix edit, the "current" version in the archive contained the OLD
-- pre-edit values, not the new ones. Point-in-time replay broke because the
-- most-recent version_id for a matrix was 1 edit behind reality.
--
-- Corrected semantic: on every mutation, insert a row representing the NEW
-- state. Mark prior "current" (superseded_at IS NULL) as superseded. Future
-- project saves write their FK pointing at the latest version, which now
-- accurately equals what's in price_matrices.
--
-- Also: clean up the now-wrong archive rows from the earlier trigger.

BEGIN;

CREATE OR REPLACE FUNCTION archive_price_matrix_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_engine_version text := 'v2.0.0-shared';
BEGIN
  -- Skip no-ops — nothing pricing-relevant changed.
  IF TG_OP = 'UPDATE'
     AND NEW.default_tier IS NOT DISTINCT FROM OLD.default_tier
     AND NEW.use_default_pricing IS NOT DISTINCT FROM OLD.use_default_pricing
     AND NEW.package_pricing IS NOT DISTINCT FROM OLD.package_pricing
     AND NEW.product_pricing IS NOT DISTINCT FROM OLD.product_pricing
     AND NEW.blanket_discount IS NOT DISTINCT FROM OLD.blanket_discount
  THEN
    RETURN NEW;
  END IF;

  -- Supersede prior current version for this matrix.
  UPDATE price_matrix_versions
    SET superseded_at = now()
    WHERE matrix_id = NEW.id AND superseded_at IS NULL;

  -- Insert the NEW state as the current version.
  INSERT INTO price_matrix_versions (
    matrix_id, entity_type, entity_id, entity_name,
    project_type_id, project_type_name,
    default_tier, use_default_pricing,
    package_pricing, product_pricing, blanket_discount,
    engine_version, snapshot_reason, snapshot_at
  ) VALUES (
    NEW.id, NEW.entity_type, NEW.entity_id, NEW.entity_name,
    NEW.project_type_id, NEW.project_type_name,
    NEW.default_tier, NEW.use_default_pricing,
    COALESCE(NEW.package_pricing, '[]'::jsonb),
    COALESCE(NEW.product_pricing, '[]'::jsonb),
    NEW.blanket_discount,
    v_engine_version,
    CASE WHEN TG_OP = 'INSERT' THEN 'initial' ELSE 'matrix_edit' END,
    now()
  );

  RETURN NEW;
END;
$$;

-- ── Clean up the wrong-state versions created by migration 206's trigger ──
-- Any version with reason='matrix_edit' created today (before this fix) may
-- carry the OLD state. Simpler than diffing: delete every matrix_edit version
-- on matrices that still have their initial backfill row. For any matrix
-- that got actually-edited since backfill, a human can re-run the edit to
-- capture a fresh NEW-state version — or I can fix this by replacing the
-- current snapshots to match price_matrices row state directly.

-- Reset each matrix's version history to a single "reconciliation" row
-- reflecting the LIVE state in price_matrices right now. This wipes the
-- historical cruft from the buggy trigger but preserves the invariant
-- "latest version == live matrix state".
UPDATE price_matrix_versions SET superseded_at = now() WHERE superseded_at IS NULL;

INSERT INTO price_matrix_versions (
  matrix_id, entity_type, entity_id, entity_name,
  project_type_id, project_type_name,
  default_tier, use_default_pricing,
  package_pricing, product_pricing, blanket_discount,
  engine_version, snapshot_reason, snapshot_at
)
SELECT
  m.id, m.entity_type, m.entity_id, m.entity_name,
  m.project_type_id, m.project_type_name,
  m.default_tier, m.use_default_pricing,
  COALESCE(m.package_pricing, '[]'::jsonb),
  COALESCE(m.product_pricing, '[]'::jsonb),
  m.blanket_discount,
  'v2.0.0-shared', 'reconcile', now()
FROM price_matrices m;

-- ── Repoint projects that had FK to a since-superseded version ──
-- Any project whose current FK now points at a superseded row should
-- re-point to the current (reconcile) row of the same matrix.
UPDATE projects p
SET price_matrix_version_id = fresh.id
FROM price_matrix_versions old_v
JOIN price_matrix_versions fresh
  ON fresh.matrix_id = old_v.matrix_id AND fresh.superseded_at IS NULL
WHERE p.price_matrix_version_id = old_v.id
  AND old_v.superseded_at IS NOT NULL;

COMMIT;

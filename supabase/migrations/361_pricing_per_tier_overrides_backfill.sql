-- 361_pricing_per_tier_overrides_backfill.sql
-- Engine v3.0.0-shared rollout, part 2:
--   1. Bump archive_price_matrix_version trigger to stamp 'v3.0.0-shared' on
--      new snapshots.
--   2. Backfill `tier_overrides` onto every existing price_matrices row
--      (additive — legacy fields stay in place during the rollout window).
--   3. Force a snapshot per matrix so the latest price_matrix_versions row
--      reflects the new shape (preserves the "latest version == live matrix"
--      invariant from migration 207).
--
-- Math equivalence guarantee:
--   The backfill maps legacy semantic → new semantic byte-for-byte:
--     - override_enabled=true  →  both tiers { enabled:true, mode:'fixed' }
--                                 with base/unit/price copied from legacy fields
--     - override_enabled=false →  both tiers { enabled:false }
--   The resolver in supabase/functions/_shared/pricing/matrix.ts produces
--   identical numeric output for both shapes when modes are 'fixed'. Pricing
--   parity is preserved across the upgrade.
--
-- Old price_matrix_versions snapshots are NOT rewritten — they remain in
-- legacy shape. The dual-shape resolver handles them at replay time.

BEGIN;

-- ── 1. Bump trigger to stamp v3.0.0-shared ────────────────────────────────
-- Identical body to migration 207, only the engine_version string changes.
CREATE OR REPLACE FUNCTION archive_price_matrix_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_engine_version text := 'v3.0.0-shared';
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.default_tier IS NOT DISTINCT FROM OLD.default_tier
     AND NEW.use_default_pricing IS NOT DISTINCT FROM OLD.use_default_pricing
     AND NEW.package_pricing IS NOT DISTINCT FROM OLD.package_pricing
     AND NEW.product_pricing IS NOT DISTINCT FROM OLD.product_pricing
     AND NEW.blanket_discount IS NOT DISTINCT FROM OLD.blanket_discount
  THEN
    RETURN NEW;
  END IF;

  UPDATE price_matrix_versions
    SET superseded_at = now()
    WHERE matrix_id = NEW.id AND superseded_at IS NULL;

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

-- ── 2. Backfill helpers (one-shot, used by the UPDATE below) ──────────────

-- Convert one legacy product_pricing[] entry into the new tier_overrides shape
-- while preserving the legacy fields. Idempotent: if tier_overrides already
-- present, leave the row untouched.
CREATE OR REPLACE FUNCTION _backfill_product_pricing_row(p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_enabled  boolean;
  v_std_base numeric;
  v_std_unit numeric;
  v_prm_base numeric;
  v_prm_unit numeric;
  v_master_std_base numeric;
  v_master_std_unit numeric;
  v_master_prm_base numeric;
  v_master_prm_unit numeric;
  v_master_at        text;
  v_tier_overrides   jsonb;
BEGIN
  IF p_row IS NULL THEN RETURN p_row; END IF;
  IF p_row ? 'tier_overrides' THEN RETURN p_row; END IF;  -- already migrated

  v_enabled  := COALESCE((p_row->>'override_enabled')::boolean, false);
  v_std_base := COALESCE(NULLIF(p_row->>'standard_base','')::numeric, 0);
  v_std_unit := COALESCE(NULLIF(p_row->>'standard_unit','')::numeric, 0);
  v_prm_base := COALESCE(NULLIF(p_row->>'premium_base','')::numeric, 0);
  v_prm_unit := COALESCE(NULLIF(p_row->>'premium_unit','')::numeric, 0);
  v_master_std_base := NULLIF(p_row->>'master_standard_base','')::numeric;
  v_master_std_unit := NULLIF(p_row->>'master_standard_unit','')::numeric;
  v_master_prm_base := NULLIF(p_row->>'master_premium_base','')::numeric;
  v_master_prm_unit := NULLIF(p_row->>'master_premium_unit','')::numeric;
  v_master_at        := p_row->>'master_snapshot_at';

  v_tier_overrides := jsonb_build_object(
    'standard', jsonb_build_object(
      'enabled', v_enabled,
      'mode',    'fixed',
      'base',    v_std_base,
      'unit',    v_std_unit,
      'master_snapshot', jsonb_build_object(
        'base', v_master_std_base,
        'unit', v_master_std_unit,
        'snapshot_at', v_master_at
      )
    ),
    'premium', jsonb_build_object(
      'enabled', v_enabled,
      'mode',    'fixed',
      'base',    v_prm_base,
      'unit',    v_prm_unit,
      'master_snapshot', jsonb_build_object(
        'base', v_master_prm_base,
        'unit', v_master_prm_unit,
        'snapshot_at', v_master_at
      )
    )
  );

  RETURN p_row || jsonb_build_object('tier_overrides', v_tier_overrides);
END;
$$;

CREATE OR REPLACE FUNCTION _backfill_package_pricing_row(p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_enabled  boolean;
  v_std_price numeric;
  v_prm_price numeric;
  v_master_std_price numeric;
  v_master_prm_price numeric;
  v_master_at        text;
  v_tier_overrides   jsonb;
BEGIN
  IF p_row IS NULL THEN RETURN p_row; END IF;
  IF p_row ? 'tier_overrides' THEN RETURN p_row; END IF;

  v_enabled   := COALESCE((p_row->>'override_enabled')::boolean, false);
  v_std_price := COALESCE(NULLIF(p_row->>'standard_price','')::numeric, 0);
  v_prm_price := COALESCE(NULLIF(p_row->>'premium_price','')::numeric, 0);
  v_master_std_price := NULLIF(p_row->>'master_standard_price','')::numeric;
  v_master_prm_price := NULLIF(p_row->>'master_premium_price','')::numeric;
  v_master_at         := p_row->>'master_snapshot_at';

  v_tier_overrides := jsonb_build_object(
    'standard', jsonb_build_object(
      'enabled', v_enabled,
      'mode',    'fixed',
      'price',   v_std_price,
      'master_snapshot', jsonb_build_object(
        'price', v_master_std_price,
        'snapshot_at', v_master_at
      )
    ),
    'premium', jsonb_build_object(
      'enabled', v_enabled,
      'mode',    'fixed',
      'price',   v_prm_price,
      'master_snapshot', jsonb_build_object(
        'price', v_master_prm_price,
        'snapshot_at', v_master_at
      )
    )
  );

  RETURN p_row || jsonb_build_object('tier_overrides', v_tier_overrides);
END;
$$;

-- ── 3. Apply the backfill ────────────────────────────────────────────────
-- Map each row in product_pricing[]/package_pricing[] through the helper.
-- The UPDATE writes the new shape into the JSONB columns, which fires the
-- (now v3-stamped) archive trigger and produces a fresh snapshot.
UPDATE price_matrices m
SET
  product_pricing = COALESCE(
    (SELECT jsonb_agg(_backfill_product_pricing_row(elt))
     FROM jsonb_array_elements(COALESCE(m.product_pricing, '[]'::jsonb)) elt),
    '[]'::jsonb
  ),
  package_pricing = COALESCE(
    (SELECT jsonb_agg(_backfill_package_pricing_row(elt))
     FROM jsonb_array_elements(COALESCE(m.package_pricing, '[]'::jsonb)) elt),
    '[]'::jsonb
  ),
  last_modified_at = now()
WHERE EXISTS (
  -- Only touch rows that actually need it — avoid no-op updates that would
  -- still trigger the archive write.
  SELECT 1 FROM jsonb_array_elements(COALESCE(m.product_pricing, '[]'::jsonb)) elt
  WHERE NOT (elt ? 'tier_overrides')
)
OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(COALESCE(m.package_pricing, '[]'::jsonb)) elt
  WHERE NOT (elt ? 'tier_overrides')
);

-- ── 4. Drop the helpers (one-shot use only) ──────────────────────────────
DROP FUNCTION _backfill_product_pricing_row(jsonb);
DROP FUNCTION _backfill_package_pricing_row(jsonb);

COMMIT;

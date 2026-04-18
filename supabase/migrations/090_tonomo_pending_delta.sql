-- Migration 090: tonomo_pending_delta + per-line lock columns
--
-- Purpose: Fix the reliability issue where manually_overridden_fields
-- binary lock on products/packages causes Tonomo webhook deltas to be
-- silently dropped. Instead, handlers will stash the proposed change in
-- `tonomo_pending_delta` for UI review, and per-line locks allow
-- fine-grained protection without blocking entire product rebuilds.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tonomo_pending_delta JSONB,
  ADD COLUMN IF NOT EXISTS manually_locked_product_ids JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS manually_locked_package_ids JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_projects_tonomo_pending_delta
  ON projects ((tonomo_pending_delta IS NOT NULL));

COMMENT ON COLUMN projects.tonomo_pending_delta IS 'Proposed Tonomo product/package change that was detected but not applied (typically because manually_overridden_fields blocked it). UI surfaces this for user review. Cleared when user clicks "Apply" or manually edits.';
COMMENT ON COLUMN projects.manually_locked_product_ids IS 'JSON array of product_ids that the user has manually edited. Tonomo handlers will preserve these items even when rebuilding products from service tiers.';
COMMENT ON COLUMN projects.manually_locked_package_ids IS 'JSON array of package_ids that the user has manually edited. Tonomo handlers will preserve these items even when rebuilding packages from service tiers.';

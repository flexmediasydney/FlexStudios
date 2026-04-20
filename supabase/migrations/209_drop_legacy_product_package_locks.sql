-- 209_drop_legacy_product_package_locks.sql
-- Drop the two products/packages-specific lock columns on projects and clean
-- the stale products/packages entries out of manually_overridden_fields.
--
-- Background: between the Base44→Supabase migration and 2026-04-20, the
-- ProjectPricingTable save path wrote `manually_overridden_fields: ['products',
-- 'packages']` to signal manual edits, and the Tonomo reconciler would skip
-- those fields on next webhook. This backfired — at least 9 real projects
-- silently lost their packages (7 had packages wiped, 2 stashed add-only
-- diffs as "destructive"). On 2026-04-20 (commit bd1d609) the policy flipped
-- to "Tonomo is the authoritative source for products/packages" — the save
-- path stopped writing the lock flags and the reconciler became Tonomo-wins
-- unconditionally for those two fields (see
-- supabase/functions/processTonomoQueue/utils.ts::reconcileProductsPackagesAgainstLock).
--
-- After the commit, the _ids columns became dead code (17 rows still carry
-- 'products'/'packages' in manually_overridden_fields; 4 rows each carry
-- per-line _ids locks but nothing reads them any more).
--
-- This migration:
--   1. Drops manually_locked_product_ids (jsonb, ~4 rows with data, all dead)
--   2. Drops manually_locked_package_ids (jsonb, ~4 rows with data, all dead)
--   3. Cleans 'products' and 'packages' entries out of the
--      manually_overridden_fields text array on all 17 affected rows so the
--      runtime filterOverriddenFields() no longer no-op-filters products/
--      packages coming from Tonomo webhooks.
--
-- `manually_overridden_fields` column itself is KEPT. It's still a valid
-- generic mechanism for other fields (e.g. status in
-- runProjectAutomationRules/index.ts) even though nothing currently writes
-- anything except products/packages. Leaving the plumbing in place is cheaper
-- than re-introducing it later.
--
-- Irreversible once run. The data being stripped is purely advisory for an
-- already-deprecated code path.

BEGIN;

-- 1. Strip 'products' and 'packages' entries from manually_overridden_fields.
-- Field is stored as a JSON-string-encoded array (text column), e.g.
-- '["products","packages"]'. Parse, filter, re-serialize. Projects with
-- NULL or empty arrays are untouched.
UPDATE projects
SET manually_overridden_fields = (
  SELECT jsonb_agg(elem)::text
  FROM jsonb_array_elements_text(manually_overridden_fields::jsonb) AS elem
  WHERE elem NOT IN ('products', 'packages')
)
WHERE manually_overridden_fields IS NOT NULL
  AND manually_overridden_fields <> ''
  AND manually_overridden_fields <> '[]'
  AND (manually_overridden_fields ILIKE '%products%' OR manually_overridden_fields ILIKE '%packages%');

-- jsonb_agg returns NULL when the filtered set is empty — normalize to '[]'
-- so the text column has a stable shape downstream.
UPDATE projects
SET manually_overridden_fields = '[]'
WHERE manually_overridden_fields IS NULL
  AND manually_overridden_fields::text IS DISTINCT FROM '[]';

-- 2. Drop the per-line lock columns. Nothing reads them once we ship the
-- companion code change that removes the references in processTonomoQueue.
ALTER TABLE projects DROP COLUMN IF EXISTS manually_locked_product_ids;
ALTER TABLE projects DROP COLUMN IF EXISTS manually_locked_package_ids;

COMMIT;

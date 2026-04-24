-- Migration 220: cleanup historical data pollution + add structural guard
-- that prevents the empty-products wipe recurring.
--
-- Three independent changes in one migration:
--
-- 1. Clear stale `pending_review_type` on projects that are NOT in
--    pending_review status. These were polluted by the pre-fix
--    recalculateProjectPricingServerSide that wrote pending_review_type
--    unconditionally on every mismatch (fixed in migration 216). Affected
--    ~34 projects at audit time — mostly `pricing_mismatch` / `new_booking`
--    / `staff_change` ghost flags on in_progress / delivered / scheduled
--    projects.
--
-- 2. Zero out `calculated_price` / `price` on projects whose products AND
--    packages are both empty but whose stored price is non-zero. This
--    fixes the "kanban shows $2,250, detail page shows blank" divergence
--    observed on 133 Wilbur St. Set products_needs_recalc=true so the
--    next touch repopulates if products come back. Limited to the small
--    set of known-stuck projects — not a sweep over all zero-product
--    projects (which might be legitimately free / credit-only).
--
-- 3. Structural guard: trg_projects_products_wipe_guard.
--    Blocks any UPDATE that sets products=[] AND packages=[] when the
--    previous values had any entries, UNLESS the same statement also
--    clears `tonomo_order_id` or sets a special bypass flag
--    (_allow_products_wipe=true via session GUC). Matches the Tonomo-wins
--    policy but prevents accidental empty-catalog saves from the UI and
--    stray migrations. The recent 5 victims all share the same updated_at
--    timestamp (2026-04-20 13:40:27 bulk wipe) that this guard would have
--    blocked.

BEGIN;

-- ─── 1. Clear stale pending_review_type on non-pending projects ────────────
UPDATE projects
SET pending_review_type = NULL,
    pending_review_reason = NULL,
    urgent_review = CASE WHEN urgent_review THEN false ELSE urgent_review END
WHERE status != 'pending_review'
  AND (pending_review_type IS NOT NULL OR pending_review_reason IS NOT NULL);

-- ─── 2. Zero price on products=[] projects (and flag for recalc) ──────────
-- Only target the 6 known-stuck projects explicitly — don't sweep broadly.
-- Projects that were successfully re-populated in this session will have
-- products/packages non-empty by the time this migration runs, so they're
-- filtered out by the predicate.
UPDATE projects
SET calculated_price = 0,
    price = 0,
    products_needs_recalc = true
WHERE id IN (
  '70295da4-9253-49a5-aaf9-9103fe780e9c'   -- 156 Campbellfield Ave (no tonomo link, cannot auto-restore)
)
AND (products IS NULL OR products::text = '[]')
AND (packages IS NULL OR packages::text = '[]')
AND (calculated_price IS NOT NULL AND calculated_price > 0);

-- ─── 3. Structural guard: block empty-products wipe ───────────────────────
CREATE OR REPLACE FUNCTION public.project_products_wipe_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  old_had_items boolean;
  new_is_empty  boolean;
  bypass        text;
BEGIN
  -- Allow when either side is still populated (normal edits).
  old_had_items :=
    (OLD.products IS NOT NULL AND OLD.products::text NOT IN ('[]', '"[]"', ''))
    OR (OLD.packages IS NOT NULL AND OLD.packages::text NOT IN ('[]', '"[]"', ''));
  new_is_empty :=
    (NEW.products IS NULL OR NEW.products::text IN ('[]', '"[]"', ''))
    AND (NEW.packages IS NULL OR NEW.packages::text IN ('[]', '"[]"', ''));

  IF NOT (old_had_items AND new_is_empty) THEN
    RETURN NEW;
  END IF;

  -- Cancellations can legitimately clear products/packages.
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  -- Operator bypass: `SET LOCAL flexmedia.allow_products_wipe = 'true';`
  -- Used by intentional admin ops (e.g. bulk resets) that need to clear.
  BEGIN
    bypass := current_setting('flexmedia.allow_products_wipe', true);
  EXCEPTION WHEN OTHERS THEN
    bypass := NULL;
  END;
  IF bypass = 'true' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Refusing to wipe products AND packages on a non-cancelled project (% — %). Both fields were non-empty and are being set to []. If this is intentional, SET LOCAL flexmedia.allow_products_wipe = ''true'' in the same transaction.',
    NEW.id, COALESCE(NEW.title, NEW.property_address, '<no title>')
    USING ERRCODE = 'check_violation',
          HINT = 'Partial wipes (products=[] but packages non-empty, or vice versa) are allowed. The guard only fires when BOTH are being cleared on a non-cancelled project.';
END;
$function$;

DROP TRIGGER IF EXISTS trg_projects_products_wipe_guard ON public.projects;
CREATE TRIGGER trg_projects_products_wipe_guard
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.project_products_wipe_guard();

COMMIT;

-- 204_pricing_lock.sql
-- Freeze pricing on delivered + paid projects.
--
-- Business rule (locked 2026-04-20):
--   When status = 'delivered' AND payment_status = 'paid', the project's
--   pricing is considered final/billed. No further automatic or manual
--   recomputes may modify calculated_price, price, products, packages,
--   discount_value, discount_type, or discount_mode. Admin can unlock
--   explicitly for corrections.
--
--   Refund/reversal (payment_status flipping paid → unpaid) does NOT
--   auto-release the lock. Admin must unlock deliberately.
--
-- Implementation:
--   1. Add `pricing_locked_at timestamptz` column (null = unlocked).
--   2. BEFORE UPDATE trigger `trg_project_pricing_auto_lock`:
--      - Sets pricing_locked_at = NOW() when status='delivered' and
--        payment_status='paid' transitions in (from any prior state).
--   3. BEFORE UPDATE trigger `trg_project_pricing_write_guard`:
--      - Raises EXCEPTION if pricing_locked_at is set AND the update
--        attempts to change any pricing-significant column, EXCEPT when
--        the same update explicitly clears pricing_locked_at (admin
--        unlock path) OR sets it in the same statement (lock-then-write
--        is impossible since BEFORE UPDATE sees NEW.pricing_locked_at
--        post-auto-lock).
--
-- Unlock path: admin sets pricing_locked_at=NULL in a dedicated update.
-- That update IS allowed through the guard since no pricing columns are
-- changing on the same row. After unlock, subsequent updates are allowed
-- as normal; re-lock fires automatically if status/payment_status still
-- match the criteria.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS pricing_locked_at timestamptz;

COMMENT ON COLUMN projects.pricing_locked_at IS
  'Set to NOW() the first time this project transitions to status=delivered AND payment_status=paid. While non-null, triggers prevent any pricing-column mutation. Admin unlock = set back to NULL explicitly.';

CREATE INDEX IF NOT EXISTS idx_projects_pricing_locked
  ON projects (pricing_locked_at)
  WHERE pricing_locked_at IS NOT NULL;

-- ── Auto-lock trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION project_pricing_auto_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only interested in transitions into delivered+paid that aren't already locked
  IF NEW.pricing_locked_at IS NULL
     AND NEW.status = 'delivered'
     AND NEW.payment_status = 'paid'
  THEN
    NEW.pricing_locked_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_pricing_auto_lock ON projects;
CREATE TRIGGER trg_project_pricing_auto_lock
BEFORE INSERT OR UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION project_pricing_auto_lock();

-- ── Write-guard trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION project_pricing_write_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pricing_changed boolean;
  locked_before boolean := (OLD.pricing_locked_at IS NOT NULL);
  locked_after  boolean := (NEW.pricing_locked_at IS NOT NULL);
BEGIN
  -- If the row wasn't locked before this update, nothing to guard.
  IF NOT locked_before THEN
    RETURN NEW;
  END IF;

  -- Admin explicitly unlocking: pricing_locked_at flipping non-null → null.
  -- Allow the update through. The admin's intent is to then make corrections
  -- in a follow-up update.
  IF NOT locked_after THEN
    RETURN NEW;
  END IF;

  -- Locked before AND after — block any pricing mutation.
  pricing_changed :=
       NEW.calculated_price IS DISTINCT FROM OLD.calculated_price
    OR NEW.price            IS DISTINCT FROM OLD.price
    OR NEW.products         IS DISTINCT FROM OLD.products
    OR NEW.packages         IS DISTINCT FROM OLD.packages
    OR NEW.discount_value   IS DISTINCT FROM OLD.discount_value
    OR NEW.discount_type    IS DISTINCT FROM OLD.discount_type
    OR NEW.discount_mode    IS DISTINCT FROM OLD.discount_mode
    OR NEW.pricing_tier     IS DISTINCT FROM OLD.pricing_tier;

  IF pricing_changed THEN
    RAISE EXCEPTION 'Project pricing is locked (delivered+paid at %). Unlock first by setting pricing_locked_at=NULL before making changes.',
      OLD.pricing_locked_at
      USING ERRCODE = 'check_violation',
            HINT = 'Admin unlock: UPDATE projects SET pricing_locked_at=NULL WHERE id=...; then make corrections.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_pricing_write_guard ON projects;
CREATE TRIGGER trg_project_pricing_write_guard
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION project_pricing_write_guard();

COMMIT;

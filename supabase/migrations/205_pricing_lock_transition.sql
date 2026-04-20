-- 205_pricing_lock_transition.sql
-- Fix: auto-lock should only fire on the TRANSITION into delivered+paid,
-- not on every update while in that state. Without this, admin unlock
-- (SET pricing_locked_at=NULL) gets immediately re-locked because the
-- BEFORE UPDATE trigger runs on that same statement, sees the project
-- is still delivered+paid, and sets pricing_locked_at=now() again.
--
-- Intent preserved by migration 204:
--   - New rows inserted already delivered+paid → lock
--   - Status transitions delivered→unpaid→paid etc. → lock on hitting paid
--   - Payment transitions unpaid→paid while delivered → lock
-- Intent NEW here:
--   - Admin manually clearing pricing_locked_at while status/payment
--     remain unchanged → stays cleared until next transition

BEGIN;

CREATE OR REPLACE FUNCTION project_pricing_auto_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- True when the combination (status='delivered', payment_status='paid')
  -- is NEWLY reached by this write (INSERT, or either column flipped into
  -- a qualifying value on UPDATE).
  transitioning_into_locked boolean;
BEGIN
  -- Not interested unless the target state is delivered+paid.
  IF NEW.status <> 'delivered' OR NEW.payment_status <> 'paid' THEN
    RETURN NEW;
  END IF;

  -- Already locked (and admin didn't unlock this same statement) → no change.
  IF NEW.pricing_locked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    transitioning_into_locked := true;
  ELSE
    -- A transition fires when EITHER status or payment_status was not
    -- already qualifying. If both were already qualifying and admin is
    -- merely clearing pricing_locked_at, this resolves false → do nothing.
    transitioning_into_locked :=
        (OLD.status IS DISTINCT FROM 'delivered')
     OR (OLD.payment_status IS DISTINCT FROM 'paid');
  END IF;

  IF transitioning_into_locked THEN
    NEW.pricing_locked_at := now();
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;

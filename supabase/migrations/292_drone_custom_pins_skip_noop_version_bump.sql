-- ════════════════════════════════════════════════════════════════════════
-- Migration 292 — Wave 5 P3 (QC2-6 #5): drone_custom_pins trigger no-op detection
--
-- BUG: The active BEFORE UPDATE trigger on drone_custom_pins
-- (`trg_drone_custom_pins_touch` → `drone_custom_pins_touch_updated_at()`)
-- bumped `version` and `updated_at` on EVERY UPDATE — including no-op
-- PATCHes where the post-image equals the pre-image. Optimistic-concurrency
-- writers reading version=N then PUTting back the same body would receive a
-- silent version=N+1 on the row, and their next conditional write
-- (`WHERE version=N`) would 409 even though no human-meaningful change
-- happened. False conflict storm in the Pin Editor when two operators race
-- with identical edits / when an autosave fires twice with identical payload.
--
-- HISTORICAL CONTEXT: mig 268 originally created `drone_custom_pins_bump_version`,
-- but a later out-of-band write (Wave 4 hotfix, applied via execute_sql, not
-- migration file) replaced the active trigger with `_touch_updated_at` while
-- leaving the old function lying around. We update both functions for safety
-- (whichever is wired to the trigger now or in future will pick up the fix).
--
-- FIX: short-circuit when row_to_jsonb(NEW) IS NOT DISTINCT FROM
-- row_to_jsonb(OLD) — same idiom mig 288 added for drone_property_boundary.
-- Use jsonb (json has no equality operator) and IS NOT DISTINCT FROM for
-- NULL safety.
--
-- Verify:
--   SELECT version FROM drone_custom_pins WHERE id = '<uuid>';  -- record
--   UPDATE drone_custom_pins SET pin_type = pin_type WHERE id = '<uuid>';
--   SELECT version FROM drone_custom_pins WHERE id = '<uuid>';  -- unchanged
-- ════════════════════════════════════════════════════════════════════════

-- Active trigger function (currently wired to trg_drone_custom_pins_touch).
-- NOTE on jsonb syntax: `row_to_jsonb(NEW)` errors with "function does not
-- exist" because PL/pgSQL passes record types (`OLD`/`NEW`) and the SQL
-- function signature is `row_to_json(record)`. Use `to_jsonb(NEW.*)` (or
-- equivalently `row_to_json(NEW.*)::jsonb`) — same idiom as mig 288.
CREATE OR REPLACE FUNCTION drone_custom_pins_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- No-op detection: a UPDATE whose post-image is identical to the pre-image
  -- (same column values, same nullability) returns OLD unchanged. This skips
  -- the version bump AND any AFTER UPDATE triggers Postgres would otherwise
  -- fire on a touched row.
  IF TG_OP = 'UPDATE'
     AND row_to_json(NEW.*)::jsonb IS NOT DISTINCT FROM row_to_json(OLD.*)::jsonb THEN
    RETURN OLD;
  END IF;
  NEW.updated_at := NOW();
  IF TG_OP = 'UPDATE' THEN
    NEW.version := COALESCE(OLD.version, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Legacy alias (mig 268 created this; out-of-band hotfix swapped the wired
-- function later). Keep both in lock-step so a future re-wire picks up the
-- same semantics.
CREATE OR REPLACE FUNCTION drone_custom_pins_bump_version()
RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND row_to_json(NEW.*)::jsonb IS NOT DISTINCT FROM row_to_json(OLD.*)::jsonb THEN
    RETURN OLD;
  END IF;
  NEW.version    := COALESCE(OLD.version, 0) + 1;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

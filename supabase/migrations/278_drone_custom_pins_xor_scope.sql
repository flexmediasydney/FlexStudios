-- 278_drone_custom_pins_xor_scope
-- ────────────────────────────────────────────────────────────────────────
-- Wave 5 P1 / QC2-6 #3 + QC2-6 #4
--
-- Two integrity holes on drone_custom_pins:
--
--   #3: The existing CHECK on scope is permissive OR
--       (shoot_id IS NOT NULL OR project_id IS NOT NULL)
--       which lets BOTH be set simultaneously. 6 production rows
--       currently violate the intended XOR — when the user pins something
--       to a shoot the UI also stamps project_id, so cascade-delete of the
--       shoot makes the pin disappear even though the user thinks it is
--       project-scoped (and vice versa). Tighten to true XOR.
--
--   #4: Project-scoped pins must be world-anchored — there is no shoot
--       to attach pixel coords to. Add a second CHECK to enforce that
--       (project_id IS NOT NULL → world_lat/lng must both be set).
--
-- Cleanup decision for the 6 dirty rows:
--   All 6 have NULL world_lat/lng (so they are pixel-anchored to a shot).
--   Pixel-anchored pins MUST live on a shoot, never on a project. So the
--   only safe correction is to KEEP shoot_id and NULL project_id. After
--   cleanup, all 6 rows are pure shoot-scoped which matches user intent.

-- Step 1: Inspect (idempotent — for audit log)
DO $$
DECLARE
  v_dirty_count int;
BEGIN
  SELECT count(*) INTO v_dirty_count
  FROM drone_custom_pins
  WHERE shoot_id IS NOT NULL AND project_id IS NOT NULL;
  RAISE NOTICE '[mig 278] drone_custom_pins rows with both shoot_id and project_id: %', v_dirty_count;
END $$;

-- Step 2: Cleanup — keep shoot_id, null project_id (more specific anchor wins)
UPDATE drone_custom_pins
   SET project_id = NULL
 WHERE shoot_id IS NOT NULL
   AND project_id IS NOT NULL;

-- Step 3: Drop the old permissive scope check
ALTER TABLE drone_custom_pins
  DROP CONSTRAINT IF EXISTS drone_custom_pins_scope_check;

-- Step 4: Add true XOR scope check
ALTER TABLE drone_custom_pins
  ADD CONSTRAINT drone_custom_pins_scope_check
  CHECK (
    ((shoot_id IS NOT NULL)::int + (project_id IS NOT NULL)::int) = 1
  );

-- Step 5: Add project-scoped → world-anchored check
ALTER TABLE drone_custom_pins
  DROP CONSTRAINT IF EXISTS drone_custom_pins_project_world_anchor_check;

ALTER TABLE drone_custom_pins
  ADD CONSTRAINT drone_custom_pins_project_world_anchor_check
  CHECK (
    project_id IS NULL
    OR (world_lat IS NOT NULL AND world_lng IS NOT NULL)
  );

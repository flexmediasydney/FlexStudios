-- ═══════════════════════════════════════════════════════════════════════════
-- drone_shots: add 'building_hero' to shot_role CHECK
-- ───────────────────────────────────────────────────────────────────────────
-- The classifier in supabase/functions/_shared/droneIngest.ts now emits
-- 'building_hero' for shots flown at human-scale altitudes (5-30m) with the
-- gimbal roughly horizontal — façade hero shots that previously fell into
-- 'unclassified' and confused operators in the swimlane.
--
-- Also re-classifies any existing rows that match the new building_hero
-- criteria (alt 5-30m AND pitch -25..0°) so historical shoots benefit from
-- the new label without an operator re-ingest. nadir_grid / orbital /
-- oblique_hero are checked first so the more-specific labels stick.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_shots
  DROP CONSTRAINT IF EXISTS drone_shots_shot_role_check;

ALTER TABLE drone_shots
  ADD CONSTRAINT drone_shots_shot_role_check
  CHECK (shot_role = ANY (ARRAY[
    'nadir_grid'::text,
    'orbital'::text,
    'oblique_hero'::text,
    'building_hero'::text,
    'ground_level'::text,
    'unclassified'::text
  ]));

-- Re-classify ONLY rows currently labelled 'unclassified' — don't disturb
-- existing nadir/orbital/oblique_hero/ground_level rows even if they happen
-- to also satisfy building_hero's predicate (the more-specific label that
-- was already assigned at ingest time wins).
UPDATE drone_shots
SET shot_role = 'building_hero'
WHERE shot_role = 'unclassified'
  AND relative_altitude IS NOT NULL
  AND gimbal_pitch IS NOT NULL
  AND relative_altitude >= 5
  AND relative_altitude <= 30
  AND gimbal_pitch >= -25
  AND gimbal_pitch <= 0;

NOTIFY pgrst, 'reload schema';

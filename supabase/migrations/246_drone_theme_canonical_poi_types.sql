-- 246_drone_theme_canonical_poi_types
-- ────────────────────────────────────────────────────────────────────────
-- The seeded system theme (flexmedia_default) had non-canonical POI type
-- labels in poi_selection.type_quotas: 'shopping' (should be 'shopping_mall')
-- and 'train' (should be 'train_station'). Until now those keys were
-- decorative — drone-pois used hardcoded POI types — but with the type-quotas
-- wiring landing in 245+drone-pois, the keys must match Google Places enum
-- values exactly or they're dropped on the floor with a console.warn.
--
-- Rewrite the system theme's type_quotas to canonical Google Places types,
-- in the priority order operators want by default:
--   1. school          (max 2)
--   2. train_station   (max 2)
--   3. hospital        (max 1)
--   4. shopping_mall   (max 1)
--   5. park            (max 1)
--   6. beach           (max 1)
--
-- Operators de-select what's not relevant via the ThemeEditor. Per-type max
-- + priority controls which types fill the global max_pins_per_shot budget
-- when there are too many candidates.
--
-- Implementation note: the live system theme in production was missing the
-- poi_selection key entirely (different seed snapshot than the source JSON
-- file), so we COALESCE-then-merge to scaffold poi_selection if absent. The
-- jsonb_set's `create_missing => true` flag also handles the absent path.

UPDATE drone_themes
SET config = jsonb_set(
  COALESCE(config, '{}'::jsonb),
  '{poi_selection}',
  COALESCE(config->'poi_selection', '{}'::jsonb) || jsonb_build_object(
    'type_quotas', jsonb_build_object(
      'school',          jsonb_build_object('priority', 1, 'max', 2),
      'train_station',   jsonb_build_object('priority', 2, 'max', 2),
      'hospital',        jsonb_build_object('priority', 3, 'max', 1),
      'shopping_mall',   jsonb_build_object('priority', 4, 'max', 1),
      'park',            jsonb_build_object('priority', 5, 'max', 1),
      'beach',           jsonb_build_object('priority', 6, 'max', 1)
    )
  ),
  true
)
WHERE owner_kind = 'system' AND is_default = true;

NOTIFY pgrst, 'reload schema';

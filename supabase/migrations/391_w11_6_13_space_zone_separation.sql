-- Wave 11.6.13 — Space / Zone separation in image classification.
--
-- Joseph noticed Stage 4's correction `dining_room → living_dining_combined`
-- on IMG_034A7916 — both technically valid because the schema's `room_type`
-- field conflates two orthogonal concepts:
--
--   SPACE      (the architectural enclosure / 4 walls):
--              studio, master_bedroom, living_dining_combined, kitchen_dining_living
--   ZONE_FOCUS (the compositional subject of the shot):
--              dining_table, kitchen_island, lounge_seating, bed_focal, vanity_detail
--
-- In studios + open-plan apartments ONE space contains MANY zones. The current
-- schema can't distinguish "shot of the dining zone IN a combined living/dining
-- space" from "shot of a dedicated dining_room space". This blocks accurate
-- slot eligibility and clean training data.
--
-- This wave is ADDITIVE: we add three new columns
--   space_type        TEXT   — the architectural enclosure
--   zone_focus        TEXT   — the compositional subject of the shot
--   space_zone_count  INT    — 1 = single-purpose, 2-4 = multi-zone open plan, 5+ = studio
--
-- We keep `room_type` as a compatibility alias. A future cleanup wave will
-- deprecate `room_type` once consumers have migrated.
--
-- Slot definitions get matching arrays:
--   eligible_space_types     TEXT[]  — DEFAULT '{}'
--   eligible_zone_focuses    TEXT[]  — DEFAULT '{}'
-- The slot eligibility resolver applies AND-intersection when both are set;
-- when only `eligible_space_types[]` is set, fall back to space-only matching;
-- when neither is set, fall back to legacy `eligible_room_types`.
--
-- Backfill: populate `eligible_space_types` and `eligible_zone_focuses` for
-- the seeded slot rows where the meaning is unambiguous (e.g. entry_hero →
-- entry_foyer + door_threshold/full_facade).
--
-- ─── Forward ────────────────────────────────────────────────────────────────

-- 1. composition_classifications: three new columns.
ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS space_type       TEXT,
  ADD COLUMN IF NOT EXISTS zone_focus       TEXT,
  ADD COLUMN IF NOT EXISTS space_zone_count INTEGER;

COMMENT ON COLUMN composition_classifications.space_type IS
  'W11.6.13: architectural enclosure (the 4 walls). Canonical SPACE taxonomy: master_bedroom | bedroom_secondary | bedroom_third | living_dining_combined | living_room_dedicated | dining_room_dedicated | kitchen_dining_living_combined | kitchen_dedicated | studio_open_plan | bathroom | ensuite | powder_room | entry_foyer | hallway | study | media_room | rumpus | laundry | mudroom | garage | alfresco_undercover | alfresco_open | balcony | terrace | exterior_facade | exterior_rear | exterior_side | pool_area | garden | streetscape | aerial_oblique | aerial_nadir.';
COMMENT ON COLUMN composition_classifications.zone_focus IS
  'W11.6.13: compositional SUBJECT of the shot. Canonical ZONE taxonomy: bed_focal | wardrobe_built_in | dining_table | kitchen_island | kitchen_appliance_wall | kitchen_pantry | lounge_seating | fireplace_focal | study_desk | tv_media_wall | bath_focal | shower_focal | vanity_detail | toilet_visible | window_view | door_threshold | stair_focal | feature_wall | ceiling_detail | floor_detail | material_proof | landscape_overview | full_facade | pool_focal | outdoor_dining | outdoor_kitchen | bbq_zone | drying_zone | parking_zone.';
COMMENT ON COLUMN composition_classifications.space_zone_count IS
  'W11.6.13: 1 = single-purpose enclosed room (dedicated bedroom/bathroom). 2-4 = multi-zone open plan (living/dining=2, kitchen+dining+living=3). 5+ = studio-style (kitchen + bed + lounge + bathroom in one envelope).';

CREATE INDEX IF NOT EXISTS idx_classif_space_type
  ON composition_classifications (space_type);
CREATE INDEX IF NOT EXISTS idx_classif_zone_focus
  ON composition_classifications (zone_focus);

-- 2. shortlisting_slot_definitions: matching eligibility arrays. Both default
--    to empty so existing rows continue to use the legacy `eligible_room_types`
--    fallback path (W7.7 + W7.8) until an admin populates them.
ALTER TABLE shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS eligible_space_types  TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS eligible_zone_focuses TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN shortlisting_slot_definitions.eligible_space_types IS
  'W11.6.13: array of space_type values this slot is eligible for. Resolver applies AND-intersection with eligible_zone_focuses[] when both populated; falls back to space-only matching when only this column is set; falls back to legacy eligible_room_types when both new arrays are empty.';
COMMENT ON COLUMN shortlisting_slot_definitions.eligible_zone_focuses IS
  'W11.6.13: array of zone_focus values this slot is eligible for. See eligible_space_types comment for resolver semantics.';

-- GIN indexes for the array-overlap lookups the resolver runs every Pass 2.
CREATE INDEX IF NOT EXISTS idx_slot_defs_eligible_space_types_gin
  ON shortlisting_slot_definitions USING GIN (eligible_space_types)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_slot_defs_eligible_zone_focuses_gin
  ON shortlisting_slot_definitions USING GIN (eligible_zone_focuses)
  WHERE is_active = true;

-- 3. Backfill the active slot rows where the semantic mapping is unambiguous.
--    This deliberately stays narrow — admins can populate the long tail via
--    the SettingsShortlistingSlots admin page (which now has multiselects
--    for both columns). Rows we don't touch keep their default '{}' and fall
--    back to the legacy `eligible_room_types` matching path.
--
--    Mapping rules (slot_id LIKE pattern → arrays):
--      entry_hero / entry_*               → space=[entry_foyer]; zone=[door_threshold, full_facade]
--      kitchen_hero / kitchen_*           → space=[kitchen_dining_living_combined,kitchen_dedicated];
--                                            zone=[kitchen_island, kitchen_appliance_wall]
--      master_bedroom*                    → space=[master_bedroom]; zone=[bed_focal]
--      bedroom_*  (excluding master)      → space=[bedroom_secondary,bedroom_third]; zone=[bed_focal]
--      bathroom*                          → space=[bathroom]; zone=[shower_focal,bath_focal,vanity_detail]
--      ensuite_*                          → space=[ensuite]; zone=[shower_focal,bath_focal,vanity_detail]
--      living_*                           → space=[living_room_dedicated,living_dining_combined];
--                                            zone=[lounge_seating]
--      dining_*                           → space=[dining_room_dedicated,living_dining_combined];
--                                            zone=[dining_table]
--      alfresco* / outdoor*               → space=[alfresco_undercover,alfresco_open];
--                                            zone=[outdoor_dining,outdoor_kitchen]
--      pool*                              → space=[pool_area]; zone=[pool_focal]
--      exterior_front* / exterior_facade* → space=[exterior_facade]; zone=[full_facade]
--      exterior_rear*                     → space=[exterior_rear]; zone=[full_facade]
UPDATE shortlisting_slot_definitions
SET
  eligible_space_types = CASE
    WHEN slot_id LIKE 'entry_%'                THEN ARRAY['entry_foyer']::text[]
    WHEN slot_id LIKE 'kitchen_%'              THEN ARRAY['kitchen_dining_living_combined','kitchen_dedicated']::text[]
    WHEN slot_id LIKE 'master_bedroom%'        THEN ARRAY['master_bedroom']::text[]
    WHEN slot_id LIKE 'bedroom_%'              THEN ARRAY['bedroom_secondary','bedroom_third']::text[]
    WHEN slot_id LIKE 'ensuite_%'              THEN ARRAY['ensuite']::text[]
    WHEN slot_id LIKE 'bathroom%'              THEN ARRAY['bathroom']::text[]
    WHEN slot_id LIKE 'powder_%'               THEN ARRAY['powder_room']::text[]
    WHEN slot_id LIKE 'living_%'               THEN ARRAY['living_room_dedicated','living_dining_combined']::text[]
    WHEN slot_id LIKE 'dining_%'               THEN ARRAY['dining_room_dedicated','living_dining_combined']::text[]
    WHEN slot_id LIKE 'alfresco%'
      OR slot_id LIKE 'outdoor%'               THEN ARRAY['alfresco_undercover','alfresco_open']::text[]
    WHEN slot_id LIKE 'pool%'                  THEN ARRAY['pool_area']::text[]
    WHEN slot_id LIKE 'exterior_front%'
      OR slot_id LIKE 'exterior_facade%'       THEN ARRAY['exterior_facade']::text[]
    WHEN slot_id LIKE 'exterior_rear%'         THEN ARRAY['exterior_rear']::text[]
    WHEN slot_id LIKE 'exterior_side%'         THEN ARRAY['exterior_side']::text[]
    WHEN slot_id LIKE 'study_%'                THEN ARRAY['study']::text[]
    WHEN slot_id LIKE 'laundry%'               THEN ARRAY['laundry']::text[]
    WHEN slot_id LIKE 'garage%'                THEN ARRAY['garage']::text[]
    WHEN slot_id LIKE 'media_%'                THEN ARRAY['media_room']::text[]
    WHEN slot_id LIKE 'staircase%'             THEN ARRAY['hallway']::text[]
    WHEN slot_id LIKE 'hallway%'               THEN ARRAY['hallway']::text[]
    ELSE eligible_space_types
  END,
  eligible_zone_focuses = CASE
    WHEN slot_id LIKE 'entry_hero%'            THEN ARRAY['door_threshold','full_facade']::text[]
    WHEN slot_id LIKE 'entry_%'                THEN ARRAY['door_threshold']::text[]
    WHEN slot_id LIKE 'kitchen_%'              THEN ARRAY['kitchen_island','kitchen_appliance_wall']::text[]
    WHEN slot_id LIKE 'master_bedroom%'        THEN ARRAY['bed_focal']::text[]
    WHEN slot_id LIKE 'bedroom_%'              THEN ARRAY['bed_focal']::text[]
    WHEN slot_id LIKE 'ensuite_%'              THEN ARRAY['shower_focal','bath_focal','vanity_detail']::text[]
    WHEN slot_id LIKE 'bathroom%'              THEN ARRAY['shower_focal','bath_focal','vanity_detail']::text[]
    WHEN slot_id LIKE 'powder_%'               THEN ARRAY['vanity_detail','toilet_visible']::text[]
    WHEN slot_id LIKE 'living_%'               THEN ARRAY['lounge_seating','fireplace_focal','tv_media_wall']::text[]
    WHEN slot_id LIKE 'dining_%'               THEN ARRAY['dining_table']::text[]
    WHEN slot_id LIKE 'alfresco%'
      OR slot_id LIKE 'outdoor%'               THEN ARRAY['outdoor_dining','outdoor_kitchen','bbq_zone']::text[]
    WHEN slot_id LIKE 'pool%'                  THEN ARRAY['pool_focal']::text[]
    WHEN slot_id LIKE 'exterior_front%'
      OR slot_id LIKE 'exterior_facade%'       THEN ARRAY['full_facade']::text[]
    WHEN slot_id LIKE 'exterior_rear%'         THEN ARRAY['full_facade']::text[]
    WHEN slot_id LIKE 'study_%'                THEN ARRAY['study_desk']::text[]
    ELSE eligible_zone_focuses
  END
WHERE is_active = true
  AND (eligible_space_types = '{}'::text[] OR eligible_zone_focuses = '{}'::text[]);

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (run MANUALLY if this migration breaks production) ────────────
--
-- DROP INDEX IF EXISTS idx_slot_defs_eligible_zone_focuses_gin;
-- DROP INDEX IF EXISTS idx_slot_defs_eligible_space_types_gin;
-- DROP INDEX IF EXISTS idx_classif_zone_focus;
-- DROP INDEX IF EXISTS idx_classif_space_type;
-- ALTER TABLE shortlisting_slot_definitions
--   DROP COLUMN IF EXISTS eligible_zone_focuses,
--   DROP COLUMN IF EXISTS eligible_space_types;
-- ALTER TABLE composition_classifications
--   DROP COLUMN IF EXISTS space_zone_count,
--   DROP COLUMN IF EXISTS zone_focus,
--   DROP COLUMN IF EXISTS space_type;
-- NOTIFY pgrst, 'reload schema';

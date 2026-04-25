-- ═══════════════════════════════════════════════════════════════════════════
-- Drone theme: master toggles + default distance-on
-- ───────────────────────────────────────────────────────────────────────────
-- Three updates to the seeded `system` drone_themes row (and any forks):
--
--   1. poi_label.enabled = true   (master toggle for POI overlay)
--   2. property_pin.enabled = true (master toggle for property pin)
--   3. poi_label.secondary_text.enabled = true
--      poi_label.show_distance_as_secondary = true
--      → distance under each POI ("850m" or "1.5km") shown by default
--
-- All three keys default to TRUE so existing renders keep behaving as they
-- always did (POIs visible, pin visible). Operators who want a clean
-- POI-free or pin-free render now have a switch.
--
-- The renderer (modal/drone_render/render_engine.py) was updated alongside
-- this migration to honour the two .enabled toggles. Without engine support,
-- toggling them has no effect; the migration is the contract.
-- ═══════════════════════════════════════════════════════════════════════════

-- Apply to the system theme (and any other theme rows that don't already
-- have these keys set). jsonb_set inserts the key when missing; it's a
-- no-op when the key already exists with the same value.
UPDATE drone_themes
SET config = config
  || jsonb_build_object(
       'poi_label',
       COALESCE(config->'poi_label', '{}'::jsonb)
       || jsonb_build_object('enabled', true)
       || jsonb_build_object(
            'secondary_text',
            COALESCE(config->'poi_label'->'secondary_text', '{}'::jsonb)
            || jsonb_build_object('enabled', true)
          )
       || jsonb_build_object('show_distance_as_secondary', true)
     )
  || jsonb_build_object(
       'property_pin',
       COALESCE(config->'property_pin', '{}'::jsonb)
       || jsonb_build_object('enabled', true)
     )
WHERE owner_kind = 'system'
  AND status = 'active'
  AND is_default = true;

NOTIFY pgrst, 'reload schema';

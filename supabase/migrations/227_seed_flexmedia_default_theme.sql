-- Migration 227: Seed the FlexMedia Default drone theme
--
-- Inserts ONE row into drone_themes (Stream B's table from migration 225)
-- representing the system-level default that every project falls back to
-- when no person- or org-level override exists.
--
-- Source of truth for the config blob: ~/flexmedia-drone-spike/production_ready/
-- theme_swatches.py — first entry of the THEMES list ("FlexMedia Default":
-- vertical line + house-icon style). Stream D will eventually replace this
-- with the productionised version; today this unblocks getDroneTheme testing
-- by giving the resolver a real system row to merge from.
--
-- Idempotent: guarded by a NOT EXISTS predicate. The schema's UNIQUE
-- constraint on (owner_kind, owner_id, name) treats NULLs as always-distinct
-- (Postgres default NULLs-distinct behaviour) so ON CONFLICT alone won't
-- catch system-owned re-runs. We check by name + owner_kind explicitly.
--
-- Note: drone_themes.owner_kind='system' requires owner_id IS NULL per the
-- check constraint added in migration 225.

INSERT INTO drone_themes (
  name,
  owner_kind,
  owner_id,
  config,
  is_default,
  status,
  version,
  created_by
)
SELECT
  'FlexMedia Default',
  'system',
  NULL,
  jsonb_build_object(
    'theme_name', 'FlexMedia Default',
    'version', '1.0',
    'anchor_line', jsonb_build_object(
      'shape', 'thin',
      'width_px', 3,
      'color', '#FFFFFF',
      'end_marker', jsonb_build_object(
        'shape', 'dot',
        'size_px', 14,
        'fill_color', '#FFFFFF'
      )
    ),
    'poi_label', jsonb_build_object(
      'fill', '#FFFFFF',
      'text_color', '#000000',
      'font_size_px', 36,
      'text_case', 'uppercase',
      'padding_px', jsonb_build_object(
        'top', 12,
        'right', 24,
        'bottom', 12,
        'left', 24
      )
    ),
    'property_pin', jsonb_build_object(
      'mode', 'line_up_with_house_icon',
      'size_px', 120,
      'fill_color', '#FFFFFF',
      'stroke_color', '#000000',
      'stroke_width_px', 3,
      'content', jsonb_build_object(
        'icon_color', '#000000'
      )
    )
  ),
  TRUE,
  'active',
  1,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM drone_themes
  WHERE owner_kind = 'system'
    AND owner_id IS NULL
    AND name = 'FlexMedia Default'
);

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────
-- Mig 451 — Decompose composition_type into vantage_position +
--           composition_geometry; drop room_type + composition_type from
--           gallery_positions constraint axes.
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-W11.7.x / Mig 451
-- Author: Joseph Saad (designed) / Stage-3 agent (executed)
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────
--
-- The legacy `composition_type` axis (5 values: corner_two_point /
-- straight_on / hero_wide / threshold_transition / corridor_leading) was
-- taxonomically muddled — it conflated three orthogonal concerns:
--
--    * VANTAGE — where the camera is positioned (corner / square-on /
--      through-doorway / down-corridor / aerial / low / high)
--    * GEOMETRY — what the frame's geometric statement is (1-point / 2-point /
--      leading lines / symmetrical / etc.)
--    * SHOT-SCALE — how much of the scene is framed (already captured by
--      shot_scale = wide | medium | tight | detail | vignette per mig 442)
--
-- Decomposition map:
--
--    Old composition_type     | New decomposition
--    ─────────────────────────|──────────────────────────────────────────
--    corner_two_point         | vantage=corner          + geometry=two_point_perspective
--    straight_on              | vantage=square_to_wall  + geometry=null (or one_point)
--    hero_wide                | RETIRED (duplicates shot_scale=wide)
--    threshold_transition     | vantage=through_doorway + geometry=null
--    corridor_leading         | vantage=down_corridor   + geometry=leading_lines
--
-- Plus: `room_type` is being dropped as a CONSTRAINT AXIS on
-- `gallery_positions` because it's redundant with the W11.6.13 decomposition
-- into `space_type` + `zone_focus`. The column STAYS on
-- `composition_classifications` for backwards compat with old rows.
--
-- ─── CANONICAL VOCABULARIES (description-taught, NO closed enum) ─────────
--
-- Same discipline as space_type / zone_focus (commit 9325f46) — closed enums
-- combined with the rest of the v2 schema tip Gemini's state-count limit.
-- The canonical lists are taught via property `description` at the schema
-- level; persistence-layer normalisation handles drift.
--
-- vantage_position (where is the camera relative to the scene?):
--   eye_level         — standard eye-height frontal shot (the default; NULL
--                       usually means this)
--   corner            — shot from a corner of the room (typically yields
--                       2-point perspective)
--   square_to_wall    — frontal, square-on to a wall or feature (often
--                       1-point perspective)
--   through_doorway   — shot framed through a doorway / transition into a
--                       deeper space
--   down_corridor     — shot taken along the long axis of a corridor /
--                       hallway / open-plan
--   aerial_overhead   — top-down view (drone nadir, ceiling-down architectural)
--   aerial_oblique    — angled aerial view (drone oblique)
--   low_angle         — camera below eye-level (looking up; emphasises
--                       ceiling/sky)
--   high_angle        — camera above eye-level (looking down; mezzanine,
--                       stair landing)
--
-- composition_geometry (what's the geometric statement of the frame?):
--   one_point_perspective   — single vanishing point (square-on shots)
--   two_point_perspective   — two vanishing points (corner shots)
--   three_point_perspective — three vanishing points (looking dramatically up/down)
--   leading_lines           — strong directional lines drawing eye through frame
--   symmetrical             — frame organised along an axis of symmetry
--   centered                — primary subject in the centre of frame
--   rule_of_thirds          — primary subject on a thirds intersection
--   asymmetric_balance      — off-centre but visually balanced
--
-- NULL on either axis = "any value acceptable" / "no specific geometric
-- statement intended".
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
-- If this migration needs to be reverted:
--
--   1. ALTER TABLE composition_classifications
--        DROP COLUMN vantage_position,
--        DROP COLUMN composition_geometry;
--   2. ALTER TABLE gallery_positions
--        DROP COLUMN vantage_position,
--        DROP COLUMN composition_geometry,
--        ADD COLUMN room_type TEXT,
--        ADD COLUMN composition_type TEXT;
--      (The 6 existing gallery_positions rows with the Silver Standard recipe
--      will lose their room_type/composition_type values — you'd need to
--      reseed from the engine rebuild fixture if you really need them back.)
--   3. NOTIFY pgrst, 'reload schema';
--
-- The 5 backfill writes on composition_classifications are non-destructive
-- (only fill NULLs), so rollback doesn't need to worry about restoring those.
--
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK A — Add columns to BOTH composition_classifications + gallery_positions
-- ═════════════════════════════════════════════════════════════════════════

-- composition_classifications: Stage 1 emits both axes per row.
ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS vantage_position     TEXT,
  ADD COLUMN IF NOT EXISTS composition_geometry TEXT;

-- gallery_positions: recipe constraint axes mirror Stage 1 columns.
ALTER TABLE gallery_positions
  ADD COLUMN IF NOT EXISTS vantage_position     TEXT,
  ADD COLUMN IF NOT EXISTS composition_geometry TEXT;

-- No CHECK constraint per Stage 1 v2.4 closed-enum-drop discipline (closed
-- enums tip Gemini's state-count limit). Persistence-layer normalisation
-- handles drift; non-canonical strings are tolerated rather than dropped.

COMMENT ON COLUMN composition_classifications.vantage_position IS
  'W11.6.29: where the camera is positioned relative to the scene (eye_level / corner / square_to_wall / through_doorway / down_corridor / aerial_overhead / aerial_oblique / low_angle / high_angle). NULL = unstated. Replaces a portion of the deprecated composition_type column.';

COMMENT ON COLUMN composition_classifications.composition_geometry IS
  'W11.6.29: geometric statement of the frame (one_point_perspective / two_point_perspective / three_point_perspective / leading_lines / symmetrical / centered / rule_of_thirds / asymmetric_balance). NULL = no specific statement.';

COMMENT ON COLUMN gallery_positions.vantage_position IS
  'See composition_classifications.vantage_position. Used as recipe constraint axis.';

COMMENT ON COLUMN gallery_positions.composition_geometry IS
  'See composition_classifications.composition_geometry. Used as recipe constraint axis.';

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK B — Drop dead constraint axes from gallery_positions
-- ═════════════════════════════════════════════════════════════════════════
--
-- These were authored per R1's mig 443 but have proven redundant:
--   room_type        is a legacy single-axis pre-W11.6.13 (decomposed into
--                    space_type + zone_focus); operators author against
--                    space_type now via friendly UI labels.
--   composition_type is now decomposed into vantage_position +
--                    composition_geometry above.
--
-- The 6 existing rows in gallery_positions (Silver Standard recipe) currently
-- have room_type populated on 4 of them; the constraints those rows expressed
-- are largely captured by space_type + zone_focus already. composition_type
-- has 0 rows populated. No data is meaningfully lost.

ALTER TABLE gallery_positions DROP COLUMN IF EXISTS room_type;
ALTER TABLE gallery_positions DROP COLUMN IF EXISTS composition_type;

-- (Keep these columns on composition_classifications — old rows still
-- reference them; new emissions populate them too via the prompt for
-- backwards compat.)

-- ═════════════════════════════════════════════════════════════════════════
-- TRACK C — Backfill vantage_position + composition_geometry from existing
--           composition_type data on composition_classifications
-- ═════════════════════════════════════════════════════════════════════════
--
-- hero_wide is intentionally NOT mapped — it's a shot_scale concern; vantage
-- stays NULL.

UPDATE composition_classifications
   SET vantage_position = CASE composition_type
         WHEN 'corner_two_point'      THEN 'corner'
         WHEN 'straight_on'           THEN 'square_to_wall'
         WHEN 'threshold_transition'  THEN 'through_doorway'
         WHEN 'corridor_leading'      THEN 'down_corridor'
         ELSE vantage_position
       END,
       composition_geometry = CASE composition_type
         WHEN 'corner_two_point'      THEN 'two_point_perspective'
         WHEN 'corridor_leading'      THEN 'leading_lines'
         ELSE composition_geometry
       END
 WHERE composition_type IS NOT NULL
   AND (vantage_position IS NULL OR composition_geometry IS NULL);

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- POSTGREST CACHE INVALIDATION
-- ═════════════════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

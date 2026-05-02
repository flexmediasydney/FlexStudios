-- 433_signal_library_readonly_hardcoded_mirror.sql
--
-- Convert shortlisting_signal_weights from a tunable catalog into a read-only
-- mirror of the 26 signals hardcoded in the Stage 1 vision schema:
--   supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts
--
-- Why: the engine never read from this table. dimensionRollup.ts imports
-- SIGNAL_TO_DIMENSION from TS; per-signal scoring weights are tuned via
-- shortlisting_tier_configs.signal_weights (Tiers tab); per_room_modifiers
-- was never wired up. The 4 rows that did exist (vantage_point,
-- living_zone_count, clutter_severity, indoor_outdoor_connection_quality)
-- are stale v1-era keys that no longer match the v2 schema.
--
-- Effect: the Signals tab becomes a read-only inventory of what Stage 1
-- actually emits. To add/rename/remove a signal, edit the TS schema and
-- write a follow-up migration that updates this table to match.

BEGIN;

-- 1. Wipe stale rows.
DELETE FROM shortlisting_signal_weights;

-- 2. Drop indexes + unique constraint tied to the version column.
DROP INDEX IF EXISTS idx_signal_weights_active_key;
DROP INDEX IF EXISTS idx_signal_weights_active_dimension;

ALTER TABLE shortlisting_signal_weights
  DROP CONSTRAINT IF EXISTS shortlisting_signal_weights_unique_key_version;

-- 3. Drop columns that no longer have a purpose in a read-only mirror.
ALTER TABLE shortlisting_signal_weights
  DROP COLUMN IF EXISTS per_room_modifiers,
  DROP COLUMN IF EXISTS weight,
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS is_active,
  DROP COLUMN IF EXISTS updated_at;

-- 4. signal_key is now the natural unique key.
ALTER TABLE shortlisting_signal_weights
  ADD CONSTRAINT shortlisting_signal_weights_signal_key_unique
  UNIQUE (signal_key);

-- 5. Widen dimension CHECK so workflow signals can be stored alongside
--    the four rollup dimensions. Workflow signals (retouch_debt,
--    gallery_arc_position, social_crop_survival, brochure_print_survival)
--    are emitted by Stage 1 but do not roll up into combined_score —
--    they feed downstream consumers (retouch_priority etc).
ALTER TABLE shortlisting_signal_weights
  DROP CONSTRAINT IF EXISTS shortlisting_signal_weights_dimension_check;
ALTER TABLE shortlisting_signal_weights
  ADD CONSTRAINT shortlisting_signal_weights_dimension_check
  CHECK (dimension IN ('compositional','aesthetic','technical','lighting','workflow'));

-- 6. Strip write policies. Migrations bypass RLS, so future seed updates
--    still work. master_admin/admin/manager/employee/contractor still SELECT.
DROP POLICY IF EXISTS "signal_weights_insert" ON shortlisting_signal_weights;
DROP POLICY IF EXISTS "signal_weights_update" ON shortlisting_signal_weights;
DROP POLICY IF EXISTS "signal_weights_delete" ON shortlisting_signal_weights;

COMMENT ON TABLE shortlisting_signal_weights IS
  'Read-only mirror of the 26 hardcoded Stage 1 vision signals defined in supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts (UNIVERSAL_SIGNAL_KEYS + SIGNAL_TO_DIMENSION). To add/remove/rename a signal, edit the TS schema and add a follow-up migration that mirrors the change here. Per-signal scoring weights are tuned via shortlisting_tier_configs.signal_weights — NOT here.';

-- 7. Seed the 26 current signals. Descriptions are copies of the inline
--    rubric text from SIGNAL_SCORES_SCHEMA so the catalog reads the same
--    as what Stage 1 sees at prompt time.

INSERT INTO shortlisting_signal_weights (signal_key, dimension, description) VALUES
  -- ─ Technical (6) ─
  ('exposure_balance', 'technical',
   '0-10: highlights AND shadows held without clipping. 10=both ends preserved; 5=one end clips; 0=both ends blow out. RAW source: NULL (HDR merge will resolve). Finals: scored — blowout is hard-fail. External: scored observationally only. Floorplan: NULL.'),
  ('color_cast', 'technical',
   '0-10: white balance neutrality. 10=neutral whites and skin tones; lower as cast strengthens (warm orange, cool blue, magenta/green). Mixed-light scenes get partial credit for hero-zone neutrality. Floorplan: NULL.'),
  ('sharpness_subject', 'technical',
   '0-10: focus accuracy on the hero subject. 10=razor-crisp on intended hero zone; 5=soft but recognisable; 0=motion-blurred or mis-focused beyond recovery. Floorplan: NULL.'),
  ('sharpness_corners', 'technical',
   '0-10: lens corner sharpness. 10=uniformly crisp edge-to-edge; 5=visible corner softness expected of wide-aperture wide-angle; 0=corners smeared or coma-distorted. Floorplan: NULL.'),
  ('plumb_verticals', 'technical',
   '0-10: vertical lines vertical or converging? 10=walls plumb, no keystoning; 5=mild lean correctable in post; 0=severe converging verticals. RAW: soft penalty (correctable). Finals: hard threshold. Floorplan: NULL.'),
  ('perspective_distortion', 'technical',
   '0-10: wide-angle stretch — appropriate or excessive? 10=no visible distortion; 5=mild stretch typical of 16-24mm; 0=severe barrel/pincushion. Floorplan: NULL.'),

  -- ─ Lighting (4 — Q2 binding) ─
  ('light_quality', 'lighting',
   '0-10: overall lighting CHARACTER and quality. 10=beautiful, evocative light that flatters the subject (golden-hour warmth, soft north-facing daylight, evenly-modulated dusk); 5=adequate ambient light, no character; 0=harsh fluorescent overheads, mixed colour temperature chaos, or flat featureless light. Floorplan: NULL.'),
  ('light_directionality', 'lighting',
   '0-10: direction of light and how it shapes the subject. 10=clear, intentional direction that reveals form (raking side-light on textured walls, top-back rim on architectural detail); 5=neutral frontal/ambient with no shaping; 0=lighting works against the subject (e.g. hot spot on background, subject in shadow). Floorplan: NULL.'),
  ('color_temperature_appropriateness', 'lighting',
   '0-10: white balance MATCHES the scene the photographer is selling. 10=tonally consistent with the property style (warm interiors for period homes, neutral cool for contemporary, dusk-amber for twilight sets); 5=slightly off but recoverable; 0=jarring mixed white balance or wrong temperature for the era/style. Floorplan: NULL.'),
  ('light_falloff_quality', 'lighting',
   '0-10: gradient and rolloff between bright and shadow zones. 10=smooth, photographic falloff that creates depth (gentle window wash gradient onto a wall, soft shadow into ceiling line); 5=hard edges between zones but not distracting; 0=harsh sharp-edged shadows, banding, or flash-flat with no falloff at all. Floorplan: NULL.'),

  -- ─ Composition (8) — note: dimension stored as 'compositional' to match the legacy CHECK enum used by the existing 4 rows pre-cleanup ─
  ('depth_layering', 'compositional',
   '0-10: foreground / middleground / background separation. 10=three distinct planes; 5=two planes; 0=flat single-plane. Floorplan: NULL.'),
  ('composition_geometry', 'compositional',
   '0-10: rule of thirds, leading lines, symmetry — geometric strength of the frame. 10=textbook; 5=adequate; 0=chaotic. Floorplan: NULL.'),
  ('vantage_quality', 'compositional',
   '0-10: camera position appropriateness for subject. 10=ideal vantage; 5=workable; 0=wrong vantage. Floorplan: NULL.'),
  ('framing_quality', 'compositional',
   '0-10: subject placement and breathing room. 10=intentional framing; 5=cramped or floating; 0=amputated by frame edge. Floorplan: NULL.'),
  ('leading_lines', 'compositional',
   '0-10: do lines pull the eye toward the subject? 10=strong convergence on hero; 5=neutral; 0=lines lead AWAY. Score 5 if no lines present. Floorplan: NULL.'),
  ('negative_space', 'compositional',
   '0-10: intentional vs accidental negative space. 10=amplifies subject; 5=neutral; 0=dead air. Floorplan: NULL.'),
  ('symmetry_quality', 'compositional',
   '0-10: when symmetry is the intent, how well executed? 10=pixel-perfect; 5=near-symmetric off; 0=badly broken. NULL when not a symmetrical composition or for floorplans.'),
  ('foreground_anchor', 'compositional',
   '0-10: anchoring foreground element. 10=strong anchor; 5=some foreground but not anchoring; 0=no foreground, frame floats. Floorplan: NULL.'),

  -- ─ Aesthetic (4) ─
  ('material_specificity', 'aesthetic',
   '0-10: how specifically can materials be identified? 10=specific material name (Caesarstone Calacatta, spotted gum); 5=generic ("stone benchtop"); 0=materials unreadable. Floorplan: NULL.'),
  ('period_reading', 'aesthetic',
   '0-10: era/architectural style legibility. 10=unambiguous era; 5=mixed signals; 0=unreadable. Floorplan: scored from drawing legend.'),
  ('styling_quality', 'aesthetic',
   '0-10: intentional vs neglected styling. 10=magazine-level; 5=lived-in; 0=visibly cluttered or pre-styling. Floorplan: NULL.'),
  ('distraction_freeness', 'aesthetic',
   '0-10: clutter, power lines, neighbours, errant objects. 10=clean frame; 5=minor distractions; 0=major distractions. Floorplan: NULL.'),

  -- ─ Workflow (4) — emitted by Stage 1, NOT rolled into combined_score ─
  ('retouch_debt', 'workflow',
   '0-10: total retouch work the editor will need. HIGHER score = LESS debt. 10=no retouch debt; 5=standard retouch; 0=major retouch. Floorplan: NULL.'),
  ('gallery_arc_position', 'workflow',
   '0-10: pre-Stage-4 hint at gallery placement value. 10=lead-image candidate; 5=mid-gallery; 0=archive-only. Floorplan: NULL.'),
  ('social_crop_survival', 'workflow',
   '0-10: does a 1:1 Instagram crop preserve the subject? 10=centre square preserves hero; 5=mostly preserved; 0=subject lost. Floorplan: NULL.'),
  ('brochure_print_survival', 'workflow',
   '0-10: print-quality at A4 brochure size. 10=print-ready; 5=adequate for digital, marginal in print; 0=artefacts.');

COMMIT;

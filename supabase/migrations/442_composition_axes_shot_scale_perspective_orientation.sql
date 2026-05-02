-- ─────────────────────────────────────────────────────────────────────────
-- Mig 442 — Composition observability axes: shot_scale + perspective_compression + orientation
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-W11.7.17 / Mig 442
-- Schema: composition_classifications v2.4 -> v2.5 (Stage 1 universalVisionResponseSchemaV2)
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────
--
-- Today's classification axes are missing three concepts that matter for
-- premium-tier voice + slot eligibility:
--
--   1. SHOT SCALE — how much of the scene is framed.
--      `is_detail_shot` boolean exists but is FALSE on 100% of 140 production
--      rows; `composition_type` (corner_two_point, straight_on, hero_wide,
--      threshold_transition, corridor_leading) does double duty as framing
--      intent and is not a clean scale axis. We need a dedicated 5-value
--      enum: wide / medium / tight / detail / vignette.
--
--   2. PERSPECTIVE COMPRESSION — how depth renders.
--      EXIF says lens focal length but doesn't tell you whether the shot
--      FEELS expanded (16-24mm look) or compressed (35-50mm flattening).
--      A wide framing can have either feel; this is a SEPARATE axis from
--      FOV/lens_class. Premium tier voice should bias compressed; volume
--      marketing biases expanded. 3-value enum: expanded / neutral / compressed.
--
--   3. ORIENTATION — landscape / portrait / square.
--      Not captured anywhere. EXIF has the dimensions but we never extract
--      aspect into a classification axis. 3-value enum: landscape / portrait
--      / square.
--
-- Plus: shortlisting_slot_definitions gets matching eligibility arrays so
-- future slot recipes can filter on these axes — but DO NOT seed any values
-- today, just create the columns. Slots will be authored to use these later.
--
-- ─── DESIGN NOTES ────────────────────────────────────────────────────────
--
-- * Columns are TEXT (not enum types) per Agent O2's guardrail
--   (commit e47843a, schemaStateCount.test.ts): closed enums tip Gemini's
--   responseSchema state-count budget. CHECK constraints enforce the closed
--   list at the DB layer; persistence-layer normalisation drops drift with a
--   warning.
--
-- * `is_detail_shot` is DEPRECATED (sunset 2026-05-02). Stage 1 schema no
--   longer emits it; column kept for backwards compat with v1/v1.x/v2 traffic
--   that has already landed FALSE on every row. Drop in a future wave once
--   historical readers are off it.
--
-- * `orientation` is DERIVED at INGEST/persist time from EXIF, NOT via vision
--   call. The shape-d persist layer reads `composition_groups.exif_metadata`
--   for the best_bracket_stem and computes the axis. Cost: zero — we already
--   have the EXIF in JSONB. Older rows where EXIF metadata is unavailable
--   land NULL.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
-- 1. Drop the slot-definitions eligibility arrays:
--      ALTER TABLE shortlisting_slot_definitions
--        DROP COLUMN IF EXISTS eligible_orientation,
--        DROP COLUMN IF EXISTS eligible_perspective_compression,
--        DROP COLUMN IF EXISTS eligible_shot_scale;
--
-- 2. Drop the composition_classifications CHECK constraints:
--      ALTER TABLE composition_classifications
--        DROP CONSTRAINT IF EXISTS composition_classifications_orientation_chk,
--        DROP CONSTRAINT IF EXISTS composition_classifications_perspective_compression_chk,
--        DROP CONSTRAINT IF EXISTS composition_classifications_shot_scale_chk;
--
-- 3. Drop the composition_classifications columns (DATA-LOSSY for any rows
--    populated post-mig-442):
--      ALTER TABLE composition_classifications
--        DROP COLUMN IF EXISTS orientation,
--        DROP COLUMN IF EXISTS perspective_compression,
--        DROP COLUMN IF EXISTS shot_scale;
--
-- 4. Restore the is_detail_shot deprecation comment to the previous (none)
--    state if needed. Column itself is NOT touched by this migration's
--    rollback — it was always there.
--
-- 5. NOTIFY pgrst, 'reload schema';
--
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── (1) composition_classifications: three new TEXT columns ────────────
ALTER TABLE public.composition_classifications
  ADD COLUMN IF NOT EXISTS shot_scale              TEXT,
  ADD COLUMN IF NOT EXISTS perspective_compression TEXT,
  ADD COLUMN IF NOT EXISTS orientation             TEXT;

-- ─── (2) CHECK constraints — text-only closed lists ─────────────────────
-- Mig safety: NOT VALID would be safer for large tables but
-- composition_classifications is small (~140 rows in prod) and adding the
-- columns above means every existing row has NULL for all three — the
-- constraint is "NULL OR in_list" so the validation pass is a no-op for
-- existing rows. Inline ADD CONSTRAINT is fine here.

ALTER TABLE public.composition_classifications
  ADD CONSTRAINT composition_classifications_shot_scale_chk
    CHECK (shot_scale IS NULL
           OR shot_scale IN ('wide','medium','tight','detail','vignette'));

ALTER TABLE public.composition_classifications
  ADD CONSTRAINT composition_classifications_perspective_compression_chk
    CHECK (perspective_compression IS NULL
           OR perspective_compression IN ('expanded','neutral','compressed'));

ALTER TABLE public.composition_classifications
  ADD CONSTRAINT composition_classifications_orientation_chk
    CHECK (orientation IS NULL
           OR orientation IN ('landscape','portrait','square'));

-- ─── (3) Column comments (taxonomy-as-comment for ad-hoc SQL readers) ───
COMMENT ON COLUMN public.composition_classifications.shot_scale IS
  'Mig 442 (2026-05-02): how much of the scene is framed. One of: '
  'wide | medium | tight | detail | vignette. Distinct from FOV/lens_class '
  '(a wide-FOV lens shot framed tight on a small bathroom can read '
  'shot_scale=tight). Stage 1 schema v2.5 emits via universalVisionResponseSchemaV2.';
COMMENT ON COLUMN public.composition_classifications.perspective_compression IS
  'Mig 442 (2026-05-02): how depth renders. One of: expanded | neutral | '
  'compressed. Distinct from focal length (EXIF says 24mm but a shot framed '
  'close on a small ensuite reads compressed). Cross-reference with depth '
  'cues: parallel walls = compressed; splaying walls = expanded; converging '
  'vanishing lines = expanded. Stage 1 schema v2.5 emits this.';
COMMENT ON COLUMN public.composition_classifications.orientation IS
  'Mig 442 (2026-05-02): aspect orientation. One of: landscape | portrait | '
  'square. DERIVED at ingest/persist time from EXIF Width/Height '
  '(width >= height * 1.05 = landscape; height >= width * 1.05 = portrait; '
  'else square). NOT a vision call — zero cost. NULL when EXIF missing or '
  'pre-Mig 442 row.';

-- ─── (4) is_detail_shot deprecation comment + sunset note ────────────────
COMMENT ON COLUMN public.composition_classifications.is_detail_shot IS
  'DEPRECATED 2026-05-02 (mig 442): use shot_scale="detail" or "tight" instead. '
  'Stage 1 schema v2.5 no longer emits this; column kept for backwards compat '
  'with v1/v1.x/v2 traffic. Always FALSE on rows after this migration. Drop '
  'in a future wave once historical readers are off it.';

-- ─── (5) Indexes for the new axes (queryable for slot eligibility) ──────
CREATE INDEX IF NOT EXISTS idx_classif_shot_scale
  ON public.composition_classifications (shot_scale);
CREATE INDEX IF NOT EXISTS idx_classif_perspective_compression
  ON public.composition_classifications (perspective_compression);
CREATE INDEX IF NOT EXISTS idx_classif_orientation
  ON public.composition_classifications (orientation);

-- ─── (6) shortlisting_slot_definitions — matching eligibility arrays ────
-- DEFAULT '{}' → existing slot rows continue to behave as today (no filter).
-- Slots will be authored to use these in a future wave. Column shape mirrors
-- W11.6.13 mig 391 (eligible_space_types[] / eligible_zone_focuses[]).

ALTER TABLE public.shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS eligible_shot_scale             TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS eligible_perspective_compression TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS eligible_orientation             TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.shortlisting_slot_definitions.eligible_shot_scale IS
  'Mig 442: array of shot_scale values this slot is eligible for. Empty '
  'array = no filter (current behaviour). Resolver uses this alongside '
  'eligible_space_types/eligible_zone_focuses (mig 391) and '
  'eligible_room_types (legacy) for AND-intersection slot eligibility.';
COMMENT ON COLUMN public.shortlisting_slot_definitions.eligible_perspective_compression IS
  'Mig 442: array of perspective_compression values this slot is eligible for. '
  'Empty array = no filter. See eligible_shot_scale for resolver semantics.';
COMMENT ON COLUMN public.shortlisting_slot_definitions.eligible_orientation IS
  'Mig 442: array of orientation values this slot is eligible for (landscape '
  '| portrait | square). Empty array = no filter. See eligible_shot_scale '
  'for resolver semantics.';

-- GIN indexes for the array-overlap lookups the resolver runs every Pass 2.
CREATE INDEX IF NOT EXISTS idx_slot_defs_eligible_shot_scale_gin
  ON public.shortlisting_slot_definitions USING GIN (eligible_shot_scale)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_slot_defs_eligible_perspective_compression_gin
  ON public.shortlisting_slot_definitions USING GIN (eligible_perspective_compression)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_slot_defs_eligible_orientation_gin
  ON public.shortlisting_slot_definitions USING GIN (eligible_orientation)
  WHERE is_active = true;

NOTIFY pgrst, 'reload schema';

-- ─── (7) Apply-time assertion ────────────────────────────────────────────
-- Belt-and-braces: confirm all six new columns landed and the three CHECK
-- constraints are present before COMMIT.
DO $$
DECLARE
  col_count int;
  chk_count int;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'composition_classifications'
          AND column_name IN ('shot_scale','perspective_compression','orientation'))
      OR (table_name = 'shortlisting_slot_definitions'
          AND column_name IN ('eligible_shot_scale','eligible_perspective_compression','eligible_orientation')));
  IF col_count <> 6 THEN
    RAISE EXCEPTION 'mig 442: expected 6 new columns, found %', col_count;
  END IF;

  SELECT COUNT(*) INTO chk_count
  FROM information_schema.table_constraints
  WHERE table_schema = 'public'
    AND table_name = 'composition_classifications'
    AND constraint_type = 'CHECK'
    AND constraint_name IN (
      'composition_classifications_shot_scale_chk',
      'composition_classifications_perspective_compression_chk',
      'composition_classifications_orientation_chk'
    );
  IF chk_count <> 3 THEN
    RAISE EXCEPTION 'mig 442: expected 3 new CHECK constraints, found %', chk_count;
  END IF;

  RAISE NOTICE 'mig 442 added 6 columns + 3 CHECK constraints (composition axes: shot_scale + perspective_compression + orientation)';
END;
$$;

COMMIT;

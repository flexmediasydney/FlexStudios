-- Migration 394 — Wave 11.6.7 P1-4: lens_class derivation + slot eligibility.
--
-- Origin: docs/WAVE_7_BACKLOG.md L203-228. Joseph wanted compressed vs wide vs
-- detail shot disambiguation. EXIF focal length already lives in
-- composition_groups.exif_metadata JSONB (per-stem ExifSignals), but Stage 1
-- output never derived a normalised lens class. Slots can't filter on it
-- either.
--
-- This migration adds:
--   - composition_classifications.lens_class TEXT NULL
--     enum-ish: 'wide_angle' | 'standard' | 'telephoto' | 'tilt_shift' |
--     'drone' | 'any' (Stage 1 derives + persists)
--   - shortlisting_slot_definitions.lens_class_constraint TEXT NULL
--     same enum; non-null = slot accepts only winners with matching lens_class
--
-- No CHECK constraint enforced — keeping forward-compat with future lens
-- classes (e.g. fisheye, macro). The helper in `_shared/lensClass.ts` defines
-- the canonical set and the engine uses it as the source of truth.

BEGIN;

ALTER TABLE public.composition_classifications
  ADD COLUMN IF NOT EXISTS lens_class TEXT;

COMMENT ON COLUMN public.composition_classifications.lens_class IS
  'Wave 11.6.7 P1-4: derived from EXIF focal length per _shared/lensClass.ts. wide_angle (≤28mm) | standard (28-70) | telephoto (>70) | tilt_shift | drone (EXIF override). NULL when EXIF missing.';

CREATE INDEX IF NOT EXISTS idx_composition_classifications_lens_class
  ON public.composition_classifications (lens_class)
  WHERE lens_class IS NOT NULL;

ALTER TABLE public.shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS lens_class_constraint TEXT;

COMMENT ON COLUMN public.shortlisting_slot_definitions.lens_class_constraint IS
  'Wave 11.6.7 P1-4: when non-null, Stage 4 slot validator rejects decisions whose winner''s lens_class != this value. Mismatches emit stage_4_overrides[] rows. NULL = no lens-class constraint.';

COMMIT;

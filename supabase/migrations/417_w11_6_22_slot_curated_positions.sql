-- W11.6.22 — per-slot curated positions + AI backfill on gap.
--
-- Context: the W7.7 slot system models a slot as { min_images, max_images }
-- and lets the AI freely choose which images fill the slot subject to
-- room/space/zone/composition/lens eligibility. For production galleries
-- this is too loose: Joseph wants to spec, per slot, exactly which
-- compositional ROLES the slot contains (e.g. kitchen_hero = 1 hero wide +
-- 1 angled alt + 1 mid-detail), and have the engine pick the best image
-- per ROLE rather than per SLOT.
--
-- This migration adds:
--   1. shortlisting_slot_definitions.selection_mode      — 'ai_decides'
--      (default, legacy behaviour) | 'curated_positions' (new W11.6.22 mode).
--   2. shortlisting_slot_position_preferences            — per-position
--      preferences for curated slots: composition / zone / space / lighting /
--      image type / signal_emphasis + is_required + ai_backfill_on_gap flags.
--   3. shortlisting_overrides.position_index             — which curated
--      position the persisted slot decision filled.
--   4. shortlisting_overrides.position_filled_via        — 'curated_match' |
--      'ai_backfill' | NULL (legacy ai_decides slots).
--
-- Joseph confirmed UI dropdowns import the canonical TS constants from
-- supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts
-- and Gemini's responseSchema validation closes the loop. We don't add a
-- DB-level CHECK on preferred_composition_type / preferred_zone_focus /
-- preferred_space_type / preferred_lighting_state / preferred_image_type
-- because (a) the canonical lists evolve and chasing them with new migrations
-- is friction, (b) the UI is the gate, (c) Gemini will reject anything off-
-- taxonomy at emission time.
--
-- RLS mirrors shortlisting_slot_definitions: master_admin full CRUD;
-- manager+ read-only; service_role bypass.
--
-- Idempotence: wrapped in IF NOT EXISTS guards so partial-apply + re-run is
-- safe. NOTE: this migration was already applied to the prod DB on the
-- W11.6.22 build branch via Supabase MCP (file was renumbered when QC
-- agents took 415); the IF NOT EXISTS guards keep the file replay-safe for
-- new environments.

-- 1. selection_mode column on shortlisting_slot_definitions
ALTER TABLE public.shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS selection_mode TEXT NOT NULL DEFAULT 'ai_decides';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shortlisting_slot_definitions'::regclass
      AND conname = 'shortlisting_slot_definitions_selection_mode_chk'
  ) THEN
    ALTER TABLE public.shortlisting_slot_definitions
      ADD CONSTRAINT shortlisting_slot_definitions_selection_mode_chk
      CHECK (selection_mode IN ('ai_decides', 'curated_positions'));
  END IF;
END $$;

COMMENT ON COLUMN public.shortlisting_slot_definitions.selection_mode IS
  'W11.6.22 — ai_decides (default; AI picks N images subject to existing eligibility) | curated_positions (admin specs N positions in shortlisting_slot_position_preferences; AI picks one image per position and falls back per ai_backfill_on_gap flag).';

-- 2. shortlisting_slot_position_preferences
CREATE TABLE IF NOT EXISTS public.shortlisting_slot_position_preferences (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id                     TEXT NOT NULL,
  position_index              INT  NOT NULL CHECK (position_index >= 1),
  display_label               TEXT NOT NULL,
  preferred_composition_type  TEXT,
  preferred_zone_focus        TEXT,
  preferred_space_type        TEXT,
  preferred_lighting_state    TEXT,
  preferred_image_type        TEXT,
  preferred_signal_emphasis   TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  is_required                 BOOLEAN NOT NULL DEFAULT FALSE,
  ai_backfill_on_gap          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slot_id, position_index)
);

COMMENT ON TABLE public.shortlisting_slot_position_preferences IS
  'W11.6.22 — per-position curation for curated_positions slots. One row per position. Stage 4 reads these and emits position_index per slot_decision; persistSlotDecisions writes the resolved position_index into shortlisting_overrides.position_index.';

COMMENT ON COLUMN public.shortlisting_slot_position_preferences.preferred_signal_emphasis IS
  'W11.6.22 — array of signal keys from UNIVERSAL_SIGNAL_KEYS (the 26 W11.7.17 v2 signals). Empty default = no emphasis. UI populates from canonical TS constants; no DB-level CHECK because the list evolves.';

CREATE INDEX IF NOT EXISTS idx_slot_pos_prefs_slot
  ON public.shortlisting_slot_position_preferences(slot_id, position_index);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_slot_pos_prefs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS slot_pos_prefs_updated_at_trg
  ON public.shortlisting_slot_position_preferences;
CREATE TRIGGER slot_pos_prefs_updated_at_trg
  BEFORE UPDATE ON public.shortlisting_slot_position_preferences
  FOR EACH ROW EXECUTE FUNCTION public.tg_slot_pos_prefs_updated_at();

ALTER TABLE public.shortlisting_slot_position_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slot_pos_prefs_admin_all" ON public.shortlisting_slot_position_preferences;
CREATE POLICY "slot_pos_prefs_admin_all"
  ON public.shortlisting_slot_position_preferences
  FOR ALL
  TO authenticated
  USING (public.get_user_role() = 'master_admin')
  WITH CHECK (public.get_user_role() = 'master_admin');

DROP POLICY IF EXISTS "slot_pos_prefs_manager_read" ON public.shortlisting_slot_position_preferences;
CREATE POLICY "slot_pos_prefs_manager_read"
  ON public.shortlisting_slot_position_preferences
  FOR SELECT
  TO authenticated
  USING (public.get_user_role() IN ('master_admin', 'admin', 'manager', 'photographer', 'editor'));

DROP POLICY IF EXISTS "slot_pos_prefs_service_role" ON public.shortlisting_slot_position_preferences;
CREATE POLICY "slot_pos_prefs_service_role"
  ON public.shortlisting_slot_position_preferences
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- 3. shortlisting_overrides — position_index + position_filled_via
ALTER TABLE public.shortlisting_overrides
  ADD COLUMN IF NOT EXISTS position_index INT,
  ADD COLUMN IF NOT EXISTS position_filled_via TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.shortlisting_overrides'::regclass
      AND conname = 'shortlisting_overrides_position_filled_via_chk'
  ) THEN
    ALTER TABLE public.shortlisting_overrides
      ADD CONSTRAINT shortlisting_overrides_position_filled_via_chk
      CHECK (
        position_filled_via IS NULL OR
        position_filled_via IN ('curated_match', 'ai_backfill')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.shortlisting_overrides.position_index IS
  'W11.6.22 — when the slot was selection_mode=curated_positions, the 1-indexed position this winner filled (matches shortlisting_slot_position_preferences.position_index). NULL for legacy ai_decides slots.';

COMMENT ON COLUMN public.shortlisting_overrides.position_filled_via IS
  'W11.6.22 — curated_match: Stage 4 found an image matching the curated position criteria. ai_backfill: Stage 4 fell back to an AI-decided alternative when no match was found AND ai_backfill_on_gap=TRUE. NULL: legacy ai_decides slot (no curation in play).';

-- Migration 411 — Wave 12.7-12.8: shortlisting suggestion tables
-- ─────────────────────────────────────────────────────────────────
-- Companion: docs/design-specs/W12-trigger-thresholds.md (defines schema +
-- threshold defaults). Powers the shortlisting-suggestion-engine edge fn
-- and the SettingsAISuggestions admin page.
--
-- Two output tables:
--   * shortlisting_slot_suggestions — aggregated pass2_slot_suggestion
--     events (Stage 4 emits these when no canonical slot fits a composition
--     it thinks is shortlist-worthy).
--   * shortlisting_room_type_suggestions — aggregated room-type signals from
--     forced fallbacks, key_elements clusters, and override patterns.
--
-- Manual-trigger only: the engine fn is fired by master_admin from the UI;
-- no autonomous cron writes here. Per Joseph 2026-04-27 + W12 trigger spec.

BEGIN;

-- 1. shortlisting_slot_suggestions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shortlisting_slot_suggestions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_slot_id            TEXT NOT NULL,
  proposed_display_name       TEXT,
  proposed_phase              INTEGER,
  /** W12.8 NEW: trigger source distinguishes Stage 4 events (1) vs registry-driven proposals (2). */
  trigger_source              TEXT NOT NULL DEFAULT 'pass2_event'
    CHECK (trigger_source IN ('pass2_event', 'registry_high_frequency')),
  evidence_round_count        INTEGER NOT NULL DEFAULT 0,
  evidence_total_proposals    INTEGER NOT NULL DEFAULT 0,
  first_observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sample_round_ids            UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  sample_reasoning            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  /** W12.8 — when trigger_source = 'registry_high_frequency', references the
   *  object_registry row whose market_frequency drove the proposal. */
  source_object_registry_id   UUID REFERENCES public.object_registry(id),
  source_market_frequency     INTEGER,
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'archived')),
  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMPTZ,
  reviewer_notes              TEXT,
  approved_slot_id            TEXT,
  merged_into_slot_id         TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.shortlisting_slot_suggestions IS
  'Wave 12.7-12.8: AI-suggestion engine output. One row per (proposed_slot_id, trigger_source). Re-running the engine upserts evidence counts.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_suggestions_proposal_source
  ON public.shortlisting_slot_suggestions (proposed_slot_id, trigger_source);

CREATE INDEX IF NOT EXISTS idx_slot_suggestions_pending
  ON public.shortlisting_slot_suggestions (last_observed_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_slot_suggestions_status
  ON public.shortlisting_slot_suggestions (status);

CREATE INDEX IF NOT EXISTS idx_slot_suggestions_source_object
  ON public.shortlisting_slot_suggestions (source_object_registry_id)
  WHERE source_object_registry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.shortlisting_slot_suggestions_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shortlisting_slot_suggestions_updated_at_t
  ON public.shortlisting_slot_suggestions;
CREATE TRIGGER shortlisting_slot_suggestions_updated_at_t
  BEFORE UPDATE ON public.shortlisting_slot_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.shortlisting_slot_suggestions_set_updated_at();

-- 2. shortlisting_room_type_suggestions ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shortlisting_room_type_suggestions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_key                TEXT NOT NULL,
  proposed_display_name       TEXT,
  trigger_source              TEXT NOT NULL
    CHECK (trigger_source IN ('forced_fallback', 'key_elements_cluster', 'override_pattern')),
  evidence_count              INTEGER NOT NULL DEFAULT 0,
  first_observed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sample_composition_ids      UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  sample_analysis_excerpts    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  proposed_eligible_slots     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  /** Average room_type_confidence across the evidence — used for ranking. */
  avg_confidence              NUMERIC(4,3),
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'archived')),
  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMPTZ,
  reviewer_notes              TEXT,
  approved_room_type_id       UUID REFERENCES public.shortlisting_room_types(id),
  merged_into_room_type_id    UUID REFERENCES public.shortlisting_room_types(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.shortlisting_room_type_suggestions IS
  'Wave 12.7-12.8: AI-suggestion engine output for new room_type candidates. Three trigger sources per W12-trigger-thresholds.md.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_type_suggestions_key_source
  ON public.shortlisting_room_type_suggestions (proposed_key, trigger_source);

CREATE INDEX IF NOT EXISTS idx_room_type_suggestions_pending
  ON public.shortlisting_room_type_suggestions (last_observed_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_room_type_suggestions_status
  ON public.shortlisting_room_type_suggestions (status);

CREATE OR REPLACE FUNCTION public.shortlisting_room_type_suggestions_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shortlisting_room_type_suggestions_updated_at_t
  ON public.shortlisting_room_type_suggestions;
CREATE TRIGGER shortlisting_room_type_suggestions_updated_at_t
  BEFORE UPDATE ON public.shortlisting_room_type_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.shortlisting_room_type_suggestions_set_updated_at();

-- 3. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.shortlisting_slot_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shortlisting_room_type_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shortlisting_slot_suggestions_read
  ON public.shortlisting_slot_suggestions;
CREATE POLICY shortlisting_slot_suggestions_read
  ON public.shortlisting_slot_suggestions
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));

DROP POLICY IF EXISTS shortlisting_slot_suggestions_write
  ON public.shortlisting_slot_suggestions;
CREATE POLICY shortlisting_slot_suggestions_write
  ON public.shortlisting_slot_suggestions
  FOR ALL TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

DROP POLICY IF EXISTS shortlisting_room_type_suggestions_read
  ON public.shortlisting_room_type_suggestions;
CREATE POLICY shortlisting_room_type_suggestions_read
  ON public.shortlisting_room_type_suggestions
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));

DROP POLICY IF EXISTS shortlisting_room_type_suggestions_write
  ON public.shortlisting_room_type_suggestions;
CREATE POLICY shortlisting_room_type_suggestions_write
  ON public.shortlisting_room_type_suggestions
  FOR ALL TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── Rollback (manual; only if migration breaks production) ────────────────
--
-- BEGIN;
-- DROP TABLE IF EXISTS public.shortlisting_slot_suggestions CASCADE;
-- DROP TABLE IF EXISTS public.shortlisting_room_type_suggestions CASCADE;
-- DROP FUNCTION IF EXISTS public.shortlisting_slot_suggestions_set_updated_at();
-- DROP FUNCTION IF EXISTS public.shortlisting_room_type_suggestions_set_updated_at();
-- COMMIT;

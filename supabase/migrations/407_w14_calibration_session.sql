-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 407 — Wave 14: 50-project structured calibration session
-- Spec: docs/design-specs/W14-calibration-session.md
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This file mirrors the migration already applied to the production DB on
-- 2026-05-01 (version 20260501150224). The previous orchestration run
-- applied the SQL via the Supabase MCP but died at the cap before the file
-- landed in git; this commit puts the durable record alongside the DB.
--
-- W11.5's trigger migration (w11_5_human_override_observations) takes a
-- timestamp-style version on the DB; W14 keeps the 407 numeric prefix per
-- the spec's chained convention (W12=380... W13a=382... W13b=384a... W14=407).
--
-- Three tables (per spec R1 — three lifecycle entities, not consolidated):
--   1. calibration_sessions          — per-session container
--   2. calibration_editor_shortlists — editor's blind shortlist per project
--   3. calibration_decisions         — per-slot diff capture (editor vs AI)
--
-- Plus: relaxes shortlisting_benchmark_results.trigger CHECK to allow the
-- new 'calibration' value the benchmark-runner now writes (spec §6).

-- ─── 1. calibration_sessions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calibration_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'editor_phase', 'diff_phase', 'completed', 'abandoned')),
  stratification_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_project_ids UUID[] NOT NULL DEFAULT '{}',
  engine_version TEXT,
  tier_config_versions JSONB,
  editor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  editor_phase_completed_at TIMESTAMPTZ,
  diff_phase_completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE calibration_sessions IS
  'Wave 14 (W14): per-session container for the 50-project structured calibration. Status lifecycle: open → editor_phase → diff_phase → completed. See docs/design-specs/W14-calibration-session.md.';

COMMENT ON COLUMN calibration_sessions.stratification_config IS
  'Cell distribution chosen for this session, e.g. {"cells": [{"package_id": "...", "pricing_tier": "P", "count": 10}, ...]}. Drives the project picker. Empty {} means operator hand-picked all projects.';

COMMENT ON COLUMN calibration_sessions.tier_config_versions IS
  'Map of {engine_tier_id: tier_config_version} pinned at session start (W8.4). Lets downstream re-extraction know which tier weights produced the AI baseline.';

CREATE INDEX IF NOT EXISTS idx_calibration_sessions_editor
  ON calibration_sessions(editor_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_calibration_sessions_active
  ON calibration_sessions(status, started_at DESC) WHERE status != 'completed';

-- ─── 2. calibration_editor_shortlists ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calibration_editor_shortlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_session_id UUID NOT NULL
    REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE SET NULL,
  editor_picked_stems TEXT[] NOT NULL DEFAULT '{}',
  editor_per_stem_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'submitted', 'skipped')),
  skipped_reason TEXT,
  submitted_at TIMESTAMPTZ,
  ai_run_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calibration_editor_shortlists_unique_session_project
    UNIQUE (calibration_session_id, project_id)
);

COMMENT ON TABLE calibration_editor_shortlists IS
  'Wave 14 (W14): editor''s blind shortlist per (session, project). Submitted before the editor sees the AI''s output. Pairs with calibration_decisions for the diff capture. Spec §3.';

COMMENT ON COLUMN calibration_editor_shortlists.editor_per_stem_notes IS
  'Free-text per-stem notes during blind selection, e.g. {"IMG_017": "only kitchen with bench cleared"}. Captured for analysis but NOT shown to AI side (spec R9).';

CREATE INDEX IF NOT EXISTS idx_calibration_editor_shortlists_session
  ON calibration_editor_shortlists(calibration_session_id);

CREATE INDEX IF NOT EXISTS idx_calibration_editor_shortlists_project
  ON calibration_editor_shortlists(project_id);

CREATE INDEX IF NOT EXISTS idx_calibration_editor_shortlists_round
  ON calibration_editor_shortlists(round_id) WHERE round_id IS NOT NULL;

-- ─── 3. calibration_decisions ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calibration_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_session_id UUID NOT NULL
    REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE SET NULL,
  slot_id TEXT NOT NULL,
  stem TEXT,
  ai_decision TEXT NOT NULL
    CHECK (ai_decision IN ('shortlisted', 'rejected', 'unranked', 'no_eligible')),
  editor_decision TEXT NOT NULL
    CHECK (editor_decision IN ('shortlisted', 'rejected', 'unranked', 'no_eligible')),
  agreement TEXT NOT NULL
    CHECK (agreement IN ('match', 'disagree')),
  ai_score NUMERIC(5,2),
  ai_per_dim_scores JSONB,
  ai_analysis_excerpt TEXT,
  editor_reasoning TEXT,
  primary_signal_diff TEXT,
  reasoning_categories TEXT[],
  editor_score_override NUMERIC(5,2),
  engine_version TEXT,
  tier_config_version INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE calibration_decisions IS
  'Wave 14 (W14): per-decision diff capture. One row per (session, project, slot). agreement=match when ai_decision==editor_decision; ''disagree'' rows carry editor reasoning + primary_signal_diff for tier-config tuning and W11 prompt few-shot extraction. Spec §3.';

COMMENT ON COLUMN calibration_decisions.primary_signal_diff IS
  'Which dimension/signal the editor cites as the AI''s under-weighting. Pre-W11: one of the 4 dimensions (technical/lighting/composition/aesthetic). Post-W11: extends to 22 signal_keys. Drives tier-config tuning analytics.';

COMMENT ON COLUMN calibration_decisions.reasoning_categories IS
  'Multi-select tags: clutter / mood / composition_specific / tier_mismatch / agent_preference / other. Spec §3.';

CREATE INDEX IF NOT EXISTS idx_calibration_decisions_session
  ON calibration_decisions(calibration_session_id);

CREATE INDEX IF NOT EXISTS idx_calibration_decisions_project
  ON calibration_decisions(project_id);

CREATE INDEX IF NOT EXISTS idx_calibration_decisions_round
  ON calibration_decisions(round_id) WHERE round_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calibration_decisions_disagree_signal
  ON calibration_decisions(primary_signal_diff)
  WHERE agreement = 'disagree';

CREATE INDEX IF NOT EXISTS idx_calibration_decisions_disagree_slot
  ON calibration_decisions(slot_id) WHERE agreement = 'disagree';

CREATE UNIQUE INDEX IF NOT EXISTS uq_calibration_decisions_natural
  ON calibration_decisions(
    calibration_session_id,
    project_id,
    slot_id,
    COALESCE(stem, '__null__')
  );

-- ─── 4. updated_at trigger ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION calibration_session_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calibration_sessions_updated_at_trg ON calibration_sessions;
CREATE TRIGGER calibration_sessions_updated_at_trg
  BEFORE UPDATE ON calibration_sessions
  FOR EACH ROW EXECUTE FUNCTION calibration_session_set_updated_at();

DROP TRIGGER IF EXISTS calibration_editor_shortlists_updated_at_trg
  ON calibration_editor_shortlists;
CREATE TRIGGER calibration_editor_shortlists_updated_at_trg
  BEFORE UPDATE ON calibration_editor_shortlists
  FOR EACH ROW EXECUTE FUNCTION calibration_session_set_updated_at();

-- ─── 5. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE calibration_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_editor_shortlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cal_sessions_select ON calibration_sessions;
CREATE POLICY cal_sessions_select ON calibration_sessions
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));

DROP POLICY IF EXISTS cal_sessions_write ON calibration_sessions;
CREATE POLICY cal_sessions_write ON calibration_sessions
  FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS cal_editor_shortlists_select ON calibration_editor_shortlists;
CREATE POLICY cal_editor_shortlists_select ON calibration_editor_shortlists
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));

DROP POLICY IF EXISTS cal_editor_shortlists_write ON calibration_editor_shortlists;
CREATE POLICY cal_editor_shortlists_write ON calibration_editor_shortlists
  FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS cal_decisions_select ON calibration_decisions;
CREATE POLICY cal_decisions_select ON calibration_decisions
  FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));

DROP POLICY IF EXISTS cal_decisions_write ON calibration_decisions;
CREATE POLICY cal_decisions_write ON calibration_decisions
  FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

-- ─── 6. Relax shortlisting_benchmark_results.trigger ────────────────────────
-- Spec §6: benchmark-runner stamps trigger='calibration' when invoked by
-- calibration-run-ai-batch. Existing CHECK was {'manual','quarterly_cron'}.

ALTER TABLE shortlisting_benchmark_results
  DROP CONSTRAINT IF EXISTS shortlisting_benchmark_results_trigger_check;

ALTER TABLE shortlisting_benchmark_results
  ADD CONSTRAINT shortlisting_benchmark_results_trigger_check
  CHECK (trigger IN ('manual', 'quarterly_cron', 'calibration'));

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ───────────────────────────────────────────────────────
--
-- DROP TABLE IF EXISTS calibration_decisions;
-- DROP TABLE IF EXISTS calibration_editor_shortlists;
-- DROP TABLE IF EXISTS calibration_sessions;
-- DROP FUNCTION IF EXISTS calibration_session_set_updated_at();
-- ALTER TABLE shortlisting_benchmark_results
--   DROP CONSTRAINT IF EXISTS shortlisting_benchmark_results_trigger_check;
-- ALTER TABLE shortlisting_benchmark_results
--   ADD CONSTRAINT shortlisting_benchmark_results_trigger_check
--   CHECK (trigger IN ('manual','quarterly_cron'));

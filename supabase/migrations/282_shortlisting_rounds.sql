-- Wave 6 P1 SHORTLIST: mig 282: shortlisting_rounds — round-level orchestration row
--
-- Foundation table for the photo shortlisting engine (mirrors drone module
-- pattern from mig 225). One row per shortlisting attempt for a project. The
-- engine increments round_number per project; a reshoot or human re-trigger
-- creates a new row rather than overwriting state.
--
-- Lifecycle:
--   pending     → created (settling window may still be open)
--   processing  → Pass 0/1/2/3 actively running
--   proposed    → engine has written its 18-24 hero shortlist; awaiting human
--   locked      → human has confirmed selections; downstream lanes can fire
--   delivered   → Tonomo delivery complete (terminal)
--
-- Each round tracks:
--   - per-phase fill counts (mandatory/conditional/AI free recs) per spec §12
--   - per-pass cost (USD) for budget tracking
--   - package ceiling (Gold=24 / Day-to-Dusk=31 / Premium=38) per spec §12
--   - zero-knowledge baseline (0.78 from Goldmine 4 April 2026) for accuracy comparison
--   - trigger_source (auto_settling / manual / reshoot) for diagnostics
--
-- RLS pattern follows mig 225: master_admin/admin/manager/employee full
-- access; contractor scoped via my_project_ids().
--
-- Timestamps are UTC TIMESTAMPTZ (NOW() default); the dashboard renders them
-- in Australia/Sydney via timezone() casts (see mig 263 pattern).

CREATE TABLE IF NOT EXISTS shortlisting_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','processing','proposed','locked','delivered'
  )),
  package_type TEXT,             -- 'Gold' | 'Day to Dusk' | 'Premium' | other
  package_ceiling INT,           -- 24 | 31 | 38 (per spec §12)
  total_compositions INT,        -- count of composition_groups in this round
  phase1_filled_count INT,       -- mandatory slots filled (spec §12 phase 1)
  phase2_filled_count INT,       -- conditional slots filled (spec §12 phase 2)
  phase3_added_count INT,        -- AI free recommendations added (spec §12 phase 3)
  hard_rejected_count INT NOT NULL DEFAULT 0,
  out_of_scope_count INT NOT NULL DEFAULT 0,
  coverage_source TEXT NOT NULL DEFAULT 'pass1_classifications',
  zero_knowledge_baseline NUMERIC NOT NULL DEFAULT 0.78,
  -- Per-pass cost tracking (USD); pass2 covers Pass 2 + Pass 3 in v2 (see spec §17)
  pass0_cost_usd NUMERIC(8,4),
  pass1_cost_usd NUMERIC(8,4),
  pass2_cost_usd NUMERIC(8,4),
  pass3_cost_usd NUMERIC(8,4),
  total_cost_usd NUMERIC(8,4),
  coverage_notes TEXT,           -- Pass 2 paragraph (spec §6)
  trigger_source TEXT CHECK (trigger_source IS NULL OR trigger_source IN (
    'auto_settling','manual','reshoot'
  )),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shortlisting_rounds_unique_round_per_project
    UNIQUE (project_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_project
  ON shortlisting_rounds(project_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_status
  ON shortlisting_rounds(status);
CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_project_status
  ON shortlisting_rounds(project_id, status);

COMMENT ON TABLE shortlisting_rounds IS
  'One row per shortlisting attempt for a project. Mirrors drone_shoots pattern (mig 225). Round_number increments per project; reshoots create a new row. Per-phase fill counts + per-pass cost + package ceiling tracked here. Spec v2 §16.';
COMMENT ON COLUMN shortlisting_rounds.coverage_source IS
  'v2 default: pass1_classifications. Earlier engines used floorplan; v2 has no floorplan dependency (spec §16).';
COMMENT ON COLUMN shortlisting_rounds.zero_knowledge_baseline IS
  'Goldmine 4 (April 2026) zero-knowledge baseline: 78% composition-level match. Used for quarterly accuracy comparison (spec §14).';
COMMENT ON COLUMN shortlisting_rounds.trigger_source IS
  'auto_settling: 2hr debounce timer fired. manual: human pressed Re-run. reshoot: photographer uploaded new RAWs after locked.';

ALTER TABLE shortlisting_rounds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shortlisting_rounds_read" ON shortlisting_rounds FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_rounds_insert" ON shortlisting_rounds FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_rounds_update" ON shortlisting_rounds FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_rounds_delete_owner_only" ON shortlisting_rounds FOR DELETE
  USING (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

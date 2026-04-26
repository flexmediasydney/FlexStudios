-- Wave 6 P1 SHORTLIST: mig 283: composition_groups + composition_classifications + shortlisting_quarantine
--
-- Three tightly-coupled tables that hold Pass 0/1 output. We ship them in one
-- migration so the FK graph is consistent end-to-end:
--
--   composition_groups            ← spec's "bracket_groups", renamed because
--                                    not all inputs are AEB brackets (multi-
--                                    camera + non-bracketed cases coming).
--   composition_classifications   ← spec's "shortlisting_decisions", renamed
--                                    because Pass 1 emits classifications, not
--                                    decisions; Pass 2 makes the decisions.
--   shortlisting_quarantine       ← out-of-scope flagged compositions
--                                    (agent headshots, test shots, BTS, etc.;
--                                    spec §4 step 0.7).
--
-- composition_groups holds the canonical "one composition per scene" row.
-- Pass 0 writes it: after enumerating RAWs and clustering by AEBBracketValue
-- (spec §4 step 0.3), we emit one row per group of 1-5 brackets. The
-- best_bracket_stem is luminance-selected (target 118/255, spec §4 step 0.4)
-- and is what the vision API sees. The delivery_reference_stem is the
-- AEB=-2.667 stem the editor uses as the canonical filename downstream.
--
-- composition_classifications holds Pass 1 output (one row per group). Pass 1
-- is reasoning-first (spec §5 step 1.1): the LLM writes a full analysis
-- paragraph, then emits structured fields (room_type, vantage_point, scores,
-- key_elements, etc.). NO shortlisting decisions are made here; Pass 2 reads
-- these classifications and decides.
--
-- shortlisting_quarantine is the out-of-scope bucket. Pre-classification
-- rejections (Pass 0 cull, spec §4 step 0.6) may have a NULL group_id.
-- Post-classification quarantine carries the group_id. requires_human_review
-- defaults TRUE so an editor sees and signs off before final delivery.
--
-- RLS: master_admin/admin/manager/employee full; contractor scoped via
-- my_project_ids() (mirrors mig 225). Quarantine inherits the same.

-- ============================================================================
-- 1. composition_groups
-- ============================================================================

CREATE TABLE IF NOT EXISTS composition_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  group_index INT NOT NULL,                 -- ordering within round (0-based)
  files_in_group TEXT[] NOT NULL,           -- RAW filenames in this composition group
  file_count INT NOT NULL,
  best_bracket_stem TEXT,                   -- luminance-selected (spec §4 step 0.4)
  delivery_reference_stem TEXT,             -- AEB=-2.667 stem (editor's filename)
  all_bracket_luminances NUMERIC[],         -- all luminance values in group
  selected_bracket_luminance NUMERIC,       -- luminance of the selected bracket
  is_micro_adjustment_split BOOLEAN NOT NULL DEFAULT FALSE,
  dropbox_preview_path TEXT,                -- 1024px JPEG preview path
  preview_size_kb INT,
  exif_metadata JSONB,                      -- captured at Pass 0 (spec §4 step 0.2)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT composition_groups_unique_index_per_round
    UNIQUE (round_id, group_index)
);

CREATE INDEX IF NOT EXISTS idx_composition_groups_project
  ON composition_groups(project_id);
CREATE INDEX IF NOT EXISTS idx_composition_groups_round
  ON composition_groups(round_id);
CREATE INDEX IF NOT EXISTS idx_composition_groups_round_index
  ON composition_groups(round_id, group_index);

COMMENT ON TABLE composition_groups IS
  'Pass 0 output: one row per clustered composition group (1-5 brackets per spec §4 step 0.3). Spec called this bracket_groups; renamed because future inputs may be multi-camera or non-bracketed. best_bracket_stem is the luminance-selected vision input; delivery_reference_stem is the editor''s canonical filename (AEB=-2.667).';
COMMENT ON COLUMN composition_groups.is_micro_adjustment_split IS
  'TRUE when the original group exceeded the 5-shot ceiling and was split (spec L1 lesson + §4 step 0.3).';
COMMENT ON COLUMN composition_groups.delivery_reference_stem IS
  'Editor-conventional stem (AEB=-2.667). Used as the canonical filename through downstream lanes; first bracket is the reference (spec L2 lesson).';

ALTER TABLE composition_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "composition_groups_read" ON composition_groups FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "composition_groups_insert" ON composition_groups FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "composition_groups_update" ON composition_groups FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "composition_groups_delete_owner_only" ON composition_groups FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 2. composition_classifications (Pass 1 output)
-- ============================================================================

CREATE TABLE IF NOT EXISTS composition_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES composition_groups(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Reasoning-first analysis (spec §5 step 1.1, L9 lesson)
  analysis TEXT,                            -- full reasoning paragraph
  -- Room / composition / vantage classification
  room_type TEXT,
  room_type_confidence NUMERIC(4,3),
  composition_type TEXT,
  vantage_point TEXT CHECK (vantage_point IS NULL OR vantage_point IN (
    'interior_looking_out','exterior_looking_in','neutral'
  )),
  time_of_day TEXT,                         -- day | dusk | night | unknown
  is_drone BOOLEAN NOT NULL DEFAULT FALSE,
  is_exterior BOOLEAN NOT NULL DEFAULT FALSE,
  is_detail_shot BOOLEAN NOT NULL DEFAULT FALSE,
  zones_visible TEXT[],
  key_elements TEXT[],
  is_styled BOOLEAN,
  indoor_outdoor_visible BOOLEAN,
  -- Clutter grading (spec L10 lesson — flag vs reject)
  clutter_severity TEXT CHECK (clutter_severity IS NULL OR clutter_severity IN (
    'none','minor_photoshoppable','moderate_retouch','major_reject'
  )),
  clutter_detail TEXT,
  flag_for_retouching BOOLEAN NOT NULL DEFAULT FALSE,
  -- Four-dimension scoring (spec §9, scores anchored by Stream B per spec §10)
  technical_score NUMERIC(4,2),
  lighting_score NUMERIC(4,2),
  composition_score NUMERIC(4,2),
  aesthetic_score NUMERIC(4,2),
  combined_score NUMERIC(4,2),
  -- Eligibility flags / dedup hints
  eligible_for_exterior_rear BOOLEAN NOT NULL DEFAULT FALSE,
  is_near_duplicate_candidate BOOLEAN NOT NULL DEFAULT FALSE,
  -- Provenance
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_version TEXT,                       -- e.g. 'sonnet-4-5-20251201'
  CONSTRAINT composition_classifications_unique_per_group
    UNIQUE (group_id)
);

CREATE INDEX IF NOT EXISTS idx_composition_classifications_round
  ON composition_classifications(round_id);
CREATE INDEX IF NOT EXISTS idx_composition_classifications_project
  ON composition_classifications(project_id);
CREATE INDEX IF NOT EXISTS idx_composition_classifications_group
  ON composition_classifications(group_id);
CREATE INDEX IF NOT EXISTS idx_composition_classifications_room_type
  ON composition_classifications(room_type);
CREATE INDEX IF NOT EXISTS idx_composition_classifications_flag_retouch
  ON composition_classifications(flag_for_retouching) WHERE flag_for_retouching = TRUE;

COMMENT ON TABLE composition_classifications IS
  'Pass 1 output: one row per composition_groups row. Reasoning-first (analysis paragraph emitted before scores per spec L9). NO shortlisting decisions in this pass — Pass 2 reads these and decides. Spec §5.';
COMMENT ON COLUMN composition_classifications.vantage_point IS
  'interior_looking_out (e.g. living room with view to garden), exterior_looking_in (e.g. alfresco shot looking back at house), or neutral. Drives exterior_rear eligibility (spec §12 boundary rules).';
COMMENT ON COLUMN composition_classifications.eligible_for_exterior_rear IS
  'TRUE when room_type=alfresco AND vantage_point=exterior_looking_in (spec §12 boundary rule). Pre-computed at Pass 1 for fast Pass 2 routing.';
COMMENT ON COLUMN composition_classifications.combined_score IS
  'Weighted blend of technical/lighting/composition/aesthetic per current shortlisting_signal_weights config (spec §9).';

ALTER TABLE composition_classifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "composition_classifications_read" ON composition_classifications FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "composition_classifications_insert" ON composition_classifications FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "composition_classifications_update" ON composition_classifications FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "composition_classifications_delete_owner_only" ON composition_classifications FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 3. shortlisting_quarantine
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- group_id MAY be NULL when quarantined pre-classification (Pass 0 cull or
  -- pre-grouping detection of agent headshots etc.).
  group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  file_stem TEXT,
  reason TEXT NOT NULL CHECK (reason IN (
    'agent_headshot','test_shot','bts','other'
  )),
  reason_detail TEXT,
  confidence NUMERIC(4,3),
  requires_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shortlisting_quarantine_round
  ON shortlisting_quarantine(round_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_quarantine_project
  ON shortlisting_quarantine(project_id);
CREATE INDEX IF NOT EXISTS idx_shortlisting_quarantine_unresolved
  ON shortlisting_quarantine(project_id, created_at DESC) WHERE resolved = FALSE;

COMMENT ON TABLE shortlisting_quarantine IS
  'Out-of-scope flagged compositions (agent headshots, test shots, BTS, other). Pre-classification rows may have NULL group_id. Spec §4 step 0.7.';

ALTER TABLE shortlisting_quarantine ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shortlisting_quarantine_read" ON shortlisting_quarantine FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_quarantine_insert" ON shortlisting_quarantine FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_quarantine_update" ON shortlisting_quarantine FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_quarantine_delete_owner_only" ON shortlisting_quarantine FOR DELETE
  USING (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

-- Wave 6 P1 SHORTLIST: mig 287: shortlisting_training_examples
--
-- Training corpus for few-shot injection into Pass 1/2 prompts. Every
-- confirmed human selection is stored here, with the analysis paragraph,
-- key elements, and zones visible captured at the time of confirmation.
-- The learning loop reads this table during prompt construction. Spec §14.
--
-- Key principles (per spec §14):
--   - composition_group_id is the canonical identifier — NOT a filename.
--   - delivery_reference_stem is the editor-conventional name (AEB=-2.667).
--   - variant_count is a critical signal: editors who deliver 3 finals
--     variants of the same composition are signalling "this is essential".
--     The training weight tracks: weight = 1.0 base + 0.2 per additional
--     variant + 0.3 if was_override.
--   - training_grade is a curator-set flag for "this is a high-quality
--     example to feed the model" (set in a Phase 5 admin tool).
--   - excluded is a short-circuit kill switch (e.g. discovered the editor
--     made an error post-hoc; mark excluded to remove from prompt corpus
--     without deleting the row).
--
-- RLS: master_admin/admin/manager/employee read; only master_admin/admin
-- can grade/exclude (these decisions affect training quality).

CREATE TABLE IF NOT EXISTS shortlisting_training_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  composition_group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  delivery_reference_stem TEXT,                -- AEB=-2.667 stem
  variant_count INT NOT NULL DEFAULT 1,
  slot_id TEXT,
  package_type TEXT,
  project_tier TEXT CHECK (project_tier IS NULL OR project_tier IN ('standard','premium')),
  -- Scores at time of confirmation
  human_confirmed_score NUMERIC(4,2),
  ai_proposed_score NUMERIC(4,2),
  was_override BOOLEAN NOT NULL DEFAULT FALSE,
  -- Rich context for few-shot injection
  analysis TEXT,                               -- Pass 1 analysis paragraph
  key_elements TEXT[],
  zones_visible TEXT[],
  composition_type TEXT,
  room_type TEXT,
  -- Training weight (spec §14: 1.0 base + 0.2 per add'l variant + 0.3 if override)
  weight NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  -- Curator gates
  training_grade BOOLEAN NOT NULL DEFAULT FALSE,
  excluded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_examples_slot
  ON shortlisting_training_examples(slot_id) WHERE excluded = FALSE;
CREATE INDEX IF NOT EXISTS idx_training_examples_room
  ON shortlisting_training_examples(room_type) WHERE excluded = FALSE;
CREATE INDEX IF NOT EXISTS idx_training_examples_graded
  ON shortlisting_training_examples(slot_id, weight DESC)
  WHERE training_grade = TRUE AND excluded = FALSE;
CREATE INDEX IF NOT EXISTS idx_training_examples_group
  ON shortlisting_training_examples(composition_group_id);

COMMENT ON TABLE shortlisting_training_examples IS
  'Training corpus for few-shot injection into Pass 1/2 prompts. composition_group_id is the canonical identifier (not filename). variant_count + was_override drive weight. training_grade flagged by Phase 5 curator tool. excluded is a kill switch. Spec §14.';
COMMENT ON COLUMN shortlisting_training_examples.weight IS
  'Spec §14 formula: 1.0 base + 0.2 per additional variant + 0.3 if was_override. Curator can override directly.';
COMMENT ON COLUMN shortlisting_training_examples.training_grade IS
  'TRUE = curator-promoted high-quality example. Few-shot prompt construction should prefer training_grade=TRUE rows.';
COMMENT ON COLUMN shortlisting_training_examples.excluded IS
  'TRUE = remove from prompt corpus without deleting the row (preserves audit lineage).';

ALTER TABLE shortlisting_training_examples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "training_examples_read" ON shortlisting_training_examples FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "training_examples_insert" ON shortlisting_training_examples FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));
-- Update gated tighter: only admins can flip training_grade / excluded
CREATE POLICY "training_examples_update" ON shortlisting_training_examples FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "training_examples_delete" ON shortlisting_training_examples FOR DELETE
  USING (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

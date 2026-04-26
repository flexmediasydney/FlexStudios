-- Wave 6 P-burst-1 G2: add `phase` column to shortlisting_training_examples
-- so few-shot training data can distinguish phase-1 mandatory winners from
-- phase-2 conditional fills from phase-3 free recommendations. Without this,
-- the extractor was emitting NULL slot_id for phase-3 recs (correct per spec
-- — phase 3 has no slot) but losing the qualitative phase signal entirely.
--
-- Values: 1 (mandatory), 2 (conditional), 3 (free rec). NULL legacy / unknown.

ALTER TABLE shortlisting_training_examples
  ADD COLUMN IF NOT EXISTS phase INTEGER CHECK (phase IS NULL OR phase IN (1, 2, 3));

COMMENT ON COLUMN shortlisting_training_examples.phase IS
  'Pass 2 phase for this composition: 1=mandatory slot winner, 2=conditional slot winner, 3=phase-3 free recommendation. Distinguishes signal quality for ML training. NULL for legacy/unknown.';

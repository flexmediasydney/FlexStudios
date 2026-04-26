-- Wave 6 P-audit-fix-2 Class D: mig 329: slot_definitions UNIQUE(slot_id) WHERE is_active
--
-- Audit defect #25 (P1): the existing UNIQUE(slot_id, version) constraint
-- prevents duplicates per (slot_id, version), but it does NOT prevent two
-- DIFFERENT versions of the same slot_id being marked is_active=TRUE
-- simultaneously. With multiple active rows for the same slot_id, Pass 2's
-- fetchSlotDefinitions returns both — the prompt then has duplicate slot
-- definitions and the Sonnet output is non-deterministic.
--
-- Mitigation: partial unique index on (slot_id) WHERE is_active=TRUE.
-- Forces admins to flip the OLD active row to is_active=FALSE before flipping
-- the new one to TRUE. The shortlisting_signal_weights and stream_b_anchors
-- tables have the same risk; covered separately if needed (Pass 1 already
-- de-dupes by max(version) per tier in streamBInjector).
--
-- Pre-flight: SELECT slot_id, COUNT(*) WHERE is_active=TRUE GROUP BY slot_id
-- HAVING COUNT(*) > 1 → returned 0 rows on prod, so this index applies cleanly.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_slot_definitions_active_slot
  ON shortlisting_slot_definitions (slot_id)
  WHERE is_active = TRUE;

COMMENT ON INDEX uniq_slot_definitions_active_slot IS
  'Wave 6 P-audit-fix-2 #25: at most one active row per slot_id. Pass 2 fetchSlotDefinitions filters by is_active; without this index, two active rows for the same slot_id duplicate slot definitions in the prompt.';

NOTIFY pgrst, 'reload schema';

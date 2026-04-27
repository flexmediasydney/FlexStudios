-- Wave 10.3 P1-16: shortlisting_overrides gains alternative_offered_drawer_seen
--
-- Mig 285 already created `alternative_offered`, `alternative_selected`,
-- `review_duration_seconds`, and `primary_signal_overridden`. This migration
-- adds ONE evidence-audit column so the analytics layer can distinguish two
-- previously-conflated states:
--
--   alternative_offered=TRUE  + drawer_seen=FALSE → alts existed but the
--                                                   editor never opened the
--                                                   drawer (passive ignore)
--   alternative_offered=TRUE  + drawer_seen=TRUE  → editor actively viewed
--                                                   the alternatives and
--                                                   dragged anyway (active
--                                                   reject)
--
-- Wave 8's tier-weight tuning + Wave 13a's training extraction both want the
-- second signal — "editor saw alts and rejected them" is a much stronger
-- training input than "alts were rendered somewhere on the screen". The
-- swimlane (W10.3 frontend instrumentation) tracks per-slot drawer-open via
-- the seenAltsBySlotId Set; this column persists that observation.
--
-- All four columns from mig 285 (`review_duration_seconds`,
-- `alternative_offered`, `alternative_selected`, `primary_signal_overridden`)
-- are unchanged by this migration — they keep their existing semantics; W10.3
-- only adds richer wiring on the swimlane that writes them.
--
-- Rollback (manual; only if migration breaks production):
--   ALTER TABLE shortlisting_overrides DROP COLUMN IF EXISTS alternative_offered_drawer_seen;

ALTER TABLE shortlisting_overrides
  ADD COLUMN IF NOT EXISTS alternative_offered_drawer_seen BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN shortlisting_overrides.alternative_offered_drawer_seen IS
  'Wave 10.3 P1-16: TRUE only when the editor actually opened the alternatives '
  'drawer for this slot in this review session. Distinguishes "alts existed but '
  'editor ignored them" from "alts existed and editor rejected them". Required '
  'by Wave 8 tier-weight tuning + Wave 13a training extraction.';

COMMENT ON COLUMN shortlisting_overrides.alternative_offered IS
  'Wave 6 + Wave 10.3 P1-16: TRUE when Pass 2 emitted alternatives for this '
  'slot AND the swimlane rendered the drawer (collapsed or open). For "drawer '
  'open with editor actually browsing", use alternative_offered_drawer_seen.';

-- Optional backfill: if alternative_selected=TRUE the drawer was definitionally
-- visible (the editor clicked an alt). Conservative — touches only rows where
-- the tighter signal is unambiguous.
UPDATE shortlisting_overrides
SET alternative_offered_drawer_seen = TRUE
WHERE alternative_selected = TRUE
  AND alternative_offered_drawer_seen = FALSE;

NOTIFY pgrst, 'reload schema';

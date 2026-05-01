-- Migration 395 — Wave 11.6.7 P1-5: eligible_composition_types +
-- same_room_as_slot on shortlisting_slot_definitions.
--
-- Origin: docs/WAVE_7_BACKLOG.md L221-235. Joseph wanted "slot 1 = compressed
-- kitchen, slot 2 = wide kitchen of same room". Today's slot model can't
-- enforce same-room linkage between distinct slots OR composition_type
-- restriction.
--
-- Adds:
--   - shortlisting_slot_definitions.eligible_composition_types TEXT[] NULL
--     Empty/NULL means any composition_type is acceptable. Non-empty list
--     restricts: Stage 4 slot validator rejects decisions whose winner's
--     `composition_type` is NOT in this list.
--   - shortlisting_slot_definitions.same_room_as_slot UUID NULL
--     FK to another row in this table. When set, the winner of THIS slot
--     must come from the same `composition_groups.room_type` as the winner
--     of the linked slot (e.g. bathroom_detail must match the same physical
--     room as bathroom_main).
--
-- FK is intentionally `ON DELETE SET NULL` — deleting a referenced "anchor"
-- slot shouldn't kill its dependents; they revert to "any room" and admins
-- get to decide whether to delete or rewire.

BEGIN;

ALTER TABLE public.shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS eligible_composition_types TEXT[];

COMMENT ON COLUMN public.shortlisting_slot_definitions.eligible_composition_types IS
  'Wave 11.6.7 P1-5: when non-empty, Stage 4 slot validator rejects decisions whose winner''s composition_type is NOT in this list. NULL/empty = any composition_type accepted.';

ALTER TABLE public.shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS same_room_as_slot UUID
  REFERENCES public.shortlisting_slot_definitions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.shortlisting_slot_definitions.same_room_as_slot IS
  'Wave 11.6.7 P1-5: optional FK to another slot. When set, Stage 4 enforces that the winner of THIS slot has the same composition_groups.room_type as the winner of the linked slot. Use case: bathroom_detail must match the same physical room as bathroom_main.';

CREATE INDEX IF NOT EXISTS idx_slot_definitions_same_room_link
  ON public.shortlisting_slot_definitions (same_room_as_slot)
  WHERE same_room_as_slot IS NOT NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 392 — Wave 11.6.15: slot_fit_score on shortlisting_overrides
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Background:
--   Joseph's IMG_034A7961 (entry_foyer) investigation revealed that Stage 4
--   sometimes picks the LOWEST combined_score winner over higher-scored
--   alternatives because of "slot fit" reasoning (e.g. a 6.05 corner shot
--   that captures the foyer-as-subject vs an 8.50 threshold shot looking
--   through). The picking is editorially correct, but invisible to operators:
--   Stage 4's rationale claims "strongest of the series" which CONTRADICTS
--   the actual scores in the database.
--
--   The fix surfaces a SEPARATE, Stage-4-self-reported score per slot
--   decision — distinct from the per-image quality scores — so operators
--   can see WHEN slot-fit overrides raw quality and disagree if the
--   slot-fit reasoning is bogus.
--
-- Schema change:
--   ALTER shortlisting_overrides ADD slot_fit_score NUMERIC(3,1).
--   Nullable: legacy rows (pre-W11.6.15 rounds) and ai_recommended Phase 3
--   rows that don't fill a canonical slot may legitimately have NULL.
--   Range expected 0.0–10.0 (mirrors the per-image quality 0–10 scale).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE shortlisting_overrides
  ADD COLUMN slot_fit_score NUMERIC(3,1);

COMMENT ON COLUMN shortlisting_overrides.slot_fit_score IS 'Stage 4 self-reported (0-10): how well this image fits the slot''s compositional intent, separate from per-image quality scores. Allows transparent slot-vs-quality trade-off decisions.';

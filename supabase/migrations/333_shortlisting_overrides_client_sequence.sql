-- Wave 6 P-burst-4 J1: client_sequence on shortlisting_overrides for stable
-- ordering of fast-emitted drag events. Network jitter between client and
-- Supabase can flip the arrival order of two POSTs emitted within milliseconds
-- of each other; the swimlane records a monotonic per-tab counter that
-- shortlist-lock and any future override consumers prefer over created_at
-- when both are present. NULL on legacy rows is fine — those callers fall
-- back to created_at.

ALTER TABLE shortlisting_overrides
  ADD COLUMN IF NOT EXISTS client_sequence INTEGER;

CREATE INDEX IF NOT EXISTS idx_shortlisting_overrides_round_seq
  ON shortlisting_overrides(round_id, client_sequence)
  WHERE client_sequence IS NOT NULL;

COMMENT ON COLUMN shortlisting_overrides.client_sequence IS
  'Monotonic per-browser-tab sequence number assigned by the swimlane at drag time. Used by shortlist-lock to resolve override ordering when two POSTs land at the DB in different order than the client emitted them. NULL = legacy event, fall back to created_at.';

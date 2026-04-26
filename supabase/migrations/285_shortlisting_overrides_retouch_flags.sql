-- Wave 6 P1 SHORTLIST: mig 285: shortlisting_overrides + shortlisting_retouch_flags
--
-- Two tables that capture the human review surface of the shortlisting
-- engine. Both are populated post-Pass 2 — overrides by the swimlane UI on
-- drag/drop, retouch_flags by Pass 3 surfacing classifications with
-- clutter_severity != 'none'.
--
-- shortlisting_overrides — every human action is an override event. Every
-- "approved as-is" click is also recorded so the learning loop has both
-- positive and negative signal. Spec §14.
--   - ai_proposed_*: what Pass 2 emitted
--   - human_*: what the editor confirmed (or didn't)
--   - human_action: approved_as_proposed | removed | swapped | added_from_rejects
--   - override_reason: quality_preference | client_instruction | coverage_adjustment | error_correction
--   - confirmed_with_review: TRUE if review_duration_seconds > 30s
--     (under 30s = flagged as unverified, won't enter training set)
--   - alternative_offered / alternative_selected: did the swimlane show the
--     top-3 alternatives tray for this slot, and did the editor pick one?
--   - variant_count: how many finals variants did the editor deliver for
--     this composition (signal of importance — more variants = higher weight)
--
-- shortlisting_retouch_flags — Pass 3 surfaces classifications with
-- clutter_severity in (minor_photoshoppable, moderate_retouch). The editor
-- resolves them in the swimlane (mark fixed, defer, reject). Spec §16.
--
-- RLS: master_admin/admin/manager/employee full; contractor scoped via
-- my_project_ids().

-- ============================================================================
-- 1. shortlisting_overrides
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,

  -- What AI proposed
  ai_proposed_group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  ai_proposed_slot_id TEXT,
  ai_proposed_score NUMERIC(4,2),
  ai_proposed_analysis TEXT,

  -- What human did (action verb describing the edit, NOT NULL — every event
  -- has an action even if it's 'approved_as_proposed')
  human_action TEXT NOT NULL CHECK (human_action IN (
    'approved_as_proposed','removed','swapped','added_from_rejects'
  )),
  human_selected_group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  human_selected_slot_id TEXT,

  -- Override context
  override_reason TEXT CHECK (override_reason IS NULL OR override_reason IN (
    'quality_preference','client_instruction','coverage_adjustment','error_correction'
  )),
  override_note TEXT,
  slot_group_id TEXT,
  project_tier TEXT CHECK (project_tier IS NULL OR project_tier IN ('standard','premium')),
  primary_signal_overridden TEXT,

  -- Training validity
  review_duration_seconds INT,
  confirmed_with_review BOOLEAN NOT NULL DEFAULT TRUE,

  -- v2 learning signals (spec §14)
  variant_count INT,
  alternative_offered BOOLEAN NOT NULL DEFAULT FALSE,
  alternative_selected BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Spec §16 explicitly calls these out
CREATE INDEX IF NOT EXISTS idx_overrides_slot_group
  ON shortlisting_overrides(slot_group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_overrides_signal
  ON shortlisting_overrides(primary_signal_overridden);
CREATE INDEX IF NOT EXISTS idx_overrides_round
  ON shortlisting_overrides(round_id);
CREATE INDEX IF NOT EXISTS idx_overrides_project
  ON shortlisting_overrides(project_id);

COMMENT ON TABLE shortlisting_overrides IS
  'Every human drag/drop interaction with the swimlane review UI. Both approvals and edits are recorded. confirmed_with_review=FALSE if review_duration_seconds <= 30s (flagged as unverified, excluded from training). Spec §14 + §16.';
COMMENT ON COLUMN shortlisting_overrides.alternative_offered IS
  'TRUE if Pass 2 emitted top-3 alternatives for this slot AND the swimlane showed them in the alternatives tray.';
COMMENT ON COLUMN shortlisting_overrides.variant_count IS
  'How many finals variants did the editor deliver for this composition? Higher = stronger training weight (spec L15 lesson).';

ALTER TABLE shortlisting_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shortlisting_overrides_read" ON shortlisting_overrides FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_overrides_insert" ON shortlisting_overrides FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_overrides_update" ON shortlisting_overrides FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_overrides_delete_owner_only" ON shortlisting_overrides FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 2. shortlisting_retouch_flags
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_retouch_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  file_stem TEXT,
  clutter_severity TEXT NOT NULL CHECK (clutter_severity IN (
    'none','minor_photoshoppable','moderate_retouch','major_reject'
  )),
  clutter_detail TEXT,
  is_shortlisted BOOLEAN NOT NULL DEFAULT FALSE,
  -- Resolution tracking
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retouch_flags_round
  ON shortlisting_retouch_flags(round_id);
CREATE INDEX IF NOT EXISTS idx_retouch_flags_project
  ON shortlisting_retouch_flags(project_id);
CREATE INDEX IF NOT EXISTS idx_retouch_flags_unresolved_shortlisted
  ON shortlisting_retouch_flags(project_id, created_at DESC)
  WHERE resolved = FALSE AND is_shortlisted = TRUE;

COMMENT ON TABLE shortlisting_retouch_flags IS
  'Pass 3 surfaces compositions with clutter_severity in (minor_photoshoppable, moderate_retouch). Editor resolves in swimlane. Spec §16. is_shortlisted is TRUE for flags on the proposed/locked shortlist (high priority); FALSE for rejects (informational).';

ALTER TABLE shortlisting_retouch_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shortlisting_retouch_flags_read" ON shortlisting_retouch_flags FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_retouch_flags_insert" ON shortlisting_retouch_flags FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_retouch_flags_update" ON shortlisting_retouch_flags FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "shortlisting_retouch_flags_delete_owner_only" ON shortlisting_retouch_flags FOR DELETE
  USING (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';

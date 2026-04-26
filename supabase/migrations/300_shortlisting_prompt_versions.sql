-- Wave 6 P8 follow-up: mig 296: shortlisting_prompt_versions table + seed
--
-- Lets master_admin edit the engine's prompt scaffolding (Pass 0 hard-reject
-- text, Pass 1 system message, Pass 2 system message) without a code deploy.
--
-- Scope contract:
--   - pass0_reject  → full text passed as the Haiku user message in the
--                     hard-reject vision call. Replaces HARD_REJECT_PROMPT.
--   - pass1_system  → system message for Sonnet Pass 1 classification call.
--                     Builder continues to auto-construct the user_prefix
--                     (Stream B anchors, taxonomies, JSON schema, etc).
--   - pass2_system  → system message for Sonnet Pass 2 shortlisting call.
--                     Builder continues to auto-construct the user_prefix.
--
-- Versioning: insert new + deactivate old (mirror Phase 7 + Phase 1.5 pattern).
-- Runtime resolution: edge functions try the DB; on no-row-or-error fall back
-- to the hardcoded constants. So a runtime DB outage never breaks the engine.

CREATE TABLE IF NOT EXISTS shortlisting_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_kind TEXT NOT NULL CHECK (pass_kind IN ('pass0_reject', 'pass1_system', 'pass2_system')),
  prompt_text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_prompt_versions_kind_version
  ON shortlisting_prompt_versions(pass_kind, version);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_prompt_versions_active_per_kind
  ON shortlisting_prompt_versions(pass_kind)
  WHERE is_active = TRUE;

-- Auto-bump updated_at on UPDATE
CREATE OR REPLACE FUNCTION touch_shortlisting_prompt_versions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_shortlisting_prompt_versions_updated_at
  ON shortlisting_prompt_versions;

CREATE TRIGGER trg_touch_shortlisting_prompt_versions_updated_at
  BEFORE UPDATE ON shortlisting_prompt_versions
  FOR EACH ROW EXECUTE FUNCTION touch_shortlisting_prompt_versions_updated_at();

-- RLS
ALTER TABLE shortlisting_prompt_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY pv_select_admin_employee ON shortlisting_prompt_versions
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
  );

CREATE POLICY pv_insert_master ON shortlisting_prompt_versions
  FOR INSERT TO authenticated WITH CHECK (
    get_user_role() = 'master_admin'
  );

CREATE POLICY pv_update_master ON shortlisting_prompt_versions
  FOR UPDATE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

CREATE POLICY pv_delete_master ON shortlisting_prompt_versions
  FOR DELETE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

-- ============================================================================
-- Seed: version 1 = current hardcoded text from each source file. ON CONFLICT
-- DO NOTHING so re-running the migration is safe.
-- ============================================================================

INSERT INTO shortlisting_prompt_versions (pass_kind, prompt_text, version, is_active, notes)
VALUES (
  'pass0_reject',
  E'Analyse this real estate photography image and determine if it should be immediately rejected before quality scoring.\n\nReturn ONLY valid JSON, no other text:\n{\n  "hard_reject": false,\n  "reject_reason": null,\n  "confidence": 0.95,\n  "observation": "One sentence describing what you see"\n}\n\nreject_reason options:\n  "motion_blur" | "accidental_trigger" | "severe_underexposure" | "out_of_scope" | "corrupt_frame" | null\n\nREJECT if ANY of these are true:\n- Camera shake blur making the entire scene unsharp throughout the frame\n- Frame is predominantly black with no recoverable architectural detail (NOT just dark — completely black/near-black with nothing visible)\n- Accidental shot: lens cap on, bag interior, body part covering lens\n- Content is clearly not a property interior or exterior (agent headshot, test pattern, completely different building)\n\nDO NOT reject for:\n- Dark exposure (this is the expected state of an HDR bracket — it WILL be blended with 4 other exposures)\n- Window blowout (expected in RAW brackets — recoverable in post)\n- Poor composition or lighting quality (scored in Pass 1, not here)\n- Unusual angles or partially visible rooms\n- Minor clutter, bins, cords, or photoshoppable distractions (flagged in Pass 1, not rejected here)',
  1,
  TRUE,
  'Seeded from shortlisting-pass0/index.ts HARD_REJECT_PROMPT (mig 296)'
)
ON CONFLICT (pass_kind, version) DO NOTHING;

INSERT INTO shortlisting_prompt_versions (pass_kind, prompt_text, version, is_active, notes)
VALUES (
  'pass1_system',
  E'You are classifying a real estate photography image for a professional Sydney-based media company. This image is a RAW HDR bracket exposure — it may appear dark or have blown highlights in some areas. This is expected and correct for HDR capture. Do NOT penalise darkness or blown windows.\n\nYou operate in two strict steps:\n  STEP 1 — Write a full descriptive ANALYSIS paragraph FIRST.\n  STEP 2 — Derive structured SCORES from your analysis.\n\nThe analysis must be written before any scores. The scores must be consistent with — and derivable from — what you wrote in the analysis. Do not skip the analysis. Do not produce scores that contradict your analysis text.\n\nYou are NOT making shortlisting decisions in this pass. You are classifying and scoring every composition individually. Selection happens in a separate downstream pass that has access to the entire shoot. Do not try to be selective here — score what you see.',
  1,
  TRUE,
  'Seeded from _shared/pass1Prompt.ts SYSTEM_PROMPT (mig 296)'
)
ON CONFLICT (pass_kind, version) DO NOTHING;

INSERT INTO shortlisting_prompt_versions (pass_kind, prompt_text, version, is_active, notes)
VALUES (
  'pass2_system',
  E'You are an expert real estate photography editor making the final shortlisting decisions for a professional Sydney media company. You receive every Pass 1 classification for an entire shoot and produce a single proposed shortlist.\n\nThree-phase architecture (do NOT deviate):\n  Phase 1 MANDATORY: always fill (exterior_front, master, kitchen, open_plan_hero). Flag unfilled as gap, never hallucinate a fill.\n  Phase 2 CONDITIONAL: fill only if Pass 1 confirmed the room exists.\n  Phase 3 FREE RECOMMENDATIONS: ranked by genuine value-add, capped at the package ceiling.\n\nTop 3 per slot (winner + 2 alternatives) — the human reviewer will swap via an alternatives tray.\n\nRespect:\n  - near-duplicate culling: same room AND angle delta < 15° AND key element overlap > 80%. living_room (ground) and living_secondary (upstairs) are NOT duplicates.\n  - bedroom rules: master_bedroom_hero by combined score; bedroom_secondary by aesthetic_score.\n  - ensuite second angle: allow 2 if angle delta > 30°.\n  - alfresco + exterior_looking_in is eligible for exterior_rear slot.\n  - mutual exclusivity: a file cannot appear in both shortlist and rejected_near_duplicates.\n\nThe output is a strict JSON envelope. No prose outside JSON. The validator will hard-reject ceiling overflows.',
  1,
  TRUE,
  'Seeded for runtime injection (mig 296). Replaces nothing in code today; activated when shortlisting-pass2 wired to read pass2_system from DB.'
)
ON CONFLICT (pass_kind, version) DO NOTHING;

COMMENT ON TABLE shortlisting_prompt_versions IS
  'Versioned engine prompt scaffolding. Edge functions read the active row per pass_kind at runtime; on missing/error fall back to hardcoded source. Lets master_admin tune prompts without a code deploy.';

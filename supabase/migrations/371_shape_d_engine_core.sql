-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 371 — Wave 11.7: Shape D shortlisting engine core
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md
--       docs/design-specs/W11-7-7-master-listing-copy.md
--       docs/design-specs/W11-7-9-master-class-prompt-enrichment.md
--
-- This migration ships the core data substrate for the Shape D 5-call
-- shortlisting architecture (W11.7). It is *additive only* — no existing
-- engine table is modified destructively; the legacy two-pass engine continues
-- to function unchanged. `engine_settings.engine_mode` toggles which
-- architecture a given round uses; default is 'two_pass' until pilot
-- validation flips it to 'shape_d'.
--
-- ─── DESIGN DECISIONS DOCUMENTED HERE ─────────────────────────────────────────
--
-- 1. master_listing storage: SEPARATE TABLE `shortlisting_master_listings`,
--    not a JSONB column on shortlisting_rounds.
--    Rationale (per W11.7.7 §"Storage choice"):
--      * Regeneration is a first-class feature in W11.7.7. The
--        regenerate-master-listing edge fn produces multiple versions of the
--        master_listing per round — a separate table with
--        regeneration_count + a sibling `_history` archive table is the
--        clean way to keep the audit trail queryable.
--      * Cross-round analytics ("what % of premium-tier listings hit the
--        reading-grade band last 30 days?") are easier to index on a
--        flat table than to GIN-extract from a JSONB column.
--      * Separate UPDATE permissions: master_admin can edit listings without
--        being granted UPDATE on shortlisting_rounds (which the dispatcher
--        also writes to in hot paths).
--      * Cost of the JOIN on round-display reads is one extra row lookup per
--        round, which is trivial at our scale (≤5 rounds per project).
--    The JSONB-column option was considered and rejected per the comparison
--    table in W11.7.7 §"Migration impact / Storage choice".
--
-- 2. Migration split: 6 files (371 + 372/373/374/375/376), not a single
--    mega-file. Rationale: each file represents an independent "minimum
--    reviewable unit" that can be applied without the others (with the noted
--    exception that 371 must apply before 372-376; see Pre-Apply Checklist in
--    this file's rollback footer). Splitting also lets Joseph review-then-
--    apply in stages if any one file surfaces concerns during review.
--
-- 3. Numbering: the W11.7 spec originally reserved "mig 349" but the live
--    migrations tree had advanced to 370 by integration time. Renumbered to
--    the next free slots 371-376. Drafts originally labelled 349/349a/b/c/d/e
--    — see git history for the diff trail back to the design-spec text.
--
-- ─── WHAT SHIPS HERE ──────────────────────────────────────────────────────────
--   1. engine_settings rows for Shape D (engine_mode, vendor selection,
--      thinking budgets, max-output-token caps, master_class prompt toggle,
--      voice_tier_default).
--   2. shortlisting_rounds.engine_mode column — captures which architecture
--      produced each round, for replay reproducibility.
--   3. shortlisting_master_listings table + W11.7.7 columns +
--      shortlisting_master_listings_history archive table +
--      shortlisting_master_listings_human_edits audit table.
--   4. engine_fewshot_examples table (renamed from pass1_fewshot_examples per
--      W11.7 §"Few-shot library"; rename is implemented as a NEW table —
--      pass1_fewshot_examples doesn't exist in production today, so there's
--      nothing to dual-write against).
--   5. shortlisting_stage4_overrides table — Stage 4's audit trail when its
--      visual cross-comparison corrects Stage 1.
--   6. RLS:
--        * master_listings + history + human_edits + stage4_overrides:
--            SELECT to master_admin + admin; UPDATE to master_admin;
--            INSERT/DELETE service-role only (edge fns).
--        * engine_fewshot_examples:
--            SELECT to master_admin + admin; UPDATE to master_admin;
--            INSERT/DELETE service-role only (curation runs as service role).
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. engine_settings rows (Shape D) ───────────────────────────────────────
-- engine_settings table itself was created in mig 339 (W7.7). Use UPSERT-style
-- INSERT with ON CONFLICT DO NOTHING so re-running this migration is idempotent
-- and existing values survive.

INSERT INTO engine_settings (key, value, description) VALUES
  ('engine_mode',
   '"two_pass"'::jsonb,
   'Wave 11.7: which shortlisting architecture to use. "two_pass" = legacy Pass 1 + Pass 2; "shape_d" = 5-call multi-stage Gemini-anchored. Default "two_pass" for safety until pilot validation completes. master_admin flips per-project then default after Phase B pilot.'),

  ('production_vendor',
   '"google"'::jsonb,
   'Wave 11.7: primary vision vendor for Shape D. "google" (Gemini 2.5 Pro) | "anthropic" (Opus 4.7). Default google because Gemini is ~12x cheaper at scale and outperformed on exterior-orientation classification in iter-3 A/B.'),

  ('failover_vendor',
   '"anthropic"'::jsonb,
   'Wave 11.7: vendor used when production_vendor is rate-limited / down. Default "anthropic" (Opus 4.7). Set to null to disable failover and fail-fast on production_vendor outages.'),

  ('stage1_thinking_budget',
   '2048'::jsonb,
   'Wave 11.7: Gemini thinkingBudget for Stage 1 batched per-image enrichment. Range 0-8192. Set 0 to disable thinking when cost-sensitive.'),

  ('stage4_thinking_budget',
   '16384'::jsonb,
   'Wave 11.7: Gemini thinkingBudget for Stage 4 visual master synthesis. Multi-image cross-reasoning needs the headroom; default 16384.'),

  ('stage1_max_output_tokens',
   '6000'::jsonb,
   'Wave 11.7: Stage 1 maxOutputTokens cap. Range 4000-12000. Headroom for verbose per-image emissions (~50 imgs/batch × ~120 tokens each + envelope).'),

  ('stage4_max_output_tokens',
   '16000'::jsonb,
   'Wave 11.7: Stage 4 maxOutputTokens cap. Range 12000-20000. Master listing + slot decisions + dedup + gallery_sequence is verbose.'),

  ('stage1_batch_size',
   '50'::jsonb,
   'Wave 11.7: max images per Stage 1 batch call. Range 30-65. Above 65 quality degrades against Gemini''s 65K output cap.'),

  ('master_class_prompt_enabled',
   'true'::jsonb,
   'Wave 11.7.9: when true, Stage 1 + Stage 4 prompts include the master-class voice exemplars + Sydney primer block. Set false to A/B with the bare-rubric path.'),

  ('voice_tier_default',
   '"standard"'::jsonb,
   'Wave 11.7.8: default property_tier when project hasn''t explicitly picked. "premium" | "standard" | "approachable". "standard" is the safest — pretentious copy on a suburban home is a worse outcome than competent copy on a luxury home.'),

  ('fewshot_max_active',
   '20'::jsonb,
   'Wave 11.7 / W14: cap on how many engine_fewshot_examples (in_active_prompt = TRUE) get rendered into the active prompt. Beyond ~20 the model starts ignoring the tail.')

ON CONFLICT (key) DO NOTHING;

-- ─── 2. shortlisting_rounds.engine_mode + property_tier columns ──────────────
-- engine_mode is the per-round stamp captured at round-start. Captures the
-- architectural variant that produced this round, so replay paths route
-- correctly:
--   'two_pass'                  — legacy Pass 1 + Pass 2 (mig <349 default)
--   'shape_d_full'              — Shape D, all 4-5 calls succeeded
--   'shape_d_partial'           — Shape D, one Stage 1 batch failed (degraded)
--   'shape_d_textfallback'      — Shape D, Stage 4 failed; text-only fallback
--   'unified_anthropic_failover'— vendor outage → routed to Anthropic Opus 4.7
--
-- property_tier + property_voice_anchor_override are the per-round voice
-- modulation columns (W11.7.8). They are nullable here because they're
-- backfilled from projects.property_tier via a trigger in mig 372. The
-- columns live on rounds (not just projects) so historical rounds preserve
-- their original tier even if the project's default changes later.

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS engine_mode TEXT;

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS property_tier TEXT;

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS property_voice_anchor_override TEXT;

COMMENT ON COLUMN shortlisting_rounds.engine_mode IS
  'Wave 11.7: architectural variant that produced this round. '
  '"two_pass" | "shape_d_full" | "shape_d_partial" | "shape_d_textfallback" | '
  '"unified_anthropic_failover". Backfilled to "two_pass" for existing rounds. '
  'Stamped at round-start by the orchestrator; used by replay paths to route '
  'to the correct engine version.';

COMMENT ON COLUMN shortlisting_rounds.property_tier IS
  'Wave 11.7.8: voice tier for this round''s Stage 1 listing_copy + Stage 4 '
  'master_listing. "premium" | "standard" | "approachable". Copied from '
  'projects.property_tier at round-start (trigger in mig 372). Persists per '
  'round so historical rounds preserve their tier even if project default '
  'changes.';

COMMENT ON COLUMN shortlisting_rounds.property_voice_anchor_override IS
  'Wave 11.7.8: free-text rubric override that replaces the tier preset block. '
  '50-1000 chars typical; 2000 char hard cap. Forbidden patterns from the '
  'standard tier rubric still apply. Copied from projects at round-start.';

-- ─── 3. Backfill engine_mode on existing rounds ───────────────────────────────
-- Existing rounds were all produced by the two-pass legacy engine. Use a
-- batched UPDATE per MIGRATION_SAFETY.md §"Backfill in batches". With the
-- current production volume (low thousands of rounds) a single UPDATE is fine,
-- but the batch loop is the safe pattern.

DO $$
DECLARE
  batch_size CONSTANT INT := 1000;
  affected INT;
BEGIN
  LOOP
    UPDATE shortlisting_rounds
       SET engine_mode = 'two_pass'
     WHERE id IN (
       SELECT id FROM shortlisting_rounds
        WHERE engine_mode IS NULL
        LIMIT batch_size
     );
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected = 0;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_shortlisting_rounds_engine_mode
  ON shortlisting_rounds(engine_mode)
  WHERE engine_mode IS NOT NULL;

-- ─── 4. shortlisting_master_listings ─────────────────────────────────────────
-- Per W11.7.7: separate table (not JSONB column on rounds) because regeneration
-- + history + cross-round analytics are first-class. UNIQUE(round_id) — one
-- active master_listing per round; history rows live in
-- shortlisting_master_listings_history.

CREATE TABLE IF NOT EXISTS shortlisting_master_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  -- Full master listing JSON shape per W11.7.7 §"Output schema". Stored as
  -- JSONB so the schema can evolve (add new derivative outputs) without DDL.
  master_listing JSONB NOT NULL,
  property_tier TEXT NOT NULL,
  voice_anchor_used TEXT,             -- 'tier_preset' | 'override' | 'master_class_enhanced'
  -- Self-reported by the model
  word_count INT,
  reading_grade_level NUMERIC,
  -- Recomputed downstream by shortlisting-quality-checks edge fn
  word_count_computed INT,
  reading_grade_level_computed NUMERIC,
  forbidden_phrase_hits TEXT[],       -- array of pattern names that fired
  quality_flags JSONB,                -- structured quality-check output
  -- Vendor + model attribution
  vendor TEXT NOT NULL,               -- 'google' | 'anthropic'
  model_version TEXT NOT NULL,
  -- Regeneration tracking (W11.7.7 §"Master_admin re-generation flow")
  regeneration_count INT NOT NULL DEFAULT 0,
  regenerated_at TIMESTAMPTZ,
  regenerated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  regeneration_reason TEXT,
  -- Soft-delete pattern (Joseph N4): we never hard-DELETE master_listings.
  -- The CASCADE FK on shortlisting_master_listings_history is dormant in
  -- practice because the parent is never DELETEd — audit trail bulletproof.
  -- "Removing" a master_listing means setting deleted_at; the partial index
  -- below keeps active-row queries fast.
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shortlisting_master_listings_round_uniq UNIQUE(round_id),
  CONSTRAINT shortlisting_master_listings_tier_chk
    CHECK (property_tier IN ('premium', 'standard', 'approachable'))
);

COMMENT ON TABLE shortlisting_master_listings IS
  'Wave 11.7.7: per-round master listing copy synthesised by Stage 4 of the '
  'Shape D engine. One active row per round; archived versions live in '
  'shortlisting_master_listings_history. Editing happens via the '
  'regenerate-master-listing edge fn (which archives the prior row to history) '
  'or via per-field human edits captured in shortlisting_master_listings_'
  'human_edits.';

COMMENT ON COLUMN shortlisting_master_listings.master_listing IS
  'Full JSON shape per W11.7.7 §"Output schema": headline, sub_headline, body '
  'paragraphs, key_features[], location_paragraph, target_buyer_summary, '
  'derivative outputs (seo_meta_description, social_post_caption, '
  'print_brochure_summary, agent_one_liner, open_home_email_blurb), and '
  'editorial metadata (word_count, reading_grade_level, tone_anchor). JSONB '
  'so the schema can evolve without DDL.';

COMMENT ON COLUMN shortlisting_master_listings.voice_anchor_used IS
  'Which voice path produced this listing: "tier_preset" (default rubric for '
  'the property_tier) | "override" (operator-supplied free-text rubric) | '
  '"master_class_enhanced" (W11.7.9 enrichment block was active).';

COMMENT ON COLUMN shortlisting_master_listings.regeneration_count IS
  'Wave 11.7.7: incremented every time regenerate-master-listing produces a '
  'new version. count=0 = original synthesis. Prior versions archived to '
  'shortlisting_master_listings_history.';

CREATE INDEX IF NOT EXISTS idx_master_listings_round
  ON shortlisting_master_listings(round_id);
CREATE INDEX IF NOT EXISTS idx_master_listings_tier
  ON shortlisting_master_listings(property_tier);
CREATE INDEX IF NOT EXISTS idx_master_listings_created
  ON shortlisting_master_listings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_master_listings_regeneration
  ON shortlisting_master_listings(regeneration_count)
  WHERE regeneration_count > 0;
-- Soft-delete pattern (Joseph N4): partial index for active rows. Read-paths
-- filter `WHERE deleted_at IS NULL`; this index serves them without bloating
-- with rare tombstoned rows.
CREATE INDEX IF NOT EXISTS idx_master_listings_active
  ON shortlisting_master_listings(round_id)
  WHERE deleted_at IS NULL;

-- ─── 5. shortlisting_master_listings_history ─────────────────────────────────
-- Audit trail for regenerations. One row per archived version. Versioned by
-- regeneration_count at the time of archiving.

CREATE TABLE IF NOT EXISTS shortlisting_master_listings_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_listing_id UUID NOT NULL REFERENCES shortlisting_master_listings(id) ON DELETE CASCADE,
  round_id UUID NOT NULL,
  master_listing JSONB NOT NULL,
  property_tier TEXT NOT NULL,
  voice_anchor_used TEXT,
  regeneration_count INT NOT NULL,    -- count at the time of archiving
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  archive_reason TEXT
);

COMMENT ON TABLE shortlisting_master_listings_history IS
  'Wave 11.7.7: archive of replaced master_listing versions. Written by the '
  'regenerate-master-listing edge fn before overwriting the active row. '
  'Queryable for "what did this listing look like before the operator '
  'regenerated it as premium tier?" use cases.';

CREATE INDEX IF NOT EXISTS idx_master_listings_history_round
  ON shortlisting_master_listings_history(round_id);
CREATE INDEX IF NOT EXISTS idx_master_listings_history_ml
  ON shortlisting_master_listings_history(master_listing_id);
CREATE INDEX IF NOT EXISTS idx_master_listings_history_archived
  ON shortlisting_master_listings_history(archived_at DESC);

-- ─── 6. shortlisting_master_listings_human_edits ─────────────────────────────
-- Per-field human edit audit trail. When an operator edits a field of the
-- master_listing in-app pre-publish, the diff lands here. Feeds W14
-- calibration as ground truth for tier-rubric tuning.

CREATE TABLE IF NOT EXISTS shortlisting_master_listings_human_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_listing_id UUID NOT NULL REFERENCES shortlisting_master_listings(id) ON DELETE CASCADE,
  field TEXT NOT NULL,                -- e.g. 'headline' | 'scene_setting_paragraph' | 'key_features'
  prior_value TEXT,                   -- stringified — JSON arrays serialised
  new_value TEXT,
  edited_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE NO ACTION,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edit_reason TEXT,
  -- Soft-delete symmetry with parent (Joseph N4). We never hard-DELETE human
  -- edit rows; the audit trail is preserved indefinitely. Set deleted_at if
  -- an edit needs to be retracted from the active view.
  deleted_at TIMESTAMPTZ NULL
);

COMMENT ON TABLE shortlisting_master_listings_human_edits IS
  'Wave 11.7.7: per-field human edit audit trail on master_listing. '
  'Operator-driven edits to the engine''s output are first-class training '
  'data for W14 tier-rubric calibration. Captured at the moment of save in '
  'the listing UI.';

CREATE INDEX IF NOT EXISTS idx_master_listings_human_edits_ml
  ON shortlisting_master_listings_human_edits(master_listing_id);
CREATE INDEX IF NOT EXISTS idx_master_listings_human_edits_user
  ON shortlisting_master_listings_human_edits(edited_by);
CREATE INDEX IF NOT EXISTS idx_master_listings_human_edits_at
  ON shortlisting_master_listings_human_edits(edited_at DESC);

-- ─── 7. engine_fewshot_examples ──────────────────────────────────────────────
-- Per W11.7 §"Few-shot library (W14)". This is the renamed
-- pass1_fewshot_examples table from the W11.5 spec. Because
-- pass1_fewshot_examples does not exist in production today (W11.5 hasn't
-- shipped), this is a fresh CREATE TABLE — no rename, no dual-write needed.
-- If W11.5's table lands first under its old name, the orchestrator should
-- coordinate naming before either ships.

CREATE TABLE IF NOT EXISTS engine_fewshot_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  example_kind TEXT NOT NULL,         -- 'room_type_correction' | 'composition_correction' | 'reject_pattern' | 'voice_exemplar'
  -- Tier + image-type filtering (NULL = applies across all tiers / image types)
  property_tier TEXT,                 -- 'premium' | 'standard' | 'approachable' | NULL
  image_type TEXT,                    -- 'interior' | 'exterior' | 'detail' | NULL
  -- Correction example fields (populated for correction-type examples)
  ai_value TEXT,
  human_value TEXT,
  evidence_keywords TEXT[],
  evidence_image_path TEXT,           -- Dropbox path to the actual image (review only; NOT bundled into prompt)
  description TEXT,
  -- Voice-exemplar fields (populated for example_kind='voice_exemplar')
  ideal_output JSONB,                 -- full JSON-shaped target output for voice exemplars
  -- Curation
  in_active_prompt BOOLEAN NOT NULL DEFAULT FALSE,
  observation_count INT NOT NULL DEFAULT 1,
  source_session_id UUID,
  curated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  curated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT engine_fewshot_examples_kind_chk
    CHECK (example_kind IN ('room_type_correction', 'composition_correction', 'reject_pattern', 'voice_exemplar')),
  CONSTRAINT engine_fewshot_examples_tier_chk
    CHECK (property_tier IS NULL OR property_tier IN ('premium', 'standard', 'approachable')),
  CONSTRAINT engine_fewshot_examples_image_type_chk
    CHECK (image_type IS NULL OR image_type IN ('interior', 'exterior', 'detail'))
);

COMMENT ON TABLE engine_fewshot_examples IS
  'Wave 11.7 / W14: empirically-grown few-shot library. Populated by W11.5 '
  'reclassifications (ai_value vs human_value) and by curated voice exemplars '
  '(ideal_output populated). Stage 1 + Stage 4 prompt assembly reads rows '
  'WHERE in_active_prompt = TRUE up to engine_settings.fewshot_max_active. '
  'property_tier + image_type filters target the right examples to the right '
  'context (premium-interior exemplar shouldn''t leak into approachable-'
  'exterior synthesis).';

COMMENT ON COLUMN engine_fewshot_examples.example_kind IS
  '"room_type_correction" — operator corrected an AI room_type label. '
  '"composition_correction" — operator corrected composition_type/vantage. '
  '"reject_pattern" — pattern of images rejected at high frequency. '
  '"voice_exemplar" — curated full-output exemplar for tier-keyed voice tuning.';

COMMENT ON COLUMN engine_fewshot_examples.in_active_prompt IS
  'TRUE = this example is currently injected into prompts. FALSE = staged for '
  'review or graduated out. W14 admin curates the active set.';

COMMENT ON COLUMN engine_fewshot_examples.ideal_output IS
  'For example_kind = "voice_exemplar": the full JSON target listing_copy or '
  'master_listing exemplar. NULL for correction-type examples.';

CREATE INDEX IF NOT EXISTS idx_fewshot_active
  ON engine_fewshot_examples(in_active_prompt)
  WHERE in_active_prompt = TRUE;
CREATE INDEX IF NOT EXISTS idx_fewshot_tier
  ON engine_fewshot_examples(property_tier)
  WHERE in_active_prompt = TRUE;
CREATE INDEX IF NOT EXISTS idx_fewshot_kind
  ON engine_fewshot_examples(example_kind);
CREATE INDEX IF NOT EXISTS idx_fewshot_image_type
  ON engine_fewshot_examples(image_type)
  WHERE image_type IS NOT NULL;

-- ─── 8. shortlisting_stage4_overrides ────────────────────────────────────────
-- Audit trail for Stage 4's visual cross-comparison corrections of Stage 1.
-- Each row captures one (round, image, field) triple where Stage 4's all-
-- images view changed Stage 1's per-image judgement. These are first-class
-- training signal for W14 graduate-quality few-shot examples.

CREATE TABLE IF NOT EXISTS shortlisting_stage4_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  -- group_id is best-effort: Stage 4 emits per-stem overrides; the dispatcher
  -- resolves stem → composition_group_id at persist time. Nullable to handle
  -- the rare case where a stem doesn't resolve (e.g. cross-batch dedup that
  -- merged a group out of existence).
  group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  stem TEXT NOT NULL,
  field TEXT NOT NULL,                -- e.g. 'room_type' | 'composition_type' | 'combined_score'
  stage_1_value TEXT,
  stage_4_value TEXT,
  reason TEXT NOT NULL,               -- model-emitted justification for the correction
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE shortlisting_stage4_overrides IS
  'Wave 11.7: audit trail for Stage 4''s visual cross-comparison corrections '
  'of Stage 1. Each row = one field on one image where Stage 4''s all-images '
  'view changed Stage 1''s call. Feed for W11.6 dashboard (Stage 4 override '
  'rate per round) and W14 graduate-quality few-shot library (high-signal '
  '"AI labelled X then visual cross-ref corrected to Y" pairs).';

COMMENT ON COLUMN shortlisting_stage4_overrides.reason IS
  'Model-emitted prose: "Visual cross-reference with IMG_6193 (clearly facade) '
  'confirms IMG_6195 sits on opposite side of building. Hills Hoist + hot-water '
  'unit in same frame. Side passage classification incorrect."';

CREATE INDEX IF NOT EXISTS idx_stage4_overrides_round
  ON shortlisting_stage4_overrides(round_id);
CREATE INDEX IF NOT EXISTS idx_stage4_overrides_group
  ON shortlisting_stage4_overrides(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stage4_overrides_field
  ON shortlisting_stage4_overrides(field);

-- ─── 9. RLS policies ─────────────────────────────────────────────────────────
-- Pattern mirrors mig 370 (vendor_shadow_runs / vendor_comparison_results):
--   * SELECT to master_admin + admin (read for review UIs)
--   * UPDATE to master_admin only (corrections to engine outputs)
--   * INSERT/DELETE to service-role only (edge fns bypass RLS via service key)
-- INSERT policy is OMITTED because no policy = denied for authenticated, and
-- service-role bypasses RLS entirely.

ALTER TABLE shortlisting_master_listings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shortlisting_master_listings_select_admin"
  ON shortlisting_master_listings;
CREATE POLICY "shortlisting_master_listings_select_admin"
  ON shortlisting_master_listings
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

DROP POLICY IF EXISTS "shortlisting_master_listings_update_master"
  ON shortlisting_master_listings;
CREATE POLICY "shortlisting_master_listings_update_master"
  ON shortlisting_master_listings
  FOR UPDATE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

ALTER TABLE shortlisting_master_listings_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shortlisting_master_listings_history_select_admin"
  ON shortlisting_master_listings_history;
CREATE POLICY "shortlisting_master_listings_history_select_admin"
  ON shortlisting_master_listings_history
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );
-- History rows are append-only — no UPDATE policy.

ALTER TABLE shortlisting_master_listings_human_edits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shortlisting_master_listings_human_edits_select_admin"
  ON shortlisting_master_listings_human_edits;
CREATE POLICY "shortlisting_master_listings_human_edits_select_admin"
  ON shortlisting_master_listings_human_edits
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );
-- Human-edit audit rows are append-only — no UPDATE policy.

ALTER TABLE engine_fewshot_examples ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "engine_fewshot_examples_select_admin"
  ON engine_fewshot_examples;
CREATE POLICY "engine_fewshot_examples_select_admin"
  ON engine_fewshot_examples
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

DROP POLICY IF EXISTS "engine_fewshot_examples_update_master"
  ON engine_fewshot_examples;
CREATE POLICY "engine_fewshot_examples_update_master"
  ON engine_fewshot_examples
  FOR UPDATE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

ALTER TABLE shortlisting_stage4_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shortlisting_stage4_overrides_select_admin"
  ON shortlisting_stage4_overrides;
CREATE POLICY "shortlisting_stage4_overrides_select_admin"
  ON shortlisting_stage4_overrides
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );
-- Stage 4 override rows are append-only — no UPDATE policy.

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- Order of operations matters — DROP TABLE statements need to remove FK-
-- bearing children first. The history + human_edits tables FK to
-- shortlisting_master_listings via ON DELETE CASCADE so dropping the parent
-- nukes them, but explicit drops are cleaner:
--
-- ALTER TABLE shortlisting_stage4_overrides DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS shortlisting_stage4_overrides;
--
-- ALTER TABLE engine_fewshot_examples DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS engine_fewshot_examples;
--
-- ALTER TABLE shortlisting_master_listings_human_edits DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS shortlisting_master_listings_human_edits;
--
-- ALTER TABLE shortlisting_master_listings_history DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS shortlisting_master_listings_history;
--
-- DROP INDEX IF EXISTS idx_master_listings_active;
-- ALTER TABLE shortlisting_master_listings DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS shortlisting_master_listings;
--
-- DROP INDEX IF EXISTS idx_shortlisting_rounds_engine_mode;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS property_voice_anchor_override;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS property_tier;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS engine_mode;
--
-- DELETE FROM engine_settings WHERE key IN (
--   'engine_mode', 'production_vendor', 'failover_vendor',
--   'stage1_thinking_budget', 'stage4_thinking_budget',
--   'stage1_max_output_tokens', 'stage4_max_output_tokens',
--   'stage1_batch_size', 'master_class_prompt_enabled',
--   'voice_tier_default', 'fewshot_max_active'
-- );
--
-- Note: dropping shortlisting_master_listings is data-lossy if any rows have
-- been written. Pre-rollback dump:
--   CREATE TABLE _rollback_master_listings AS
--     SELECT * FROM shortlisting_master_listings;
-- Same pattern for the history + human_edits + stage4_overrides + fewshot
-- tables if they hold data.

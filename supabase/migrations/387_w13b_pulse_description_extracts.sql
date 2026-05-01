-- W13b — Pulse Description Goldmine extractor schema.
--
-- Stores structured signal pulled from `pulse_listings.description` by
-- `pulse-description-extractor` (text-only Gemini 2.5 Pro). One row per
-- pulse_listing per extractor_version. Idempotent: re-runs at the same
-- version are skipped; a new version triggers re-extraction.
--
-- Consumer surfaces:
--   * `pulse_description_extracts` — raw rows for downstream waves (W12
--     organic registry growth, W14 calibration).
--   * `v_few_shot_voice_exemplars` — pre-filtered + per-voice-tier sample
--     for `fewShotLibraryBlock` to seed real-world voice exemplars.
--   * `pulse_extract_audit` — one row per batch (cost/wall/success/fail).
--
-- Spec: docs/design-specs/W13b-pulse-description-goldmine.md (v2 section).
-- Wave: 13b (text extractor; 28k full run is Wave 3d.5, deferred).

-- ─── Table: pulse_description_extracts ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pulse_description_extracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pulse_listing_id UUID NOT NULL
    REFERENCES public.pulse_listings(id) ON DELETE CASCADE,

  -- Provenance
  extractor_version TEXT NOT NULL DEFAULT 'v1.0',
  model TEXT NOT NULL DEFAULT 'gemini-2.5-pro',
  vendor TEXT NOT NULL DEFAULT 'google',

  -- Status: 'succeeded' | 'failed' (no 'pending' — row is only inserted
  -- after the call completes).
  extract_status TEXT NOT NULL CHECK (extract_status IN ('succeeded', 'failed')),
  error_message TEXT,

  -- Voice signals (string scalars)
  voice_register TEXT CHECK (voice_register IN ('premium', 'standard', 'approachable') OR voice_register IS NULL),
  voice_archetype TEXT,

  -- Lists (jsonb arrays of strings — not normalised here; Wave 12.5 does that)
  architectural_features JSONB NOT NULL DEFAULT '[]'::jsonb,
  material_palette JSONB NOT NULL DEFAULT '[]'::jsonb,
  period_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  lifestyle_themes JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_phrases JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Quality metrics (jsonb object: reading_grade_level, word_count, exclamation_marks)
  quality_indicators JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Few-shot eligibility
  derived_few_shot_eligibility BOOLEAN NOT NULL DEFAULT false,
  extractor_notes TEXT,

  -- Cost + timing per row
  input_tokens INT,
  output_tokens INT,
  cost_usd NUMERIC(10, 6),
  duration_ms INT,

  -- Timestamps
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One extract per (listing, version) — re-extraction is opt-in by bumping version.
  UNIQUE (pulse_listing_id, extractor_version)
);

-- Indexes for downstream filtering
CREATE INDEX IF NOT EXISTS idx_pulse_description_extracts_listing
  ON public.pulse_description_extracts (pulse_listing_id);
CREATE INDEX IF NOT EXISTS idx_pulse_description_extracts_voice_register
  ON public.pulse_description_extracts (voice_register)
  WHERE extract_status = 'succeeded';
CREATE INDEX IF NOT EXISTS idx_pulse_description_extracts_archetype
  ON public.pulse_description_extracts (voice_archetype)
  WHERE extract_status = 'succeeded';
CREATE INDEX IF NOT EXISTS idx_pulse_description_extracts_few_shot
  ON public.pulse_description_extracts (voice_register)
  WHERE derived_few_shot_eligibility = true AND extract_status = 'succeeded';
CREATE INDEX IF NOT EXISTS idx_pulse_description_extracts_status
  ON public.pulse_description_extracts (extract_status, extractor_version);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.pulse_description_extracts ENABLE ROW LEVEL SECURITY;

-- master_admin read/write; everyone else denied. Service-role bypasses RLS
-- so the edge function writes via getAdminClient().
DROP POLICY IF EXISTS pulse_description_extracts_master_admin_select ON public.pulse_description_extracts;
CREATE POLICY pulse_description_extracts_master_admin_select
  ON public.pulse_description_extracts
  FOR SELECT
  TO authenticated
  USING (public.get_user_role() = 'master_admin');

DROP POLICY IF EXISTS pulse_description_extracts_master_admin_modify ON public.pulse_description_extracts;
CREATE POLICY pulse_description_extracts_master_admin_modify
  ON public.pulse_description_extracts
  FOR ALL
  TO authenticated
  USING (public.get_user_role() = 'master_admin')
  WITH CHECK (public.get_user_role() = 'master_admin');

-- ─── updated_at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_pulse_description_extracts_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pulse_description_extracts_updated_at
  ON public.pulse_description_extracts;
CREATE TRIGGER trg_pulse_description_extracts_updated_at
  BEFORE UPDATE ON public.pulse_description_extracts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_pulse_description_extracts_updated_at();

-- ─── Audit table: pulse_extract_audit ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pulse_extract_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID,
  batch_id UUID NOT NULL DEFAULT gen_random_uuid(),
  extractor_version TEXT NOT NULL DEFAULT 'v1.0',
  model TEXT NOT NULL DEFAULT 'gemini-2.5-pro',
  vendor TEXT NOT NULL DEFAULT 'google',

  batch_size INT NOT NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,

  total_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  total_input_tokens INT NOT NULL DEFAULT 0,
  total_output_tokens INT NOT NULL DEFAULT 0,
  total_wall_ms INT NOT NULL DEFAULT 0,

  cost_cap_usd NUMERIC(10, 6),
  notes TEXT,

  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pulse_extract_audit_job
  ON public.pulse_extract_audit (job_id);
CREATE INDEX IF NOT EXISTS idx_pulse_extract_audit_batch
  ON public.pulse_extract_audit (batch_id);

ALTER TABLE public.pulse_extract_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pulse_extract_audit_master_admin_select ON public.pulse_extract_audit;
CREATE POLICY pulse_extract_audit_master_admin_select
  ON public.pulse_extract_audit
  FOR SELECT
  TO authenticated
  USING (public.get_user_role() = 'master_admin');

DROP POLICY IF EXISTS pulse_extract_audit_master_admin_modify ON public.pulse_extract_audit;
CREATE POLICY pulse_extract_audit_master_admin_modify
  ON public.pulse_extract_audit
  FOR ALL
  TO authenticated
  USING (public.get_user_role() = 'master_admin')
  WITH CHECK (public.get_user_role() = 'master_admin');

-- ─── View: v_few_shot_voice_exemplars ────────────────────────────────────────
--
-- Surfaces the curated voice exemplars per tier for fewShotLibraryBlock to
-- consume. Sample-N is enforced at read time (consumer applies LIMIT) — the
-- view ranks by description length × eligibility heuristic so the LIMIT
-- naturally selects the most-substantial publishable copy.
--
-- Ranking heuristic:
--   1. Drop failed extracts and ineligible rows.
--   2. Drop short descriptions (<400 chars) — too thin for a useful exemplar.
--   3. Order within each voice_register by:
--        a. quality_indicators.exclamation_marks ASC (fewer = more polished),
--        b. quality_indicators.word_count DESC (longer = richer signal),
--        c. extracted_at DESC (newer = most recent voice).

CREATE OR REPLACE VIEW public.v_few_shot_voice_exemplars
WITH (security_invoker = true)
AS
SELECT
  e.id AS extract_id,
  e.pulse_listing_id,
  e.voice_register,
  e.voice_archetype,
  e.architectural_features,
  e.material_palette,
  e.period_signals,
  e.lifestyle_themes,
  e.forbidden_phrases,
  e.quality_indicators,
  e.extractor_notes,
  e.extracted_at,
  l.suburb,
  l.postcode,
  l.property_type,
  l.bedrooms,
  l.bathrooms,
  l.asking_price,
  l.sold_price,
  l.agency_name,
  l.description AS source_description,
  ROW_NUMBER() OVER (
    PARTITION BY e.voice_register
    ORDER BY
      COALESCE((e.quality_indicators->>'exclamation_marks')::int, 99) ASC,
      COALESCE((e.quality_indicators->>'word_count')::int, 0) DESC,
      e.extracted_at DESC
  ) AS rank_in_tier
FROM public.pulse_description_extracts e
JOIN public.pulse_listings l ON l.id = e.pulse_listing_id
WHERE e.extract_status = 'succeeded'
  AND e.derived_few_shot_eligibility = true
  AND e.voice_register IS NOT NULL
  AND char_length(COALESCE(l.description, '')) >= 400;

COMMENT ON VIEW public.v_few_shot_voice_exemplars IS
  'W13b — Curated few-shot voice exemplars per voice_register (premium/standard/approachable), '
  'ranked within each tier by polish (fewer exclamation marks) × richness (word_count) × recency. '
  'Consumed by fewShotLibraryBlock when in_active_prompt is true. Source: pulse_description_extracts × pulse_listings.';

-- master_admin only on the view (view inherits underlying table RLS via security_invoker)
GRANT SELECT ON public.v_few_shot_voice_exemplars TO authenticated;

-- ─── shortlisting_jobs.kind extension ─────────────────────────────────────────
--
-- Add 'pulse_description_extract' to the allowed kinds. Mirrors the pattern
-- in 377_shortlisting_jobs_shape_d_kinds and 383_shortlisting_jobs_canonical_rollup_kind.

ALTER TABLE public.shortlisting_jobs
  DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;
ALTER TABLE public.shortlisting_jobs
  ADD CONSTRAINT shortlisting_jobs_kind_check
  CHECK (kind IN (
    'ingest',
    'extract',
    'pass0',
    'pass1',
    'pass2',
    'pass3',
    'render_preview',
    'shape_d_stage1',
    'stage4_synthesis',
    'canonical_rollup',
    'pulse_description_extract'
  ));

-- ─── Comments ────────────────────────────────────────────────────────────────

COMMENT ON TABLE public.pulse_description_extracts IS
  'W13b — structured signal pulled from pulse_listings.description by Gemini 2.5 Pro. '
  'One row per (listing, extractor_version). Idempotent: re-runs at same version are skipped. '
  'Spec: docs/design-specs/W13b-pulse-description-goldmine.md.';

COMMENT ON TABLE public.pulse_extract_audit IS
  'W13b — per-batch rollup of pulse description extractor runs (cost, wall, success/fail counts). '
  'Joinable to shortlisting_jobs via job_id when invoked through the dispatcher.';

COMMENT ON COLUMN public.pulse_description_extracts.architectural_features IS
  'Array of noun-phrase strings naming canonical-eligible features mentioned in the description. '
  'Wave 12.5 will normalise these against object_registry.';

COMMENT ON COLUMN public.pulse_description_extracts.forbidden_phrases IS
  'Cliches the description USED — populates the engine''s "what not to write" list.';

COMMENT ON COLUMN public.pulse_description_extracts.derived_few_shot_eligibility IS
  'TRUE if the source description is publishable enough to use as a voice exemplar in fewShotLibraryBlock.';

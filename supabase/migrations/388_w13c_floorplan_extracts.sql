-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 386 — Wave 13c: Floorplan OCR Goldmine extract table + dispatcher kind
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W13c-floorplan-ocr-goldmine.md
--
-- Source: pulse_listings.floorplan_urls (text[]). 22,145 listings carry
-- floorplan URLs (22,822 total images). The W13c extractor calls Gemini 2.5
-- Pro vision with source_type='floorplan_image' (W7.6 source-aware preamble)
-- and persists structured signal per image — room enumeration, dimensions,
-- bed/bath counts, archetype, north arrow, garage type, flow paths.
--
-- This migration ships:
--
--   1. `floorplan_extracts` table (one row per floorplan image)
--   2. View `v_floorplan_crm_mismatches` for ops review
--   3. shortlisting_jobs.kind CHECK constraint extended to include
--      'floorplan_extract' (terminal kind; no chain)
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. Idempotency on (pulse_listing_id, floorplan_url_hash). REA URLs are
--    hashed (sha256) since they're long; if a listing's URL changes a fresh
--    row inserts and the old row stays for audit.
-- 2. CASCADE on pulse_listings deletion — extractions are derivative;
--    pulse_listings is the source of truth.
-- 3. Indexes on bedrooms_count + home_archetype to support the future
--    floorplan-aware shortlisting wave (W15c) joining floorplans to projects
--    by layout pattern.
-- 4. cross_check_flags is text[] of tokens like 'bedrooms_mismatch_2_vs_3' —
--    a GIN index makes the mismatch view fast.
-- 5. RLS denied for non-master_admins (extracts are operational telemetry,
--    not user-facing).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. floorplan_extracts table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.floorplan_extracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pulse_listing_id UUID NOT NULL REFERENCES public.pulse_listings(id) ON DELETE CASCADE,
  floorplan_url TEXT NOT NULL,
  floorplan_url_hash TEXT NOT NULL,

  -- Areas
  total_internal_sqm NUMERIC(10, 2),
  total_land_sqm NUMERIC(10, 2),

  -- Room enumeration: JSONB array of { room_label, count, dimensions_sqm? }
  rooms_detected JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Counts (cross-validated against CRM)
  bedrooms_count INTEGER,
  bathrooms_count INTEGER,

  -- Archetype + orientation
  home_archetype TEXT NOT NULL DEFAULT 'unknown'
    CHECK (home_archetype IN (
      'open_plan', 'traditional', 'split_level',
      'townhouse', 'duplex', 'apartment',
      'unit', 'studio', 'unknown'
    )),
  north_arrow_orientation NUMERIC(5, 2),  -- degrees (0-359.99) or null

  -- Garage
  garage_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (garage_type IN (
      'lock_up', 'carport', 'tandem',
      'double', 'single', 'none', 'unknown'
    )),

  -- Flow paths: JSONB array of { from, to }
  flow_paths JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Cross-check flags vs CRM
  cross_check_flags TEXT[] NOT NULL DEFAULT '{}',

  -- Quality signals
  legibility_score NUMERIC(4, 2)
    CHECK (legibility_score IS NULL OR (legibility_score >= 0 AND legibility_score <= 10)),
  extraction_confidence NUMERIC(4, 3)
    CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),

  -- Provenance
  vendor_used TEXT NOT NULL CHECK (vendor_used IN ('google', 'anthropic')),
  model_used TEXT NOT NULL,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  prompt_block_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_response_excerpt TEXT,

  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 2. Idempotency unique index ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_floorplan_extracts_listing_url
  ON public.floorplan_extracts (pulse_listing_id, floorplan_url_hash);

-- ─── 3. Operational indexes (W15c floorplan-aware shortlisting prep) ────────
CREATE INDEX IF NOT EXISTS idx_floorplan_extracts_bedrooms_count
  ON public.floorplan_extracts (bedrooms_count)
  WHERE bedrooms_count IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_floorplan_extracts_home_archetype
  ON public.floorplan_extracts (home_archetype);

CREATE INDEX IF NOT EXISTS idx_floorplan_extracts_listing
  ON public.floorplan_extracts (pulse_listing_id);

CREATE INDEX IF NOT EXISTS idx_floorplan_extracts_cross_check_flags
  ON public.floorplan_extracts USING GIN (cross_check_flags);

CREATE INDEX IF NOT EXISTS idx_floorplan_extracts_extracted_at
  ON public.floorplan_extracts (extracted_at DESC);

-- ─── 4. updated_at trigger (reuses public.update_updated_at() from mig 001) ─
DROP TRIGGER IF EXISTS set_updated_at_floorplan_extracts ON public.floorplan_extracts;
CREATE TRIGGER set_updated_at_floorplan_extracts
  BEFORE UPDATE ON public.floorplan_extracts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- ─── 5. RLS: master_admin only ───────────────────────────────────────────────
ALTER TABLE public.floorplan_extracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS floorplan_extracts_master_admin_all ON public.floorplan_extracts;
CREATE POLICY floorplan_extracts_master_admin_all
  ON public.floorplan_extracts
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid()
         AND users.role = 'master_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
       WHERE users.id = auth.uid()
         AND users.role = 'master_admin'
    )
  );

-- ─── 6. View: v_floorplan_crm_mismatches (ops review) ────────────────────────
-- Surfaces every listing where the floorplan-extracted bed/bath counts diverge
-- from the CRM-stored counts. Useful for:
--   - QA-ing the extractor (false positives indicate prompt drift)
--   - Identifying listings where the agent under/over-stated room counts
--   - Feeding the W15c floorplan-aware shortlisting confidence

CREATE OR REPLACE VIEW public.v_floorplan_crm_mismatches AS
SELECT
  fe.id AS extract_id,
  fe.pulse_listing_id,
  pl.address,
  pl.suburb,
  pl.postcode,
  pl.listing_type,
  pl.asking_price,
  pl.sold_price,
  fe.floorplan_url,
  fe.bedrooms_count AS extracted_bedrooms,
  pl.bedrooms AS crm_bedrooms,
  fe.bathrooms_count AS extracted_bathrooms,
  pl.bathrooms AS crm_bathrooms,
  fe.home_archetype,
  fe.legibility_score,
  fe.extraction_confidence,
  fe.cross_check_flags,
  fe.extracted_at
FROM public.floorplan_extracts fe
JOIN public.pulse_listings pl ON pl.id = fe.pulse_listing_id
WHERE
  -- Bedrooms diverge AND both sides are known
  (fe.bedrooms_count IS NOT NULL
    AND pl.bedrooms IS NOT NULL
    AND fe.bedrooms_count != pl.bedrooms)
  OR
  -- Bathrooms diverge AND both sides are known
  (fe.bathrooms_count IS NOT NULL
    AND pl.bathrooms IS NOT NULL
    AND fe.bathrooms_count != pl.bathrooms)
ORDER BY fe.extracted_at DESC;

COMMENT ON VIEW public.v_floorplan_crm_mismatches IS
  'Wave 13c: rows where floorplan-extracted bedroom/bathroom counts diverge '
  'from CRM-stored counts. Useful for QA + agent-claim audits.';

-- ─── 7. Extend shortlisting_jobs.kind CHECK to permit 'floorplan_extract' ───
-- floorplan_extract is a TERMINAL kind — the dispatcher's chainNextKind
-- short-circuits when job.kind === 'floorplan_extract'. We do NOT extend
-- the unique-pass-per-round index (mig 326/377) because floorplan extracts
-- are NOT round-scoped (they're listing-scoped).

ALTER TABLE public.shortlisting_jobs
  DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shortlisting_jobs_kind_check'
       AND conrelid = 'public.shortlisting_jobs'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.shortlisting_jobs
             ADD CONSTRAINT shortlisting_jobs_kind_check
             CHECK (kind IN (
               ''ingest'',
               ''extract'',
               ''pass0'',
               ''pass1'',
               ''pass2'',
               ''pass3'',
               ''render_preview'',
               ''shape_d_stage1'',
               ''stage4_synthesis'',
               ''canonical_rollup'',
               ''floorplan_extract''
             ))
             NOT VALID';
    EXECUTE 'ALTER TABLE public.shortlisting_jobs
             VALIDATE CONSTRAINT shortlisting_jobs_kind_check';
  END IF;
END $$;

-- ─── 8. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.floorplan_extracts IS
  'Wave 13c: per-floorplan structured-extract output. One row per '
  'pulse_listings.floorplan_urls[i] entry. Idempotent on (pulse_listing_id, '
  'floorplan_url_hash). Feeds W12 canonical attribute registry + W15c '
  'floorplan-aware shortlisting.';

COMMENT ON COLUMN public.floorplan_extracts.cross_check_flags IS
  'Text-token array surfaced when extracted bedrooms/bathrooms differ from '
  'CRM-stored counts. Tokens: ''bedrooms_mismatch_<extracted>_vs_<crm>'', '
  '''bathrooms_mismatch_<extracted>_vs_<crm>'', ''no_crm_bedrooms_to_check'', '
  '''no_crm_bathrooms_to_check''.';

COMMENT ON COLUMN public.floorplan_extracts.legibility_score IS
  '0-10 score self-rated by the model for how readable the drawing is. <4 '
  'indicates blur / low-resolution / hand-drawn / heavily-stylised drawings '
  'where extraction confidence is low.';

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP VIEW IF EXISTS public.v_floorplan_crm_mismatches;
-- DROP TABLE IF EXISTS public.floorplan_extracts;
--
-- ALTER TABLE public.shortlisting_jobs
--   DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;
-- ALTER TABLE public.shortlisting_jobs
--   ADD CONSTRAINT shortlisting_jobs_kind_check
--   CHECK (kind IN (
--     'ingest','extract','pass0','pass1','pass2','pass3','render_preview',
--     'shape_d_stage1','stage4_synthesis','canonical_rollup'
--   ));

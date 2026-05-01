-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 400 — Wave 15b.2: pulse_listing_vision_extracts substrate
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md (W15b.2)
--
-- Purpose:
--   Substrate table + linking columns for the W15b external listing vision
--   pipeline. The pipeline feeds product-mix detection (day/dusk/drone counts,
--   floorplan presence, video segments, competitor branding) into the
--   existing missed-opportunity quoting engine so we can answer "what package
--   did the competitor deliver?" from the public listing alone.
--
-- Architecture (W15b roles):
--   * W15b.1 — Stage 1 Flash extractor (per-listing, per-image vision call)
--   * W15b.2 — THIS migration: extract row + persistence helper
--   * W15b.3 — video frame extractor (samples frames from listing videos)
--   * W15b.5 — SQL classifier v2 (rolls per-image rows up to product mix)
--
-- Why a NEW table (not pulse_listing_missed_opportunity columns)?
--   * Idempotency at (listing, schema_version) level — re-runs at v1.0 hit
--     the unique index and short-circuit; bumping to v1.1 forces a new row.
--   * Cost provenance per extract: vendor / model / prompt block versions /
--     token counts. The PMO row is a downstream rollup, not the source of
--     truth for "what did vision tell us".
--   * Status state machine (pending → running → succeeded|partial|failed,
--     or manually_overridden via master_admin) lives separately from the
--     PMO quote_status flow — they're orthogonal lifecycles.
--
-- Per-image vs per-listing split:
--   * per-image classifications go into composition_classifications (the v2
--     universal schema, mig 398). W15b emits source_type='external_listing'
--     and joins back via the new pulse_listing_id + pulse_vision_extract_id
--     columns added at the bottom of this migration.
--   * per-listing aggregate (day_count, dusk_count, etc.) lives in this
--     new table's photo_breakdown / video_breakdown / competitor JSONBs.
--     Computed in the persist helper from the per-image rows.
--
-- Trigger context:
--   * triggered_by='pulse_detail_enrich' — the most common path; the pulse
--     enrichment job kicks off an extract when a new listing lands.
--   * triggered_by='operator_manual' — master_admin "re-run vision" button.
--   * triggered_by='mass_backfill' — sweep over historical listings.
--
-- RLS:
--   * SELECT for any authenticated user (read-only dashboards).
--   * Writes happen via service-role only (no INSERT/UPDATE/DELETE policies
--     declared → RLS denies by default for authenticated; service-role
--     bypasses RLS).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.pulse_listing_vision_extracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.pulse_listings(id) ON DELETE CASCADE,
  schema_version text NOT NULL DEFAULT 'v1.0',

  -- Extraction state machine
  status text NOT NULL CHECK (status IN (
    'pending', 'running', 'succeeded', 'partial', 'failed', 'manually_overridden'
  )),
  extracted_at timestamptz,
  failed_reason text,
  manual_override_by uuid,        -- master_admin user_id when override
  manual_override_reason text,

  -- Per-image results aggregated
  -- photo_breakdown shape:
  --   { day_count, dusk_count, drone_count, floorplan_count, detail_count,
  --     video_thumbnail_count, agent_headshot_count, total_images }
  photo_breakdown jsonb DEFAULT '{}'::jsonb,
  -- video_breakdown shape:
  --   { present, day_segments_count, dusk_segments_count, drone_segments_count,
  --     agent_in_frame, car_in_frame, narrator_inferred, total_duration_s,
  --     frames_extracted }
  video_breakdown jsonb,
  -- competitor shape:
  --   { watermark_visible, agency_logo, photographer_credit,
  --     dominant_brand_inferred }
  competitor jsonb DEFAULT '{}'::jsonb,

  -- Cost + provenance
  total_cost_usd numeric DEFAULT 0,
  total_input_tokens int DEFAULT 0,
  total_output_tokens int DEFAULT 0,
  vendor text,                    -- 'google'
  model_version text,             -- 'gemini-2.5-flash'
  prompt_block_versions jsonb DEFAULT '{}'::jsonb,

  -- Trigger context
  triggered_by text,              -- 'pulse_detail_enrich' | 'operator_manual' | 'mass_backfill'
  triggered_by_user uuid,         -- when triggered_by='operator_manual'

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one extract per (listing, schema_version). Re-running at the
-- same version is a no-op; bumping to v1.1 (a future schema bump) forces a
-- new row alongside the v1.0 historical record.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pulse_vision_extracts_listing_version
  ON public.pulse_listing_vision_extracts (listing_id, schema_version);

-- Dashboard queries
CREATE INDEX IF NOT EXISTS idx_pulse_vision_extracts_listing_status
  ON public.pulse_listing_vision_extracts (listing_id, status);
CREATE INDEX IF NOT EXISTS idx_pulse_vision_extracts_extracted_at
  ON public.pulse_listing_vision_extracts (extracted_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_pulse_vision_extracts_status
  ON public.pulse_listing_vision_extracts (status)
  WHERE status IN ('failed', 'partial', 'pending');

-- updated_at trigger — reuse the pulse_pmo_touch_updated_at fn from mig 158.
DROP TRIGGER IF EXISTS pulse_vision_extracts_updated_at
  ON public.pulse_listing_vision_extracts;
CREATE TRIGGER pulse_vision_extracts_updated_at
  BEFORE UPDATE ON public.pulse_listing_vision_extracts
  FOR EACH ROW EXECUTE FUNCTION public.pulse_pmo_touch_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE public.pulse_listing_vision_extracts ENABLE ROW LEVEL SECURITY;

-- Read-only for authenticated. Writes happen via service-role; we declare no
-- INSERT/UPDATE/DELETE policies so RLS denies them by default for
-- authenticated callers. service_role bypasses RLS.
DROP POLICY IF EXISTS pulse_vision_extracts_select_authenticated
  ON public.pulse_listing_vision_extracts;
CREATE POLICY pulse_vision_extracts_select_authenticated
  ON public.pulse_listing_vision_extracts
  FOR SELECT
  TO authenticated
  USING (true);

-- ─── composition_classifications linking columns ─────────────────────────────
--
-- Per-image rows from W15b.1 land in composition_classifications via
-- source_type='external_listing' (added in mig 398 W11.7.17 v2 schema).
-- Add three back-pointers so we can:
--   * filter "all classifications for listing X" by pulse_listing_id
--   * filter "all classifications produced by extract Y" by pulse_vision_extract_id
--   * surface the per-image source URL on the dashboard (no need to re-derive
--     from the listing's image array)
--   * trace which video frame index a row came from (W15b.3 video extractor)

ALTER TABLE public.composition_classifications
  ADD COLUMN IF NOT EXISTS pulse_listing_id uuid
    REFERENCES public.pulse_listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pulse_vision_extract_id uuid
    REFERENCES public.pulse_listing_vision_extracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_image_url text,
  ADD COLUMN IF NOT EXISTS source_video_frame_index int;

CREATE INDEX IF NOT EXISTS idx_classif_pulse_listing
  ON public.composition_classifications (pulse_listing_id)
  WHERE pulse_listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classif_pulse_extract
  ON public.composition_classifications (pulse_vision_extract_id)
  WHERE pulse_vision_extract_id IS NOT NULL;

-- ─── Comments (operator-facing) ─────────────────────────────────────────────

COMMENT ON TABLE public.pulse_listing_vision_extracts IS
  'W15b.2 — substrate for external listing vision pipeline. One row per '
  '(listing, schema_version). Aggregates per-image classifications from '
  'composition_classifications (source_type=external_listing) into '
  'photo/video/competitor breakdowns the missed-opportunity engine consumes. '
  'Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md.';

COMMENT ON COLUMN public.pulse_listing_vision_extracts.status IS
  'State machine: pending → running → succeeded|partial|failed. '
  '`manually_overridden` is a terminal state set by master_admin via the '
  'override helper.';

COMMENT ON COLUMN public.pulse_listing_vision_extracts.photo_breakdown IS
  'Aggregated counts per image_type from per-image rows. Shape: { day_count, '
  'dusk_count, drone_count, floorplan_count, detail_count, '
  'video_thumbnail_count, agent_headshot_count, total_images }. Computed by '
  'aggregatePerImageResults().';

COMMENT ON COLUMN public.pulse_listing_vision_extracts.video_breakdown IS
  'Aggregated video segment counts. Shape: { present, day_segments_count, '
  'dusk_segments_count, drone_segments_count, agent_in_frame, car_in_frame, '
  'narrator_inferred, total_duration_s, frames_extracted }. NULL when the '
  'listing has no video.';

COMMENT ON COLUMN public.pulse_listing_vision_extracts.competitor IS
  'Competitor-branding signals extracted from per-image observed_attributes. '
  'Shape: { watermark_visible, agency_logo, photographer_credit, '
  'dominant_brand_inferred }.';

COMMENT ON COLUMN public.pulse_listing_vision_extracts.triggered_by IS
  'How the extract was kicked off: '
  '`pulse_detail_enrich` (auto, on listing land) | '
  '`operator_manual` (master_admin re-run button) | '
  '`mass_backfill` (sweep over historical listings).';

COMMENT ON COLUMN public.composition_classifications.pulse_listing_id IS
  'W15b.2 — back-pointer to pulse_listings for source_type=external_listing '
  'rows. NULL on internal_raw / internal_finals / floorplan_image rows.';

COMMENT ON COLUMN public.composition_classifications.pulse_vision_extract_id IS
  'W15b.2 — back-pointer to the pulse_listing_vision_extracts row that '
  'produced this classification. Lets the dashboard "show me everything '
  'extract X emitted" with one indexed lookup.';

COMMENT ON COLUMN public.composition_classifications.source_image_url IS
  'W15b.2 — original image URL on the external listing (CDN URL, not Dropbox). '
  'Surfaced on the dashboard without having to re-derive from the listing''s '
  'image array. NULL on internal sources.';

COMMENT ON COLUMN public.composition_classifications.source_video_frame_index IS
  'W15b.2 — when the row came from a video frame extracted by W15b.3, this is '
  'the 0-based frame index within the listing''s video timeline. NULL for '
  'still-image rows.';

NOTIFY pgrst, 'reload schema';

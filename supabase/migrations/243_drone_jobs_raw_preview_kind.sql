-- 243: AI raw preview pipeline support
--   1. Add `raw_preview_render` to drone_jobs.kind CHECK
--   2. Add `preview` to drone_renders.column_state CHECK
--   3. Re-create the unique partial index on drone_renders to keep `preview`
--      OUT of the active-per-variant uniqueness scope (previews can stack and
--      get re-generated freely without conflicting with proposed/adjustments
--      /final rows).
--
-- Stream context (Wave 2 – Drone curation): after SfM + POI fetch complete on a
-- shoot, the dispatcher chains a `raw_preview_render` job that runs every
-- non-SfM raw shot through the renderer (POI + boundary overlay) so the
-- operator can SEE what each candidate would look like as a deliverable. Output
-- lands in `Drones/Raws/Shortlist Proposed/Previews/` (folder kind
-- `drones_raws_shortlist_proposed_previews` from migration 241). These are
-- INFORMATIONAL only — never customer deliverables. The shortlist algorithm
-- runs in the same job and flags `drone_shots.is_ai_recommended` for the
-- curated subset.

-- ── 1. drone_jobs.kind: add 'raw_preview_render' ───────────────────────────
ALTER TABLE drone_jobs
  DROP CONSTRAINT IF EXISTS drone_jobs_kind_check;

ALTER TABLE drone_jobs
  ADD CONSTRAINT drone_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'ingest'::text,
    'sfm'::text,
    'render'::text,
    'render_preview'::text,
    'raw_preview_render'::text,
    'poi_fetch'::text,
    'cadastral_fetch'::text
  ]));

-- ── 2. drone_renders.column_state: add 'preview' ───────────────────────────
ALTER TABLE drone_renders
  DROP CONSTRAINT IF EXISTS drone_renders_column_state_check;

ALTER TABLE drone_renders
  ADD CONSTRAINT drone_renders_column_state_check
  CHECK (column_state = ANY (ARRAY[
    'raw'::text,
    'preview'::text,
    'proposed'::text,
    'adjustments'::text,
    'final'::text,
    'rejected'::text
  ]));

-- ── 3. Unique partial index — keep 'preview' OUT of scope ──────────────────
-- The existing index from migration 233 already excludes 'preview' implicitly
-- (it only includes proposed/adjustments/final). Re-state it here verbatim so
-- the schema is self-documenting in this migration. No-op if the index already
-- exists with the same definition; safe to re-apply.
DROP INDEX IF EXISTS uniq_drone_renders_active_per_variant;

CREATE UNIQUE INDEX uniq_drone_renders_active_per_variant
  ON public.drone_renders
  USING btree (shot_id, kind, COALESCE(output_variant, 'default'::text), column_state)
  WHERE (column_state = ANY (ARRAY['proposed'::text, 'adjustments'::text, 'final'::text]));

NOTIFY pgrst, 'reload schema';

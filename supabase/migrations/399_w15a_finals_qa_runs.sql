-- W15a — Internal Finals Scoring (smoke wave)
-- Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §8 +
--       docs/WAVE_PLAN.md Wave 15.
--
-- Adds `finals_qa_runs` to track each invocation of the
-- `shortlisting-finals-qa` edge function (which feeds delivered final JPEGs
-- through Stage 1 with source_type='internal_finals' and surfaces blowout /
-- sky-replacement halos / digital-furniture artefacts the editor missed).
--
-- The table is *invocation-grained* (one row per QA run, not one per image).
-- Per-image results land in `composition_classifications` keyed by a synthetic
-- group_id (no `composition_groups` row exists for finals — there's no
-- bracket-merge upstream). Finals classifications are filtered out via
-- `source_type='internal_finals'` so they never collide with the RAW pipeline
-- that uses `composition_groups`.
--
-- run_kind discriminates between the two invocation modes:
--   - 'sample'  — caller passed an explicit list of finals_paths[]
--   - 'all'     — caller passed all_finals=true (master_admin scans the
--                 entire Photos/Finals/ folder)
--
-- Index on (project_id, started_at DESC) supports the dashboard's per-project
-- "latest QA run" lookup. We don't need a covering index for the rollup itself
-- — the table is small (one row per QA invocation).

CREATE TABLE IF NOT EXISTS finals_qa_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_kind        text NOT NULL CHECK (run_kind IN ('sample', 'all')),
  status          text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'succeeded', 'failed', 'partial')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  finals_count    integer NOT NULL DEFAULT 0,
  successes       integer NOT NULL DEFAULT 0,
  failures        integer NOT NULL DEFAULT 0,
  total_cost_usd  numeric(10, 6) NOT NULL DEFAULT 0,
  triggered_by    uuid REFERENCES auth.users(id),
  finals_paths    jsonb,                   -- ['/Path/To/Photos/Finals/IMG_1.jpg', ...]
  error_message   text,
  warnings        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-project history: latest run first.
CREATE INDEX IF NOT EXISTS finals_qa_runs_project_started_idx
  ON finals_qa_runs (project_id, started_at DESC);

-- "Show me what's running right now" filter.
CREATE INDEX IF NOT EXISTS finals_qa_runs_status_idx
  ON finals_qa_runs (status)
  WHERE status = 'running';

-- RLS: master_admin only (consistent with the dashboard's permission gate).
ALTER TABLE finals_qa_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finals_qa_runs_master_admin_select ON finals_qa_runs;
CREATE POLICY finals_qa_runs_master_admin_select
  ON finals_qa_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role = 'master_admin'
    )
  );

DROP POLICY IF EXISTS finals_qa_runs_master_admin_insert ON finals_qa_runs;
CREATE POLICY finals_qa_runs_master_admin_insert
  ON finals_qa_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role = 'master_admin'
    )
  );

-- Service role bypass for the edge function itself.
DROP POLICY IF EXISTS finals_qa_runs_service_role_all ON finals_qa_runs;
CREATE POLICY finals_qa_runs_service_role_all
  ON finals_qa_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE finals_qa_runs IS
  'W15a tracking table: one row per invocation of shortlisting-finals-qa. '
  'Per-image classification results live in composition_classifications '
  'with source_type=''internal_finals'' (synthetic group_id per finals image).';
COMMENT ON COLUMN finals_qa_runs.run_kind IS
  '''sample'' = explicit finals_paths[] list; ''all'' = full Photos/Finals/ scan.';
COMMENT ON COLUMN finals_qa_runs.finals_paths IS
  'Snapshot of the resolved Dropbox JPEG paths processed in this run.';

-- W15a: round_id is conceptually a RAW-pipeline construct (one round per
-- shortlist proposal), but downstream sources like internal_finals,
-- external_listing, and floorplan_image have NO round_id — they're
-- invocation-grained or competitor-scraped, not part of an upstream
-- shortlisting round. Relax the NOT NULL so v2 source dimorphism works
-- end-to-end. The constraint moves to a CHECK so RAW rows still must
-- have round_id (the existing pipeline writes it as a matter of course).
ALTER TABLE composition_classifications
  ALTER COLUMN round_id DROP NOT NULL;

ALTER TABLE composition_classifications
  DROP CONSTRAINT IF EXISTS composition_classifications_round_id_required_for_raw;

ALTER TABLE composition_classifications
  ADD CONSTRAINT composition_classifications_round_id_required_for_raw
  CHECK (
    source_type != 'internal_raw' OR round_id IS NOT NULL
  );

COMMENT ON CONSTRAINT composition_classifications_round_id_required_for_raw
  ON composition_classifications IS
  'W15a: round_id stays mandatory for source_type=''internal_raw'' (RAW '
  'pipeline). NULL allowed for internal_finals, external_listing, and '
  'floorplan_image sources where there''s no upstream shortlisting round.';

-- W15a: drop the composition_classifications.group_id FK so finals
-- (and future external_listing/floorplan_image) sources can use synthetic
-- group_ids that have no upstream composition_groups row. RAW rows still
-- have their group_id linked to composition_groups by application logic
-- (shape-d's loadCompositionGroups), but the DB no longer enforces that
-- across all sources.
ALTER TABLE composition_classifications
  DROP CONSTRAINT IF EXISTS composition_classifications_group_id_fkey;

COMMENT ON COLUMN composition_classifications.group_id IS
  'W15a: SOFT reference. RAW rows (source_type=internal_raw) link to a real '
  'composition_groups.id; finals/external/floorplan rows use a synthetic '
  'crypto.randomUUID() per emission. The unique-on-group_id constraint '
  'still applies, ensuring re-runs upsert vs duplicate.';

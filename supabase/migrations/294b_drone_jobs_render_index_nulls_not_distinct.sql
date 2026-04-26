-- ═══════════════════════════════════════════════════════════════════════════
-- 294b: Wave 6 — make per-shot render dedupe NULL-aware so the cascade
--       orchestration row (shoot_id=NULL, payload.shot_id=NULL) doesn't
--       slip past the dedupe check via PostgreSQL's default NULL≠NULL.
-- ───────────────────────────────────────────────────────────────────────────
-- Smoke test on mig 294's index showed 2 rows inserted with shoot_id=NULL
-- + same project + same pipeline coexist (PG default: NULLs distinct in
-- unique indices). Per-shot fan-out rows still de-dupe correctly because
-- they all carry shoot_id NOT NULL + payload.shot_id NOT NULL. But the
-- project-wide cascade row (the one drone-pins-save inserts as the trigger
-- for the dispatcher to fan out) needs NULLS NOT DISTINCT semantics so a
-- second pin-save in the same project debounces against the existing
-- pending row.
--
-- PG 15+ supports NULLS NOT DISTINCT on index DDL. We're on 17 so this is
-- a one-line drop+recreate. The boundary-cascade index (project_id only,
-- always NOT NULL) doesn't need this treatment.
-- ═══════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_drone_jobs_unique_pending_render;
CREATE UNIQUE INDEX idx_drone_jobs_unique_pending_render
  ON drone_jobs (
    shoot_id,
    COALESCE(pipeline, 'raw'),
    COALESCE(payload->>'shot_id', '')
  ) NULLS NOT DISTINCT
  WHERE status IN ('pending', 'running')
    AND kind IN ('render', 'render_edited');

COMMENT ON INDEX idx_drone_jobs_unique_pending_render IS
  'Per-shot, per-pipeline render dedupe — NULLS NOT DISTINCT so the cascade orchestration row (shoot_id=NULL) also de-dupes per project. Wave 6 mig 294/294b.';

NOTIFY pgrst, 'reload schema';

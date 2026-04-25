-- Migration 233: drone module — QA audit fixes
--
-- Closes #6, #89, #91 from the static-code-review audit:
--   #6  drone_renders has no unique constraint protecting against parallel
--       render-job runs producing duplicate (shot,kind,variant,column_state)
--       rows. Two manual re-renders racing each other or a chained-from-SfM
--       follow-up colliding with a manual reflow currently leave both rows
--       and the UI shows duplicates.
--
--   #89 The hot-path query in DroneRendersSubtab fetches "all renders for
--       N shot ids ORDER BY created_at DESC" but there's no composite index
--       backing that. With a busy shoot the planner can fall back to a seq
--       scan on drone_renders. Add `(shot_id, created_at DESC)` index.
--
--   #91 drone_jobs is missing from the realtime publication. The Drone
--       Command Center has to poll for queue updates. Add it.

-- ── #6 unique constraint ─────────────────────────────────────────────────
-- column_state IN ('proposed','adjustments','final') means at most one live
-- card per (shot, kind, variant) per column. 'rejected' is excluded so the
-- audit trail can keep multiple historic rejects.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_drone_renders_active_per_variant
  ON drone_renders (shot_id, kind, COALESCE(output_variant, 'default'), column_state)
  WHERE column_state IN ('proposed','adjustments','final');

-- ── #89 hot-path index ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_drone_renders_shot_created_at
  ON drone_renders (shot_id, created_at DESC);

-- ── #91 publish drone_jobs to realtime ────────────────────────────────
DO $$
BEGIN
  -- Only add if not already a member; ALTER PUBLICATION ADD TABLE errors on
  -- duplicate. supabase_realtime is the default Supabase realtime publication.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'drone_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_jobs;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Drone Phase 2 Stream K: Drones-tab realtime publication
-- ───────────────────────────────────────────────────────────────────────────
-- Adds the four drone-domain tables to the supabase_realtime publication so
-- the new ProjectDronesTab can subscribe to live shoot/shot/render/SfM
-- changes (matches the pattern migration 226 established for
-- project_folder_events).
--
-- Tables added:
--   drone_shoots    — list refresh + status pipeline updates
--   drone_shots     — Shots subtab live updates (rare; mainly initial ingest)
--   drone_renders   — Renders subtab pipeline columns (raw → final)
--   drone_sfm_runs  — shoot detail status strip (residual, registered count)
--
-- Idempotent: each ALTER PUBLICATION ADD TABLE is wrapped in a NOT EXISTS
-- check so re-running the migration is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_shoots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_shoots;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_shots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_shots;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_renders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_renders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_sfm_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_sfm_runs;
  END IF;
END$$;

NOTIFY pgrst, 'reload schema';

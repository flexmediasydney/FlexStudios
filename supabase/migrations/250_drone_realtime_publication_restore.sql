-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 250: Restore drone realtime publication
-- ───────────────────────────────────────────────────────────────────────────
-- Regression: 4 of 6 drone tables were silently dropped from
-- supabase_realtime publication (only drone_events and drone_jobs remain).
-- Migration 229 originally added drone_shoots/drone_shots/drone_renders/
-- drone_sfm_runs but they have since been removed (likely by a publication
-- recreate elsewhere). Without these the ProjectDronesTab cannot react to
-- shoot/shot/render/SfM changes.
--
-- Idempotent: NOT EXISTS check around each ADD TABLE.
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

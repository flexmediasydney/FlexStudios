-- ═══════════════════════════════════════════════════════════════════════════
-- Drone Phase 1 PR7a: Files-tab UI support
-- ───────────────────────────────────────────────────────────────────────────
-- Two changes:
--   1. Add `project_folder_events` to the supabase_realtime publication so
--      the Files tab can subscribe to live file events for a project.
--   2. Create `get_project_folder_stats(p_project_id)` — single-query RPC
--      returning per-folder net file count + last activity. Powers the folder
--      tree without 9 round-trip Edge Function calls.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Realtime publication ─────────────────────────────────────────────
-- Idempotent: ALTER PUBLICATION ADD TABLE errors if already added, so wrap.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'project_folder_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.project_folder_events;
  END IF;
END$$;


-- ─── 2. get_project_folder_stats RPC ─────────────────────────────────────
-- Returns per-folder_kind:
--   net_file_count = file_added events − file_removed events (best-effort
--                    until move-detection is implemented; over-counts moves)
--   last_event_at  = MAX(created_at) across any event for that folder
--
-- SECURITY: SECURITY INVOKER (default) so the caller's RLS on
-- project_folder_events applies — RLS already restricts to project members.
--
-- Note: CHECK constraint on folder_kind in the table guarantees enum values.
CREATE OR REPLACE FUNCTION public.get_project_folder_stats(p_project_id UUID)
RETURNS TABLE (
  folder_kind     TEXT,
  net_file_count  INT,
  total_events    INT,
  last_event_at   TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    folder_kind,
    GREATEST(
      0,
      (COUNT(*) FILTER (WHERE event_type = 'file_added')
       - COUNT(*) FILTER (WHERE event_type = 'file_removed'))
    )::INT AS net_file_count,
    COUNT(*)::INT AS total_events,
    MAX(created_at) AS last_event_at
  FROM public.project_folder_events
  WHERE project_id = p_project_id
  GROUP BY folder_kind;
$$;

GRANT EXECUTE ON FUNCTION public.get_project_folder_stats(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_folder_stats(UUID) TO service_role;

COMMENT ON FUNCTION public.get_project_folder_stats(UUID) IS
  'Drone Phase 1 PR7a: per-folder file counts + last activity for Files tab UI. RLS-safe via SECURITY INVOKER.';

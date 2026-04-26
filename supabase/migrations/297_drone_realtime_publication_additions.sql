-- ════════════════════════════════════════════════════════════════════════
-- Migration 297 — Wave 6 Security: realtime publication additions
--
-- Stream: W6-Security
-- Closes: QC3-7 D4, QC3-8 E2E14
--
-- The frontend Pin Editor and Boundary Editor subscribe to drone_custom_pins
-- and drone_property_boundary realtime channels respectively, but neither
-- table was added to supabase_realtime. The result: another user editing
-- pins/boundary on the same project doesn't see their peer's edits until a
-- manual refresh. The 6 existing drone tables in the publication grow to 8.
--
-- Idempotent — checks pg_publication_tables before adding so re-runs are
-- safe.
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_property_boundary'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_property_boundary;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'drone_custom_pins'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drone_custom_pins;
  END IF;
END
$$;

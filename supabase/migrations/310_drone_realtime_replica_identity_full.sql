-- Wave 11 S1: REPLICA IDENTITY FULL on 5 drone tables for richer realtime payloads.
-- Logical replication will emit OLD column values on UPDATE/DELETE so realtime
-- subscribers can compute true diffs (especially for status transitions and unmark events).
--
-- Tables included (lower write volume / state-machine semantics):
--   drone_property_boundary, drone_custom_pins, drone_renders, drone_shots, drone_shoots
--
-- Tables intentionally EXCLUDED (high write volume / append-only):
--   drone_jobs, drone_sfm_runs, drone_events
--
-- Idempotent — only flips replica identity when not already FULL.

DO $$
BEGIN
  IF (SELECT relreplident FROM pg_class WHERE relname='drone_property_boundary' AND relkind='r') <> 'f' THEN
    ALTER TABLE drone_property_boundary REPLICA IDENTITY FULL;
  END IF;

  IF (SELECT relreplident FROM pg_class WHERE relname='drone_custom_pins' AND relkind='r') <> 'f' THEN
    ALTER TABLE drone_custom_pins REPLICA IDENTITY FULL;
  END IF;

  IF (SELECT relreplident FROM pg_class WHERE relname='drone_renders' AND relkind='r') <> 'f' THEN
    ALTER TABLE drone_renders REPLICA IDENTITY FULL;
  END IF;

  IF (SELECT relreplident FROM pg_class WHERE relname='drone_shots' AND relkind='r') <> 'f' THEN
    ALTER TABLE drone_shots REPLICA IDENTITY FULL;
  END IF;

  IF (SELECT relreplident FROM pg_class WHERE relname='drone_shoots' AND relkind='r') <> 'f' THEN
    ALTER TABLE drone_shoots REPLICA IDENTITY FULL;
  END IF;
END $$;

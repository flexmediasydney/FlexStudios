-- Audit follow-up to 356/357/358: the request-level task templates contained
-- two project-level tasks ("Generate and attach invoice" / "Sync Tonomo Files")
-- that already exist as project_type tasks ("Invoice Generated" / "Tonomo Syncd").
-- Every new request was duplicating them with [Revision #N] prefixes.
--
-- This migration:
--   (a) clears those two entries from request_level_task_templates so future
--       requests don't get them.
--   (b) soft-deletes the existing [Revision #N] copies (both active and
--       completed) — completed time logs stay on the rows but are filtered
--       out of the UI by the existing is_deleted guards.

-- (a) Drop the misclassified template entries from the singleton row
UPDATE request_level_task_templates
SET task_templates = COALESCE(
  (SELECT jsonb_agg(elem)
   FROM jsonb_array_elements(task_templates) AS elem
   WHERE elem->>'title' NOT IN ('Generate and attach invoice', 'Sync Tonomo Files')),
  '[]'::jsonb
);

-- (b) Soft-delete existing duplicate revision tasks that came from those templates
UPDATE project_tasks
SET is_deleted = true
WHERE is_deleted = false
  AND (
    title ~ '^\[Revision #\d+\] Generate and attach invoice'
    OR title ~ '^\[Revision #\d+\] Sync Tonomo Files'
  );

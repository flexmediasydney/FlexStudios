-- Add a proper FK linking project_tasks → project_revisions, replacing the
-- fragile "title starts with [Revision #N]" string-matching that 6+ readers
-- and writers were using. Backfill from existing title prefixes so the data
-- carries over without a flag day.

ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS revision_id UUID
    REFERENCES project_revisions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_tasks_revision_id
  ON project_tasks(revision_id)
  WHERE revision_id IS NOT NULL;

-- Backfill: pull the revision number out of the title and join to the matching
-- revision in the same project. substring() returns NULL when the prefix isn't
-- present, so non-revision tasks are skipped.
WITH parsed AS (
  SELECT
    pt.id AS task_id,
    pt.project_id,
    NULLIF(substring(pt.title FROM '^\[Revision #(\d+)\]'), '')::int AS revision_number
  FROM project_tasks pt
  WHERE pt.revision_id IS NULL
    AND pt.is_deleted = false
    AND pt.title ~ '^\[Revision #\d+\]'
)
UPDATE project_tasks pt
SET revision_id = pr.id
FROM parsed p
JOIN project_revisions pr
  ON pr.project_id = p.project_id
 AND pr.revision_number = p.revision_number
WHERE pt.id = p.task_id;

-- 476_org_notes_links_and_soft_delete.sql
--
-- Adds optional cross-entity links and soft-delete to org_notes so a note
-- (or reply) can reference the email / task / revision it's about, and so
-- notes can be removed from the activity feed without breaking thread
-- relationships (parent_note_id is ON DELETE SET NULL today).
--
-- The three FK columns are mutually exclusive (CHECK constraint). link_kind
-- + link_label are denormalised so the activity feed can render the chip
-- without a join, and so revision-vs-change_request distinction survives
-- even if the source revision row mutates later.

ALTER TABLE org_notes
  ADD COLUMN IF NOT EXISTS linked_email_id    UUID REFERENCES email_messages(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_task_id     UUID REFERENCES project_tasks(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_revision_id UUID REFERENCES project_revisions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS link_kind          TEXT,
  ADD COLUMN IF NOT EXISTS link_label         TEXT,
  ADD COLUMN IF NOT EXISTS is_deleted         BOOLEAN NOT NULL DEFAULT false;

-- link_kind values match what the UI needs to drive colour and label:
-- email | task | revision | change_request
ALTER TABLE org_notes
  DROP CONSTRAINT IF EXISTS org_notes_link_kind_check;

ALTER TABLE org_notes
  ADD CONSTRAINT org_notes_link_kind_check
  CHECK (link_kind IS NULL OR link_kind IN ('email','task','revision','change_request'));

-- Exactly zero or one link target — never two.
ALTER TABLE org_notes
  DROP CONSTRAINT IF EXISTS org_notes_link_exclusive;

ALTER TABLE org_notes
  ADD CONSTRAINT org_notes_link_exclusive
  CHECK (
    (CASE WHEN linked_email_id    IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN linked_task_id     IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN linked_revision_id IS NOT NULL THEN 1 ELSE 0 END) <= 1
  );

CREATE INDEX IF NOT EXISTS org_notes_linked_email_idx    ON org_notes(linked_email_id)    WHERE linked_email_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_notes_linked_task_idx     ON org_notes(linked_task_id)     WHERE linked_task_id     IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_notes_linked_revision_idx ON org_notes(linked_revision_id) WHERE linked_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_notes_is_deleted_idx      ON org_notes(is_deleted)         WHERE is_deleted = true;

-- Add a per-task checklist JSONB column.
--
-- Stores an array of `{ title: string, checked: boolean }` items. Optional
-- per-task: most tasks will have an empty array. Items are populated either
-- by the user inside the task detail panel, or by syncProjectTasksFromProducts
-- when a product/package/project-type task template carries its own
-- `checklist` array (templates remain JSONB blobs and need no schema change).
--
-- Default '[]' so existing rows continue to read as a normal array on the
-- client without null-guard branches.
ALTER TABLE project_tasks
  ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN project_tasks.checklist IS
  'Optional per-task checklist. Array of { title, checked }. Seeded from product/package/project_type task template.checklist on initial insert; user-editable thereafter. Subsequent template syncs do NOT overwrite this column so user-checked state is preserved.';

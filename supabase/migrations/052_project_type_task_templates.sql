-- Project-level task templates on project types.
-- Same template structure as products but no tier split (project-level tasks
-- are overhead, not pricing-dependent). Optional — empty array = no templates.
ALTER TABLE project_types ADD COLUMN IF NOT EXISTS task_templates JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN project_types.task_templates IS 'Array of task template objects (same schema as product task_templates). Applied to every project of this type.';

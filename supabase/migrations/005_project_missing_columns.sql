-- ============================================================================
-- Migration 005: Add missing columns for project management system
-- Covers: projects table, project_tasks table, task_time_logs table,
--         project_activities table, and status CHECK constraint fix
-- ============================================================================

-- ── projects: missing columns used by the frontend ──────────────────────────

-- Staff assignment type columns (user vs team)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS photographer_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS videographer_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS onsite_staff_1_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS onsite_staff_2_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS image_editor_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS video_editor_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS floorplan_editor_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS drone_editor_type TEXT;

-- Financial / delivery columns
ALTER TABLE projects ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS invoiced_amount NUMERIC(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_link TEXT;

-- Metadata columns
ALTER TABLE projects ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tonomo_is_twilight BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_date TIMESTAMPTZ;  -- legacy alias; trigger keeps in sync with created_at

-- Fix the status CHECK constraint to include 'in_production' which is used
-- by the kanban board and stage pipeline but was missing from the original schema.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (
  status IN (
    'inquiry',
    'pending_review',
    'to_be_scheduled',
    'scheduled',
    'onsite',
    'uploaded',
    'submitted',
    'in_progress',
    'in_production',
    'ready_for_partial',
    'in_revision',
    'delivered',
    'cancelled'
  )
);


-- ── project_tasks: missing columns ──────────────────────────────────────────

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS "order" BIGINT DEFAULT 0;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS is_manually_set_due_date BOOLEAN DEFAULT false;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES project_tasks(id) ON DELETE SET NULL;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS assigned_to_team_id UUID;
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS assigned_to_team_name TEXT;


-- ── task_time_logs: missing columns ─────────────────────────────────────────

ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT false;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS paused_duration INTEGER DEFAULT 0;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS team_id UUID;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS team_name TEXT;
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS task_deleted BOOLEAN DEFAULT false;


-- ── project_activities: missing columns for stage change audit ──────────────

ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS previous_state JSONB;
ALTER TABLE project_activities ADD COLUMN IF NOT EXISTS new_state JSONB;


-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_projects_payment_status ON projects(payment_status);
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_project_tasks_parent ON project_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_tasks_team ON project_tasks(assigned_to_team_id) WHERE assigned_to_team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_time_logs_user ON task_time_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_task_time_logs_manual ON task_time_logs(is_manual) WHERE is_manual = true;
CREATE INDEX IF NOT EXISTS idx_task_time_logs_task_deleted ON task_time_logs(task_deleted) WHERE task_deleted = true;


-- ── Backfill: set created_date = created_at for existing rows ───────────────

UPDATE projects SET created_date = created_at WHERE created_date IS NULL;

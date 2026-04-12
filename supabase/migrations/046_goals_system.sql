-- ============================================================================
-- 046: Goals & Roadmap System
-- ============================================================================
-- Goals are stored as rows in the `projects` table with source = 'goal'.
-- This reuses the entire task/effort/timer engine (project_tasks, task_time_logs)
-- without any duplication. Utilisation stats include goal hours automatically.
-- ============================================================================

-- 1. Extend status CHECK constraint with goal-specific statuses
--    Prefixed with 'goal_' to prevent collision with production statuses.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (
  status IN (
    -- Production statuses (unchanged)
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
    'cancelled',
    -- Goal statuses
    'goal_not_started',
    'goal_active',
    'goal_on_hold',
    'goal_completed',
    'goal_cancelled'
  )
);

-- 2. Goal-specific columns (all nullable — only populated for source='goal')
ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal_category TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal_target_quarter TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal_vision TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal_priority INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS parent_goal_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS goal_business_area TEXT;

-- 3. Performance indexes for goal queries
CREATE INDEX IF NOT EXISTS idx_projects_source ON projects(source) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_parent_goal ON projects(parent_goal_id) WHERE parent_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_goal_category ON projects(goal_category) WHERE goal_category IS NOT NULL;

-- 4. Comment for documentation
COMMENT ON COLUMN projects.goal_category IS 'Goal category: Business Development, Operations, Marketing, Technology, Learning, Client Experience';
COMMENT ON COLUMN projects.goal_target_quarter IS 'Target quarter for goal completion, e.g. Q2 2026';
COMMENT ON COLUMN projects.goal_vision IS 'Rich text vision statement / description for the goal';
COMMENT ON COLUMN projects.goal_priority IS 'Priority ranking (1=highest). Used for ordering within a category.';
COMMENT ON COLUMN projects.parent_goal_id IS 'Self-referential FK for goal hierarchy. NULL = top-level goal.';
COMMENT ON COLUMN projects.goal_business_area IS 'Which area of the business this goal serves';

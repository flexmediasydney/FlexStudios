-- Add log_source column to distinguish how a time log was created
ALTER TABLE task_time_logs ADD COLUMN IF NOT EXISTS log_source TEXT DEFAULT 'timer';

-- Backfill existing manual entries
UPDATE task_time_logs SET log_source = 'manual' WHERE is_manual = true AND (log_source IS NULL OR log_source = 'timer');

COMMENT ON COLUMN task_time_logs.log_source IS 'How this log was created: timer, manual, auto_completion, auto_onsite';

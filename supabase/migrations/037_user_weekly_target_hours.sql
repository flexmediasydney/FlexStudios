ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_target_hours DECIMAL(4,1) DEFAULT 40.0;
NOTIFY pgrst, 'reload schema';

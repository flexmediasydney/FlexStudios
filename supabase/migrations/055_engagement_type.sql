-- Add engagement_type to agencies and agents
-- Values: 'exclusive', 'non_exclusive', or NULL (not set)
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS engagement_type TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS engagement_type TEXT;

-- Fix missing columns referenced in PersonDetails UI but never created
ALTER TABLE agents ADD COLUMN IF NOT EXISTS discovery_call_notes TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reason_unqualified TEXT;

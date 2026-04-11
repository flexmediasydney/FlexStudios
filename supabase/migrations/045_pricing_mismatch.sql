-- Pricing mismatch detection: flag when Tonomo webhook prices differ from price matrix
ALTER TABLE projects ADD COLUMN IF NOT EXISTS has_pricing_mismatch BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tonomo_quoted_price DECIMAL(10,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pricing_mismatch_amount DECIMAL(10,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pricing_mismatch_details TEXT;
NOTIFY pgrst, 'reload schema';

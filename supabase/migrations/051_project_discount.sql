-- Per-project manual discount (Pipedrive-style)
-- Supports fixed $ or % discount. Defaults to $0 (no discount).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS discount_value NUMERIC(12,2) DEFAULT 0;

COMMENT ON COLUMN projects.discount_type IS 'Manual discount type: fixed ($) or percent (%)';
COMMENT ON COLUMN projects.discount_value IS 'Manual discount amount: dollar value or percentage';

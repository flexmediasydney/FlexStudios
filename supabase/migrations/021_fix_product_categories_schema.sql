-- Fix product_categories: add missing columns that the frontend expects
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS project_type_id UUID REFERENCES project_types(id) ON DELETE CASCADE;
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS project_type_name TEXT;

-- Fix project_types: add color column used by UI
ALTER TABLE project_types ADD COLUMN IF NOT EXISTS color TEXT;

-- Fix projects: add missing _flow_unmapped and _type_unmapped columns
ALTER TABLE projects ADD COLUMN IF NOT EXISTS _flow_unmapped BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS _type_unmapped BOOLEAN DEFAULT false;

-- Drop old restrictive CHECK constraint on products.category and replace with broader one
-- The old constraint only allowed: photography, video, drone, editing, virtual_staging, other
-- We need to support user-defined category names that map via lowercase+underscore conversion
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_check;

-- Create index on product_categories for project_type lookup
CREATE INDEX IF NOT EXISTS idx_product_categories_project_type ON product_categories(project_type_id);

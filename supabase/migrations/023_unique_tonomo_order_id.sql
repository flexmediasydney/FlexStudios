-- Migration 023: Add unique partial index on projects.tonomo_order_id
-- Prevents duplicate project creation from concurrent Tonomo webhooks.

-- Step 1: Handle any existing duplicates by suffixing their tonomo_order_id
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT tonomo_order_id, array_agg(id ORDER BY created_date ASC) AS ids
    FROM projects
    WHERE tonomo_order_id IS NOT NULL
    GROUP BY tonomo_order_id
    HAVING count(*) > 1
  LOOP
    -- Keep the oldest project's tonomo_order_id intact; rename duplicates
    UPDATE projects
    SET tonomo_order_id = tonomo_order_id || '_dup_' || id
    WHERE id = ANY(dup.ids[2:]);
  END LOOP;
END $$;

-- Step 2: Create the partial unique index (NULLs are excluded, so non-Tonomo projects are unaffected)
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_tonomo_order_id
  ON projects(tonomo_order_id) WHERE tonomo_order_id IS NOT NULL;

-- Allow delivery without completed tasks for Tonomo-sourced projects.
-- Tonomo sends a "delivered" webhook when deliverables are ready, and the project
-- may not have any FlexStudios tasks yet (tasks are generated later or not at all
-- for some booking types). The guard should only block manual delivery attempts
-- on non-Tonomo projects.

CREATE OR REPLACE FUNCTION guard_delivery_without_tasks()
RETURNS TRIGGER AS $$
DECLARE
  completed_count INTEGER;
BEGIN
  IF NEW.status = 'delivered' AND OLD.status IS DISTINCT FROM 'delivered' THEN
    -- Skip the check for Tonomo-sourced projects — delivery is driven by the
    -- external portal and should not be blocked by internal task state
    IF NEW.tonomo_order_id IS NOT NULL THEN
      RETURN NEW;
    END IF;

    SELECT COUNT(*) INTO completed_count
    FROM project_tasks
    WHERE project_id = NEW.id
      AND is_completed = true
      AND (is_deleted IS NULL OR is_deleted = false);

    IF completed_count = 0 THEN
      RAISE EXCEPTION 'Cannot deliver project with no completed tasks';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

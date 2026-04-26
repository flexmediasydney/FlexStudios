-- 288_drone_property_boundary_touch_jsonb_fix
--
-- Wave 5 Phase 2 / S5 hotfix to mig 283: the no-op-detection branch used
--   row_to_json(NEW.*) = row_to_json(OLD.*)
-- which fails at runtime because the json type has no equality operator
-- (`operator does not exist: json = json`). Every UPDATE on
-- drone_property_boundary therefore raised that error and rolled the txn
-- back, leaving the row unchanged. The trigger's intent — short-circuit
-- writes whose row payload is identical to the prior row to avoid version
-- churn — is preserved by switching to row_to_jsonb (jsonb has =) and using
-- IS DISTINCT FROM for NULL safety.
--
-- Discovered by drone-boundary-save smoke test 5 (reset_to_cadastral path)
-- on 2026-04-26. S1 owned the original mig but the bug blocks Stream S5
-- end-to-end so the fix lands here as a follow-on migration.

CREATE OR REPLACE FUNCTION drone_property_boundary_touch() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND row_to_json(NEW.*)::jsonb IS NOT DISTINCT FROM row_to_json(OLD.*)::jsonb THEN
    RETURN OLD;
  END IF;
  NEW.version := COALESCE(OLD.version, 0) + 1;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

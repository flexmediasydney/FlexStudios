-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 351: Stop SAFR mirror writes from triggering the CRM-edit trigger
-- ═══════════════════════════════════════════════════════════════════════════
-- Bug discovered while running the backfill for migration 350: when
-- safr_mirror_to_legacy does UPDATE agents SET name=..., the new
-- safr_record_crm_edit trigger fires and records a spurious 'manual'
-- observation — even though the column change came from SAFR, not from a
-- user edit. The pg_trigger_depth() guard didn't help because mirror_to_legacy
-- runs OUTSIDE any trigger when called from the resolver path.
--
-- Fix: a session-local GUC var. safr_mirror_to_legacy sets it to 'on'
-- around its UPDATE, the CRM-edit trigger checks it and skips. SET LOCAL
-- means the var resets at end of transaction, so other transactions
-- aren't affected.

-- Replacement for safr_mirror_to_legacy from migration 178: same logic,
-- wraps the UPDATE in safr.in_mirror=on so safr_record_crm_edit can skip.
CREATE OR REPLACE FUNCTION safr_mirror_to_legacy(
  p_entity_type text,
  p_entity_id   uuid,
  p_field_name  text,
  p_value       text
) RETURNS boolean LANGUAGE plpgsql AS $fn$
DECLARE
  m   record;
  sql text;
BEGIN
  SELECT * INTO m FROM safr_legacy_field_map
    WHERE entity_type = p_entity_type AND field_name = p_field_name;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Tell the CRM-edit trigger this is a mirror, not a user edit.
  PERFORM set_config('safr.in_mirror', 'on', true);  -- transaction-local

  sql := format(
    'UPDATE %I SET %I = $1, updated_at = now() WHERE id = $2',
    m.table_name, m.column_name
  );
  BEGIN
    EXECUTE sql USING p_value, p_entity_id;
  EXCEPTION WHEN undefined_column THEN
    sql := format('UPDATE %I SET %I = $1 WHERE id = $2', m.table_name, m.column_name);
    EXECUTE sql USING p_value, p_entity_id;
  END;

  -- Clear the flag so subsequent UPDATEs in the same txn (e.g. another
  -- field's mirror) don't pile up state. The next mirror call will SET it
  -- again. (Each field gets its own resolver→mirror call.)
  PERFORM set_config('safr.in_mirror', '', true);

  RETURN true;
END;
$fn$;

-- Replacement trigger function: now checks the GUC var.
CREATE OR REPLACE FUNCTION safr_record_crm_edit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- 1. SAFR mirror writes: skip.
  IF current_setting('safr.in_mirror', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- 2. Nested trigger context (belt & braces): skip.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'agents' THEN
    IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'email',
        NEW.email, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name AND NEW.name IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'full_name',
        NEW.name, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.title IS DISTINCT FROM OLD.title AND NEW.title IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'job_title',
        NEW.title, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL THEN
      PERFORM record_field_observation('contact', NEW.id, 'phone',
        NEW.phone, 'manual', NULL, NULL, NULL, now());
    END IF;
  ELSIF TG_TABLE_NAME = 'agencies' THEN
    IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'email',
        NEW.email, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name AND NEW.name IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'name',
        NEW.name, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'phone',
        NEW.phone, 'manual', NULL, NULL, NULL, now());
    END IF;
    IF NEW.address IS DISTINCT FROM OLD.address AND NEW.address IS NOT NULL THEN
      PERFORM record_field_observation('organization', NEW.id, 'address',
        NEW.address, 'manual', NULL, NULL, NULL, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

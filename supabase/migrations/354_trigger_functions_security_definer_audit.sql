-- 354_trigger_functions_security_definer_audit.sql
--
-- Wider audit follow-up to 353. Same root pattern:
--
--   trigger fires on user PATCH/DELETE → SECURITY INVOKER fn does
--   multi-row UPDATE/DELETE → RLS evaluates per visited row → cost
--   compounds → user's 8s statement_timeout fires → HTTP 500.
--
-- For each function below the SQL body is unchanged. Only the security
-- mode flips to DEFINER. Effect remains exactly what the SQL prescribes
-- (no dynamic SQL, no user-supplied identifiers — all inputs come from
-- the trigger's NEW/OLD records). RLS still protects who can fire the
-- triggering DML; this fix only stops RLS from being re-evaluated
-- per-row inside the trigger's bounded cleanup work.
--
-- Search path is locked to public, pg_temp on every function to defeat
-- the search_path hijack class of SECURITY DEFINER attacks.
--
-- Reverse-out plan: each function body is preserved verbatim from the
-- pre-migration definition. To revert, replay the prior CREATE OR
-- REPLACE without SECURITY DEFINER.

BEGIN;

-- ── Tier 1: project_tasks cross-row writes ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.clean_orphaned_task_deps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.is_deleted = true AND (OLD.is_deleted IS DISTINCT FROM true) THEN
    UPDATE project_tasks
    SET depends_on_task_ids = (
      SELECT jsonb_agg(dep)
      FROM jsonb_array_elements_text(depends_on_task_ids) dep
      WHERE dep::UUID != NEW.id
    )
    WHERE project_id = NEW.project_id
      AND is_deleted = false
      AND depends_on_task_ids IS NOT NULL
      AND depends_on_task_ids::text LIKE '%' || NEW.id::text || '%';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_deps_on_task_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE project_tasks
  SET depends_on_task_ids = (
    SELECT CASE WHEN jsonb_array_length(cleaned) = 0 THEN NULL ELSE cleaned END
    FROM (
      SELECT COALESCE(jsonb_agg(dep), '[]'::jsonb) AS cleaned
      FROM jsonb_array_elements_text(depends_on_task_ids) dep
      WHERE dep::UUID != OLD.id
    ) sub
  )
  WHERE project_id = OLD.project_id
    AND depends_on_task_ids IS NOT NULL
    AND depends_on_task_ids::text LIKE '%' || OLD.id::text || '%';
  RETURN OLD;
END;
$function$;

-- ── Tier 2: project lifecycle ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.clean_emails_on_project_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE email_messages SET project_id = NULL WHERE project_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stop_timers_on_project_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF (NEW.is_archived = true AND OLD.is_archived IS DISTINCT FROM true)
     OR (NEW.status IN ('cancelled', 'delivered') AND OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE task_time_logs
    SET status = 'completed',
        is_active = false,
        end_time = COALESCE(end_time, NOW()),
        total_seconds = COALESCE(total_seconds, EXTRACT(EPOCH FROM (NOW() - start_time))::INTEGER, 0)
    WHERE task_id IN (SELECT id FROM project_tasks WHERE project_id = NEW.id)
      AND status IN ('running', 'paused');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_agent_agency_to_projects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.current_agency_id IS NOT NULL AND NEW.current_agency_id IS DISTINCT FROM OLD.current_agency_id THEN
    UPDATE projects
    SET agency_id = NEW.current_agency_id, updated_at = now()
    WHERE agent_id = NEW.id AND agency_id IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── Tier 3: entity rename / delete cleanup ────────────────────────────────

CREATE OR REPLACE FUNCTION public.cascade_agency_name_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE agents SET current_agency_name = NEW.name WHERE current_agency_id = NEW.id;
    UPDATE teams  SET agency_name         = NEW.name WHERE agency_id         = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cascade_team_name_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE agents SET current_team_name = NEW.name WHERE current_team_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_denorm_on_agency_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE email_messages    SET agency_name         = NULL WHERE agency_id     = OLD.id;
  UPDATE agents            SET current_agency_name = NULL WHERE current_agency_id = OLD.id;
  UPDATE external_listings SET agency_name         = NULL WHERE agency_id     = OLD.id;
  UPDATE price_matrices    SET entity_name         = NULL WHERE entity_type = 'agency' AND entity_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_denorm_on_agent_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE email_messages    SET agent_name = NULL WHERE agent_id = OLD.id;
  UPDATE projects          SET agent_name = NULL WHERE agent_id = OLD.id;
  UPDATE external_listings SET agent_name = NULL WHERE agent_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_interactions_on_agency_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM interaction_logs WHERE entity_type = 'agency' AND entity_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_interactions_on_agent_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM interaction_logs WHERE entity_type = 'agent' AND entity_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_agent_interaction_logs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM interaction_logs WHERE entity_id = OLD.id AND entity_type = 'Agent';
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_price_matrix_on_agency_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM price_matrices WHERE entity_type = 'agency' AND entity_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_price_matrix_on_agent_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM price_matrices WHERE entity_type = 'agent' AND entity_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clean_project_type_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM price_matrices WHERE project_type_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_clear_project_user_names()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE projects SET photographer_name  = NULL WHERE photographer_id  = OLD.id;
  UPDATE projects SET videographer_name  = NULL WHERE videographer_id  = OLD.id;
  UPDATE projects SET onsite_staff_1_name = NULL WHERE onsite_staff_1_id = OLD.id;
  UPDATE projects SET onsite_staff_2_name = NULL WHERE onsite_staff_2_id = OLD.id;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_stop_user_timers_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE task_time_logs
  SET status = 'completed',
      is_active = false,
      end_time = now(),
      total_seconds = COALESCE(total_seconds, 0) + EXTRACT(EPOCH FROM (now() - COALESCE(start_time, now())))::integer
  WHERE user_id = OLD.id AND status IN ('running', 'paused');
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_clear_user_team_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE users SET internal_team_name = NULL WHERE internal_team_id = OLD.id;
  RETURN OLD;
END;
$function$;

COMMIT;

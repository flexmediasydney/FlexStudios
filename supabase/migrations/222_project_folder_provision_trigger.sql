-- Migration 222: AFTER INSERT trigger on projects → provisionProjectFolders
--
-- Phase 1 PR4 of the drone module. Every new project (created via UI, Tonomo
-- webhook, SQL insert, or any future path) automatically provisions its
-- 9-folder Dropbox skeleton + project_folders rows + audit event via the
-- provisionProjectFolders Edge Function.
--
-- Async via pg_net so a Dropbox outage cannot block project creation.
-- Idempotent — safe if the function is invoked multiple times for the same
-- project (createFolder swallows path/conflict; row upsert ignoreDuplicates).
--
-- Auth uses the same vault secret + bearer pattern as existing crons
-- (see migrations 080, 192). The function detects '__service_role__' user
-- and skips the master_admin check.
--
-- If pulse_cron_jwt is missing from vault, the trigger logs a WARNING and
-- returns NEW — the project insert still succeeds. The folders can be
-- provisioned later via manual call to provisionProjectFolders.

CREATE OR REPLACE FUNCTION trigger_provision_project_folders()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net
AS $$
DECLARE
  jwt TEXT;
BEGIN
  SELECT decrypted_secret INTO jwt
  FROM vault.decrypted_secrets
  WHERE name = 'pulse_cron_jwt'
  LIMIT 1;

  IF jwt IS NULL THEN
    RAISE WARNING 'trigger_provision_project_folders: pulse_cron_jwt missing from vault, skipping for project %', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/provisionProjectFolders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || jwt,
      'Content-Type', 'application/json',
      'x-caller-context', 'trigger:project-insert'
    ),
    body := jsonb_build_object(
      'project_id', NEW.id::text,
      'address', NEW.property_address
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provision_project_folders ON projects;
CREATE TRIGGER trg_provision_project_folders
AFTER INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION trigger_provision_project_folders();

COMMENT ON FUNCTION trigger_provision_project_folders() IS
  'Fires AFTER INSERT on projects. Calls provisionProjectFolders Edge Function via pg_net to auto-create the 9-folder Dropbox skeleton. Async/best-effort — does not block insert on failure.';

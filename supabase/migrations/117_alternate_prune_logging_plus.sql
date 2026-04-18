-- 117_alternate_prune_logging_plus.sql
-- Fixes:
--   B39  pulse_prune_alternates fires monthly silently. Wrap it so it logs
--        to pulse_sync_logs and we can see coverage + row counts in the
--        admin Data Sources tab.
--   B40  pulse_cron_jwt vault entry missing would cause cron net.http_post
--        to fire with empty Authorization -> 401 silently. Add a validator
--        function + assertion migrator that fails loudly instead.

BEGIN;

-- ── B39: logged pulse_prune_alternates wrapper ───────────────────────────
CREATE OR REPLACE FUNCTION pulse_prune_alternates_logged(p_keep_count INT DEFAULT 10)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
  v_sync_log_id UUID;
  v_result      JSONB;
BEGIN
  -- Open a sync_log row
  INSERT INTO pulse_sync_logs (
    sync_type, source_id, status, triggered_by, triggered_by_name, started_at
  )
  VALUES (
    'pulse_alternate_prune',
    'pulse_alternate_prune',
    'running',
    'cron',
    'pulse-alternate-prune:monthly',
    now()
  )
  RETURNING id INTO v_sync_log_id;

  -- Run the actual prune
  BEGIN
    v_result := pulse_prune_alternates(p_keep_count);

    UPDATE pulse_sync_logs
       SET status = 'ok',
           completed_at = now(),
           records_fetched = COALESCE((v_result->>'rows_pruned')::int, 0)
     WHERE id = v_sync_log_id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE pulse_sync_logs
       SET status = 'error',
           completed_at = now(),
           error_message = substring(SQLERRM, 1, 500)
     WHERE id = v_sync_log_id;
    RAISE;
  END;

  RETURN v_result;
END;
$func$;

COMMENT ON FUNCTION pulse_prune_alternates_logged IS
  'Wraps pulse_prune_alternates with a pulse_sync_logs entry so the monthly '
  'prune shows up in the Data Sources dashboard with row-count + duration.';

-- Swap the cron to use the logged version
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-alternate-prune') THEN
    PERFORM cron.unschedule('pulse-alternate-prune');
  END IF;
  PERFORM cron.schedule(
    'pulse-alternate-prune',
    '0 6 1 * *',
    'SELECT pulse_prune_alternates_logged(10);'
  );
END $$;

-- ── B40: vault secret existence validator ────────────────────────────────
CREATE OR REPLACE FUNCTION pulse_assert_vault_secret(p_name TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_present BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = p_name) INTO v_present;
  IF NOT v_present THEN
    RAISE EXCEPTION 'Required vault secret % is missing. Cron jobs depending on it will 401.', p_name;
  END IF;
  RETURN TRUE;
END;
$$;

-- Fail loudly NOW if pulse_cron_jwt is missing. This is the correct place
-- to catch config drift: migration time, not 4am when nobody's looking.
SELECT pulse_assert_vault_secret('pulse_cron_jwt');

COMMENT ON FUNCTION pulse_assert_vault_secret IS
  'Raises exception if named vault secret is missing. Call from migrations '
  'that install crons depending on secrets.';

COMMIT;

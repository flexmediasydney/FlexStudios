-- 458_missing_rpcs_audit_followup.sql
--
-- Two RPCs that were referenced from edge fns but never deployed to the DB.
-- Surfaced by the 2026-05-03 static QC audit. Both already had `.catch(...)`
-- fallbacks in their callers, so the missing RPCs caused silent failures
-- (silently leaked an invite-code claim; silently fell back to non-atomic
-- daily-usage manual checks that race under concurrent invocations).
--
-- 1. ai_increment_daily_usage(p_user_id uuid, p_daily_limit int)
--    Atomic per-user daily-usage increment with calendar-day rollover.
--    Caller: supabase/functions/projectAIAssistant/index.ts:389
--    Returns: { allowed: bool, daily_used: int, daily_limit: int,
--               reset_at: timestamptz }
--
-- 2. unclaim_invite_code(p_code text)
--    Atomic decrement of invite_codes.use_count with floor-at-zero guard.
--    Caller: supabase/functions/adminAuthActions/index.ts:166
--    Returns: { unclaimed: bool, use_count: int } — unclaimed=false when
--    the row didn't exist or was already at 0 (idempotent).

-- ──────────────────────────────────────────────────────────────────────────
-- 1. ai_increment_daily_usage
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_increment_daily_usage(
  p_user_id uuid,
  p_daily_limit integer
)
RETURNS TABLE (
  allowed boolean,
  daily_used integer,
  daily_limit integer,
  reset_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_today_start timestamptz := date_trunc('day', now());
  v_row record;
BEGIN
  -- Atomically reset daily_used to 0 when the previous reset was on a
  -- prior calendar day (UTC), then increment. If the row doesn't exist
  -- yet (no per-user override row), upsert one initialised at 1.
  --
  -- The sequence is FOR UPDATE within an implicit pl/pgsql transaction
  -- block — concurrent callers serialize on the row.
  SELECT id, daily_used, daily_reset_at, daily_limit AS row_daily_limit
    INTO v_row
    FROM ai_settings
   WHERE user_id = p_user_id
     AND setting_scope = 'user'
   FOR UPDATE;

  IF NOT FOUND THEN
    -- First call for this user: insert a per-user row with daily_used=1.
    INSERT INTO ai_settings (
      setting_scope, user_id, enabled, daily_limit, daily_used, daily_reset_at
    ) VALUES (
      'user', p_user_id, true, p_daily_limit, 1, v_today_start
    )
    ON CONFLICT (setting_scope, user_id) DO UPDATE
       SET daily_used = ai_settings.daily_used + 1,
           updated_at = now()
    RETURNING ai_settings.daily_used, ai_settings.daily_reset_at, ai_settings.daily_limit
      INTO v_row.daily_used, v_row.daily_reset_at, v_row.row_daily_limit;
  ELSIF v_row.daily_reset_at IS NULL OR v_row.daily_reset_at < v_today_start THEN
    -- Calendar-day rollover. Reset to 1 (this call counts as today's
    -- first usage) and stamp the reset boundary.
    UPDATE ai_settings
       SET daily_used = 1,
           daily_reset_at = v_today_start,
           updated_at = now()
     WHERE id = v_row.id
    RETURNING ai_settings.daily_used, ai_settings.daily_reset_at
      INTO v_row.daily_used, v_row.daily_reset_at;
  ELSE
    -- Same-day increment.
    UPDATE ai_settings
       SET daily_used = ai_settings.daily_used + 1,
           updated_at = now()
     WHERE id = v_row.id
    RETURNING ai_settings.daily_used, ai_settings.daily_reset_at
      INTO v_row.daily_used, v_row.daily_reset_at;
  END IF;

  -- The caller's `p_daily_limit` is what the loadAISettings helper
  -- resolved (which falls back to the global setting when no per-user
  -- override exists). We respect that as the policy ceiling so the UI
  -- and the RPC agree even when the row's own daily_limit is stale.
  RETURN QUERY
    SELECT (v_row.daily_used <= p_daily_limit) AS allowed,
           v_row.daily_used,
           p_daily_limit,
           v_row.daily_reset_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ai_increment_daily_usage(uuid, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.ai_increment_daily_usage(uuid, integer) IS
  'Atomic per-user daily-AI-usage increment with calendar-day (UTC) '
  'rollover. Returns {allowed, daily_used, daily_limit, reset_at}. Used '
  'by projectAIAssistant edge fn rate-limit gate.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. unclaim_invite_code
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.unclaim_invite_code(p_code text)
RETURNS TABLE (
  unclaimed boolean,
  use_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_row record;
BEGIN
  -- Floor-guarded decrement. The use_count >= 1 predicate prevents the
  -- atomic UPDATE from going negative under concurrent unclaim calls
  -- (which can happen when a signup retries after a transient failure).
  UPDATE invite_codes
     SET use_count = use_count - 1,
         updated_at = now()
   WHERE code = p_code
     AND use_count >= 1
  RETURNING invite_codes.use_count INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT true AS unclaimed, v_row.use_count;
  ELSE
    -- Idempotent: if the row didn't exist OR was already at 0, return
    -- false but don't error so the caller's retry path stays clean.
    RETURN QUERY SELECT false AS unclaimed, COALESCE(
      (SELECT use_count FROM invite_codes WHERE code = p_code), 0
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unclaim_invite_code(text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.unclaim_invite_code(text) IS
  'Atomic floor-guarded decrement of invite_codes.use_count. Idempotent: '
  'returns unclaimed=false if the row is missing or already at 0. Used by '
  'adminAuthActions to roll back a code claim after a signup failure.';

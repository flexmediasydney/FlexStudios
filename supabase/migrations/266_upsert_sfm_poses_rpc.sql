-- ════════════════════════════════════════════════════════════════════════
-- Migration 266 — upsert_sfm_poses(jsonb) RPC for batch SfM pose updates
-- (QC2 #11)
--
-- Note: this was originally drafted as 262 but renumbered to 266 to clear
-- a same-prefix collision with 262_backfill_drones_editors_ai_proposed_
-- enriched_folder_rows.sql that landed concurrently. The production DB
-- already has the function (applied via apply_migration MCP).
--
-- The Modal SfM worker (`sfm_http`) was issuing one PATCH per drone_shot row
-- to set sfm_pose + registered_in_sfm = true. For a 30-shot nadir grid that's
-- 30 round-trips to PostgREST, each carrying its own auth handshake — adds
-- 1-3 s of pure network latency per shoot completion.
--
-- The previous attempt at a batch POST with `Prefer: resolution=merge-
-- duplicates` failed because drone_shots has NOT NULL columns (shoot_id,
-- dropbox_path, filename, …) — PostgREST attempts the INSERT half of the
-- upsert FIRST before conflict resolution fires, so the missing-fields
-- INSERT rejects.
--
-- This migration adds an SQL function that takes a jsonb array of
-- {id, sfm_pose} entries and runs a single UPDATE … FROM via UNNEST.
-- One round-trip per shoot, ~50 ms regardless of size.
--
-- Schema:
--   payload = [
--     { "shot_id": "<uuid>", "sfm_pose": { …pose object… } },
--     ...
--   ]
--
-- Returns: integer count of rows actually updated.
--
-- Authorisation: function is SECURITY DEFINER and only callable from
-- the service role (sfm_http auths via service-role JWT). EXECUTE
-- granted to service_role only.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.upsert_sfm_poses(payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) != 'array' THEN
    RAISE EXCEPTION 'upsert_sfm_poses: payload must be a jsonb array';
  END IF;

  WITH input AS (
    SELECT
      (elem ->> 'shot_id')::uuid    AS shot_id,
      (elem ->  'sfm_pose')         AS sfm_pose
    FROM jsonb_array_elements(payload) AS elem
    WHERE elem ? 'shot_id' AND elem ? 'sfm_pose'
  ),
  upd AS (
    UPDATE public.drone_shots ds
    SET
      sfm_pose          = i.sfm_pose,
      registered_in_sfm = true
    FROM input i
    WHERE ds.id = i.shot_id
    RETURNING ds.id
  )
  SELECT COUNT(*)::integer INTO v_updated FROM upd;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_sfm_poses(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_sfm_poses(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

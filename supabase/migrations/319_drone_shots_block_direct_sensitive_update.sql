-- ════════════════════════════════════════════════════════════════════════
-- Migration 319 — Wave 12 Stream B
-- drone_shots block-direct-sensitive-update — expand mig 296 trigger to
-- cover ALL sensitive columns, not just lifecycle_state.
--
-- Background:
--   Migration 296 introduced drone_shots_block_direct_lifecycle_update()
--   bound BEFORE UPDATE on drone_shots, blocking only lifecycle_state
--   changes from non-service_role callers. Wave 12 expands the same
--   function (preserving the trigger binding from mig 296) so that any
--   write to a curated set of "ground-truth" columns is forced through
--   the canonical service-role Edge Functions:
--     - drone-shot-lifecycle    → lifecycle_state
--     - drone-ingest            → EXIF / filename / shoot_id / dji_index
--     - drone-shortlist         → is_ai_recommended + shot_role
--     - drone-render(-edited)   → edited_dropbox_path / dropbox_path
--     - drone-sfm               → registered_in_sfm + sfm_pose
--
-- Sensitive columns (verified against migrations 225/238/242/274 schema):
--   lifecycle_state       (242 — already blocked, preserved)
--   edited_dropbox_path   (242 — drone-render edited source path)
--   dropbox_path          (225 — raw drone JPG, immutable post-ingest)
--   is_ai_recommended     (242 — only the smart shortlist mutates)
--   shot_role             (225 + 238 — only ingest classifier mutates)
--   registered_in_sfm     (225)
--   sfm_pose              (225)
--   exif_raw              (225 — set at ingest only)
--   gps_lat / gps_lon     (225 — EXIF-derived)
--   gps_status            (225)
--   gimbal_pitch          (225 + 274 precision bump)
--   gimbal_roll           (225)
--   flight_yaw            (225)
--   flight_roll           (225)
--   relative_altitude     (225)
--   captured_at           (225 — EXIF-derived)
--   dji_index             (225 — DJI sequence number)
--   filename              (225)
--   shoot_id              (225 — never reparent a shot)
--
-- Function name and trigger binding from mig 296 are preserved so
-- existing dependents remain intact (CREATE OR REPLACE FUNCTION).
-- service_role callers (Edge Functions) remain exempt.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.drone_shots_block_direct_lifecycle_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_role TEXT;
BEGIN
  caller_role := COALESCE(current_setting('request.jwt.claims', true)::jsonb->>'role','');
  IF caller_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF (NEW.lifecycle_state     IS DISTINCT FROM OLD.lifecycle_state)
    OR (NEW.edited_dropbox_path IS DISTINCT FROM OLD.edited_dropbox_path)
    OR (NEW.dropbox_path        IS DISTINCT FROM OLD.dropbox_path)
    OR (NEW.is_ai_recommended   IS DISTINCT FROM OLD.is_ai_recommended)
    OR (NEW.shot_role           IS DISTINCT FROM OLD.shot_role)
    OR (NEW.registered_in_sfm   IS DISTINCT FROM OLD.registered_in_sfm)
    OR (NEW.sfm_pose            IS DISTINCT FROM OLD.sfm_pose)
    OR (NEW.exif_raw            IS DISTINCT FROM OLD.exif_raw)
    OR (NEW.gps_lat             IS DISTINCT FROM OLD.gps_lat)
    OR (NEW.gps_lon             IS DISTINCT FROM OLD.gps_lon)
    OR (NEW.gps_status          IS DISTINCT FROM OLD.gps_status)
    OR (NEW.gimbal_pitch        IS DISTINCT FROM OLD.gimbal_pitch)
    OR (NEW.gimbal_roll         IS DISTINCT FROM OLD.gimbal_roll)
    OR (NEW.flight_yaw          IS DISTINCT FROM OLD.flight_yaw)
    OR (NEW.flight_roll         IS DISTINCT FROM OLD.flight_roll)
    OR (NEW.relative_altitude   IS DISTINCT FROM OLD.relative_altitude)
    OR (NEW.captured_at         IS DISTINCT FROM OLD.captured_at)
    OR (NEW.dji_index           IS DISTINCT FROM OLD.dji_index)
    OR (NEW.filename            IS DISTINCT FROM OLD.filename)
    OR (NEW.shoot_id            IS DISTINCT FROM OLD.shoot_id)
  THEN
    RAISE EXCEPTION
      'drone_shots sensitive column mutation blocked for role=% — go through service_role Edge Functions',
      caller_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.drone_shots_block_direct_lifecycle_update() IS
  'Wave 12 B (expanded from mig 296): blocks any non-service_role mutation of lifecycle_state, edited_dropbox_path, dropbox_path, is_ai_recommended, shot_role, registered_in_sfm, sfm_pose, exif_raw, gps_lat/lon, gps_status, gimbal_pitch/roll, flight_yaw/roll, relative_altitude, captured_at, dji_index, filename, shoot_id. All meaningful drone_shots writes must flow through service_role Edge Functions (drone-shot-lifecycle, drone-ingest, drone-shortlist, drone-render, drone-sfm).';

-- Trigger binding from mig 296 is preserved (function name unchanged).
-- No CREATE TRIGGER needed; trg_drone_shots_block_direct_lifecycle is
-- already bound BEFORE UPDATE FOR EACH ROW.

NOTIFY pgrst, 'reload schema';

-- 274_drone_shots_gimbal_pitch_precision.sql
-- QC6 #26: drone_shots.gimbal_pitch was DECIMAL(6,3) — three digits past
-- the decimal, max ±999.999. EXIF stores Mavic 3 Pro gimbal pitch with
-- 5-digit fractional precision (e.g. -67.34521); our coarser column
-- silently truncated the last two digits on every ingest.
--
-- Pitch never exceeds ±90° (gimbal can't flip past straight-down/up), so
-- we have headroom for more fractional digits. DECIMAL(8,5) gives us
-- ±999.99999 — same magnitude headroom, full EXIF precision.
--
-- ALTER TABLE rewrites the column representation; on a small table this
-- is sub-second. We don't bother with VALIDATE because the new range
-- strictly contains the old.

ALTER TABLE public.drone_shots
  ALTER COLUMN gimbal_pitch TYPE numeric(8,5);

COMMENT ON COLUMN public.drone_shots.gimbal_pitch IS
  'Gimbal pitch in degrees. Range ±90° in practice; precision matches '
  'DJI EXIF output (5 fractional digits). Migration 274 widened from '
  'numeric(6,3) which silently truncated incoming EXIF values.';

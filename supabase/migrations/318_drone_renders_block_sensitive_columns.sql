-- ════════════════════════════════════════════════════════════════════════
-- Migration 318 — Wave 12 Stream A.2
-- drone_renders BEFORE UPDATE trigger — block direct sensitive-column
-- mutations from non-service_role callers.
--
-- Defense-in-depth on top of mig 317:
--   Even after RLS narrowing, manager/employee/admin retain UPDATE access
--   to drone_renders for housekeeping (e.g. property_coord_used hints).
--   But the lifecycle/state/path/theme columns must only ever change via
--   the canonical service-role Edge Functions:
--     - drone-render-approve   → column_state, approved_by/at, theme bumps
--     - drone-shot-lifecycle   → cascading column_state on rejection
--     - drone-render-edited    → pipeline + dropbox_path on edited path
--     - drone-render           → pipeline, dropbox_path, theme_id,
--                                theme_snapshot, pin_overrides,
--                                output_variant, kind on initial render
--
--   Sensitive columns (verified against information_schema.columns +
--   migrations 225/256/282):
--     - column_state    (225)
--     - pipeline        (282 — raw|edited)
--     - dropbox_path    (225)
--     - theme_id        (225)
--     - theme_snapshot  (225)
--     - pin_overrides   (225)
--     - output_variant  (225)
--     - kind            (225 — poi|boundary|poi_plus_boundary)
--     - shot_id         (225 — FK to drone_shots, never reparent)
--     - approved_by     (225)
--     - approved_at     (225)
--
--   Allowed direct fields (not blocked here): property_coord_used,
--   updated_at (mig 306, trigger-managed), created_at (immutable in
--   practice — Postgres won't reject UPDATE but no caller mutates it).
--
-- service_role exempt — Edge Functions still work unchanged.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.drone_renders_block_sensitive_column_mutation()
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

  IF (NEW.column_state    IS DISTINCT FROM OLD.column_state)
    OR (NEW.pipeline       IS DISTINCT FROM OLD.pipeline)
    OR (NEW.dropbox_path   IS DISTINCT FROM OLD.dropbox_path)
    OR (NEW.theme_id       IS DISTINCT FROM OLD.theme_id)
    OR (NEW.theme_snapshot IS DISTINCT FROM OLD.theme_snapshot)
    OR (NEW.pin_overrides  IS DISTINCT FROM OLD.pin_overrides)
    OR (NEW.output_variant IS DISTINCT FROM OLD.output_variant)
    OR (NEW.kind           IS DISTINCT FROM OLD.kind)
    OR (NEW.shot_id        IS DISTINCT FROM OLD.shot_id)
    OR (NEW.approved_by    IS DISTINCT FROM OLD.approved_by)
    OR (NEW.approved_at    IS DISTINCT FROM OLD.approved_at)
  THEN
    RAISE EXCEPTION
      'drone_renders sensitive column mutation blocked for role=% — go through service_role Edge Functions',
      caller_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.drone_renders_block_sensitive_column_mutation() IS
  'Wave 12 A.2: blocks non-service_role mutations of column_state / pipeline / dropbox_path / theme_id / theme_snapshot / pin_overrides / output_variant / kind / shot_id / approved_by / approved_at. Service-role Edge Functions are exempt.';

DROP TRIGGER IF EXISTS trg_drone_renders_block_sensitive_columns ON public.drone_renders;
CREATE TRIGGER trg_drone_renders_block_sensitive_columns
  BEFORE UPDATE ON public.drone_renders
  FOR EACH ROW
  EXECUTE FUNCTION public.drone_renders_block_sensitive_column_mutation();

NOTIFY pgrst, 'reload schema';

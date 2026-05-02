-- 416_qc_iter2_w4_p1_security_search_path.sql
-- W11.QC-iter2-W4: P1 security harden — locked search_path on 12 trigger/setter fns
-- (F-A-005 from QC-A audit). Defense in depth against schema-shadowing attacks.
--
-- Confirmed list via pg_proc query (all 12 are pronargs=0 no-arg fns):
--   calibration_session_set_updated_at                  (sec_def=false)
--   capture_human_override_as_observation               (sec_def=true)
--   engine_calibration_runs_set_updated_at              (sec_def=false)
--   engine_run_audit_set_updated_at                     (sec_def=false)
--   pulse_listing_vision_extract_recompute_trigger      (sec_def=true)
--   pulse_listings_build_search_text                    (sec_def=false)
--   pulse_pmo_touch_updated_at                          (sec_def=false)
--   shortlisting_backfill_log_set_updated_at            (sec_def=false)
--   shortlisting_room_type_suggestions_set_updated_at   (sec_def=false)
--   shortlisting_room_types_set_updated_at              (sec_def=false)
--   shortlisting_slot_suggestions_set_updated_at        (sec_def=false)
--   touch_shortlisting_prompt_versions_updated_at       (sec_def=false)

BEGIN;

ALTER FUNCTION public.calibration_session_set_updated_at()                SET search_path = public, pg_temp;
ALTER FUNCTION public.capture_human_override_as_observation()             SET search_path = public, pg_temp;
ALTER FUNCTION public.engine_calibration_runs_set_updated_at()            SET search_path = public, pg_temp;
ALTER FUNCTION public.engine_run_audit_set_updated_at()                   SET search_path = public, pg_temp;
ALTER FUNCTION public.pulse_listing_vision_extract_recompute_trigger()    SET search_path = public, pg_temp;
ALTER FUNCTION public.pulse_listings_build_search_text()                  SET search_path = public, pg_temp;
ALTER FUNCTION public.pulse_pmo_touch_updated_at()                        SET search_path = public, pg_temp;
ALTER FUNCTION public.shortlisting_backfill_log_set_updated_at()          SET search_path = public, pg_temp;
ALTER FUNCTION public.shortlisting_room_type_suggestions_set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.shortlisting_room_types_set_updated_at()            SET search_path = public, pg_temp;
ALTER FUNCTION public.shortlisting_slot_suggestions_set_updated_at()      SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_shortlisting_prompt_versions_updated_at()     SET search_path = public, pg_temp;

-- Self-test: assert all 12 fns now have search_path locked.
DO $$
DECLARE v_remaining int;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'pulse_pmo_touch_updated_at','pulse_listings_build_search_text',
        'engine_run_audit_set_updated_at','shortlisting_backfill_log_set_updated_at',
        'shortlisting_room_types_set_updated_at','shortlisting_room_type_suggestions_set_updated_at',
        'shortlisting_slot_suggestions_set_updated_at','engine_calibration_runs_set_updated_at',
        'calibration_session_set_updated_at','touch_shortlisting_prompt_versions_updated_at',
        'pulse_listing_vision_extract_recompute_trigger','capture_human_override_as_observation'
      )
      AND (p.proconfig IS NULL OR NOT array_to_string(p.proconfig, ',') LIKE '%search_path%');

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'QC-iter2-W4 search_path harden: % fns still without locked search_path (expected 0)', v_remaining;
  END IF;

  RAISE NOTICE 'QC-iter2-W4 search_path harden: all 12 fns locked OK';
END $$;

COMMIT;

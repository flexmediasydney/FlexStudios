-- 414_qc_iter2_w1_p0_sql_security.sql
-- W11.QC-iter2-Wave-1: P0 SQL/RLS security fixes from QC-A audit.
-- Closes anon-key cost amplifier (F-A-001) + pulse_listings public RLS (F-A-002)
-- + pulse_listing_missed_opportunity / pulse_listing_vision_extracts tenant scoping
-- (F-A-003) + engine_settings / shortlisting_lock_progress / shortlisting_tiers
-- RLS gaps (F-A-004).
--
-- Verified against prod (rjzdznwkxnzfekgcdkei) before authoring:
--   * Function signatures via pg_proc.proargtypes
--   * Existing policy names via pg_policies
--   * relrowsecurity flags via pg_class
--   * get_user_role() exists and is SECURITY DEFINER (returns text)

BEGIN;

-- =====================================================================
-- F-A-001: Revoke anon + authenticated EXECUTE on 3 SECURITY DEFINER fns
--          (signatures verified against prod pg_proc)
-- =====================================================================
REVOKE EXECUTE ON FUNCTION public.enqueue_shortlisting_ingest_job(uuid, integer, boolean) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resurrect_shortlisting_dead_letter_job(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.shortlisting_jobs_decrement_attempts(uuid[]) FROM anon, authenticated;

-- =====================================================================
-- F-A-002: Replace pulse_listings public-write RLS with role-based read
-- =====================================================================
DROP POLICY IF EXISTS pulse_listings_all ON pulse_listings;

CREATE POLICY pulse_listings_authenticated_read ON pulse_listings
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = ANY(ARRAY['master_admin','admin','manager','employee']::text[])
  );

CREATE POLICY pulse_listings_service_role_all ON pulse_listings
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- =====================================================================
-- F-A-003: Restrict pulse_listing_missed_opportunity + pulse_listing_vision_extracts
--          to master_admin / admin / manager only
--          (existing policy names verified: pmo_select_authenticated,
--           pulse_vision_extracts_select_authenticated)
-- =====================================================================
DROP POLICY IF EXISTS pmo_select_authenticated ON pulse_listing_missed_opportunity;
CREATE POLICY pulse_listing_missed_opportunity_admin_select ON pulse_listing_missed_opportunity
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = ANY(ARRAY['master_admin','admin','manager']::text[])
  );

DROP POLICY IF EXISTS pulse_listing_missed_opportunity_service_all ON pulse_listing_missed_opportunity;
CREATE POLICY pulse_listing_missed_opportunity_service_all ON pulse_listing_missed_opportunity
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pulse_vision_extracts_select_authenticated ON pulse_listing_vision_extracts;
CREATE POLICY pulse_listing_vision_extracts_admin_select ON pulse_listing_vision_extracts
  FOR SELECT TO authenticated
  USING (
    public.get_user_role() = ANY(ARRAY['master_admin','admin','manager']::text[])
  );

DROP POLICY IF EXISTS pulse_listing_vision_extracts_service_all ON pulse_listing_vision_extracts;
CREATE POLICY pulse_listing_vision_extracts_service_all ON pulse_listing_vision_extracts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================================
-- F-A-004: Enable RLS + revoke anon DML on engine_settings,
--          shortlisting_lock_progress, shortlisting_tiers
-- =====================================================================
ALTER TABLE engine_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE shortlisting_lock_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE shortlisting_tiers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON engine_settings FROM anon;
REVOKE ALL ON shortlisting_lock_progress FROM anon;
REVOKE ALL ON shortlisting_tiers FROM anon;

-- engine_settings: master_admin/admin SELECT, service_role full
DROP POLICY IF EXISTS engine_settings_admin_select ON engine_settings;
CREATE POLICY engine_settings_admin_select ON engine_settings
  FOR SELECT TO authenticated
  USING (public.get_user_role() = ANY(ARRAY['master_admin','admin']::text[]));

DROP POLICY IF EXISTS engine_settings_service_all ON engine_settings;
CREATE POLICY engine_settings_service_all ON engine_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- shortlisting_lock_progress: authenticated SELECT (lock state UI), service_role full
DROP POLICY IF EXISTS shortlisting_lock_progress_authenticated_select ON shortlisting_lock_progress;
CREATE POLICY shortlisting_lock_progress_authenticated_select ON shortlisting_lock_progress
  FOR SELECT TO authenticated
  USING (public.get_user_role() = ANY(ARRAY['master_admin','admin','manager','employee']::text[]));

DROP POLICY IF EXISTS shortlisting_lock_progress_service_all ON shortlisting_lock_progress;
CREATE POLICY shortlisting_lock_progress_service_all ON shortlisting_lock_progress
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- shortlisting_tiers: master_admin/admin SELECT (tier configs), service_role full
DROP POLICY IF EXISTS shortlisting_tiers_admin_select ON shortlisting_tiers;
CREATE POLICY shortlisting_tiers_admin_select ON shortlisting_tiers
  FOR SELECT TO authenticated
  USING (public.get_user_role() = ANY(ARRAY['master_admin','admin']::text[]));

DROP POLICY IF EXISTS shortlisting_tiers_service_all ON shortlisting_tiers;
CREATE POLICY shortlisting_tiers_service_all ON shortlisting_tiers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =====================================================================
-- Observability log
-- =====================================================================
DO $$
DECLARE
  v_anon_grants_remaining int;
  v_pulse_listings_policies int;
  v_engine_settings_rls bool;
BEGIN
  SELECT COUNT(*) INTO v_anon_grants_remaining
    FROM pg_proc p
    WHERE p.proname IN ('enqueue_shortlisting_ingest_job','resurrect_shortlisting_dead_letter_job','shortlisting_jobs_decrement_attempts')
      AND p.proacl::text LIKE '%anon=%';

  SELECT COUNT(*) INTO v_pulse_listings_policies
    FROM pg_policies WHERE tablename='pulse_listings';

  SELECT relrowsecurity INTO v_engine_settings_rls
    FROM pg_class WHERE relname='engine_settings';

  RAISE NOTICE
    'QC-iter2-W1 P0 SQL security: anon_grants_remaining_on_3fns=%, pulse_listings_policies=%, engine_settings_rls=%',
    v_anon_grants_remaining, v_pulse_listings_policies, v_engine_settings_rls;

  IF v_anon_grants_remaining > 0 THEN
    RAISE WARNING 'F-A-001 not fully fixed -- anon grants remain on shortlisting fns';
  END IF;
END $$;

COMMIT;

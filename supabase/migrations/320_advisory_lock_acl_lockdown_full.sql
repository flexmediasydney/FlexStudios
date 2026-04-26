-- ════════════════════════════════════════════════════════════════════════
-- Migration 320 — Wave 12 Cluster C: advisory lock ACL lockdown +
--                  drone_pois call-site fully-qualify
--
-- Stream: W12-C
--
-- Mig 296 only revoked the public.pg_try_advisory_lock SECDEF wrapper.
-- This migration revokes the underlying pg_catalog builtins from PUBLIC/
-- anon/authenticated and grants them to service_role only. Defense in
-- depth so direct DSN connections + non-PostgREST surfaces can't acquire
-- /release locks. (Numbering bumped 315 → 320 because W11-S1+S3 already
-- used 312/314.)
--
-- ALSO: fully-qualifies pg_catalog calls inside SECURITY DEFINER wrappers
-- so they don't depend on search_path resolution:
--   • drone_pois_acquire_lock / drone_pois_release_lock (mig 277b)
--   • pulse_fire_queue_claim_next                       (mig 099)
--   • pulse_merge_contact                               (mig 111)
--
-- public.pg_try_advisory_lock / public.pg_advisory_unlock (mig 293)
-- already use pg_catalog.* prefix → SKIPPED.
-- ════════════════════════════════════════════════════════════════════════


-- ── 1) REVOKE EXECUTE on pg_catalog advisory lock variants ───────────
-- 21 variants (lock/lock_shared/try/xact/unlock/unlock_shared/unlock_all).
-- EXCEPTION handler lets hosted Supabase reject the REVOKE gracefully —
-- we cannot mutate pg_catalog ownership on a managed DB, but the GRANT
-- intent is documented and the migration succeeds either way.
DO $$
DECLARE
  v TEXT;
  variants TEXT[] := ARRAY[
    'pg_advisory_lock(bigint)',
    'pg_advisory_lock(integer, integer)',
    'pg_advisory_lock_shared(bigint)',
    'pg_advisory_lock_shared(integer, integer)',
    'pg_try_advisory_lock(bigint)',
    'pg_try_advisory_lock(integer, integer)',
    'pg_try_advisory_lock_shared(bigint)',
    'pg_try_advisory_lock_shared(integer, integer)',
    'pg_advisory_xact_lock(bigint)',
    'pg_advisory_xact_lock(integer, integer)',
    'pg_advisory_xact_lock_shared(bigint)',
    'pg_advisory_xact_lock_shared(integer, integer)',
    'pg_try_advisory_xact_lock(bigint)',
    'pg_try_advisory_xact_lock(integer, integer)',
    'pg_try_advisory_xact_lock_shared(bigint)',
    'pg_try_advisory_xact_lock_shared(integer, integer)',
    'pg_advisory_unlock(bigint)',
    'pg_advisory_unlock(integer, integer)',
    'pg_advisory_unlock_shared(bigint)',
    'pg_advisory_unlock_shared(integer, integer)',
    'pg_advisory_unlock_all()'
  ];
BEGIN
  FOREACH v IN ARRAY variants LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION pg_catalog.%s FROM PUBLIC', v);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION pg_catalog.%s FROM anon', v);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION pg_catalog.%s FROM authenticated', v);
      EXECUTE format('GRANT EXECUTE ON FUNCTION pg_catalog.%s TO service_role', v);
    EXCEPTION
      WHEN undefined_function THEN
        RAISE NOTICE 'Skipping pg_catalog.% (not present)', v;
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipping pg_catalog.% (insufficient privilege - hosted DB?)', v;
      WHEN OTHERS THEN
        RAISE NOTICE 'Skipping pg_catalog.% (%)', v, SQLERRM;
    END;
  END LOOP;
END$$;

-- Best-effort marker comment (will silently no-op on hosted DB if we lack
-- ownership of pg_catalog functions).
DO $$
BEGIN
  EXECUTE $cmt$COMMENT ON FUNCTION pg_catalog.pg_advisory_lock(bigint) IS 'Wave 12 C: service-role only. See mig 320.'$cmt$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Skipping pg_catalog.pg_advisory_lock COMMENT (%)', SQLERRM;
END$$;


-- ── 2) drone_pois_acquire_lock — fully-qualify pg_advisory_lock ──────
-- Original (mig 277b) had `SET search_path = public` and unqualified
-- `pg_advisory_lock(...)`. Adds pg_catalog to search_path AND
-- fully-qualifies the call so resolution does not depend on search_path.
-- Signature preserved: VOID return, p_project_id UUID. (Architect's draft
-- proposed boolean return — we keep VOID to match the existing contract
-- and the Edge Function callers.)
CREATE OR REPLACE FUNCTION public.drone_pois_acquire_lock(
  p_project_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_lock(hashtext('drone-pois:' || p_project_id::text));
END;
$$;

COMMENT ON FUNCTION public.drone_pois_acquire_lock(UUID) IS
  'Acquire a session-scoped advisory lock for drone-pois materialise on this project. Serialises concurrent webhook invocations so supersede passes do not clobber freshly-inserted rows. Always pair with drone_pois_release_lock in a finally block. (W5 P1 / QC2-8 #9; W12 C: pg_catalog-qualified)';


-- ── 3) drone_pois_release_lock — fully-qualify pg_advisory_unlock ────
CREATE OR REPLACE FUNCTION public.drone_pois_release_lock(
  p_project_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_unlock(hashtext('drone-pois:' || p_project_id::text));
END;
$$;

COMMENT ON FUNCTION public.drone_pois_release_lock(UUID) IS
  'Release the session-scoped advisory lock paired with drone_pois_acquire_lock. Safe to call even if the lock was not held (returns false). (W5 P1 / QC2-8 #9; W12 C: pg_catalog-qualified)';

-- Reassert the W6 (mig 296) ACL: service_role only.
REVOKE EXECUTE ON FUNCTION public.drone_pois_acquire_lock(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.drone_pois_release_lock(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drone_pois_acquire_lock(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.drone_pois_release_lock(UUID) TO service_role;


-- ── 4) pulse_fire_queue_claim_next — fully-qualify pg_advisory_xact_lock ─
-- Original (mig 099) had `SET search_path = public` and unqualified
-- `pg_advisory_xact_lock(...)`. Adds pg_catalog and fully-qualifies.
-- Body and behaviour identical to mig 099.
CREATE OR REPLACE FUNCTION public.pulse_fire_queue_claim_next(
  p_source_id TEXT DEFAULT NULL,
  p_limit     INT  DEFAULT 1
) RETURNS SETOF public.pulse_fire_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  claimed_ids       UUID[];
  v_stagger_seconds INT;
  v_last_dispatch   TIMESTAMPTZ;
BEGIN
  -- Per-source atomic stagger check (see mig 099 for forensic details).
  IF p_source_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(hashtext('pulse_fire_queue_claim:' || p_source_id));

    SELECT stagger_seconds INTO v_stagger_seconds
    FROM pulse_source_configs
    WHERE source_id = p_source_id;

    IF v_stagger_seconds IS NOT NULL AND v_stagger_seconds > 0 THEN
      SELECT max(dispatched_at) INTO v_last_dispatch
      FROM pulse_fire_queue
      WHERE source_id = p_source_id
        AND dispatched_at IS NOT NULL
        AND dispatched_at > NOW() - (v_stagger_seconds || ' seconds')::interval;

      IF v_last_dispatch IS NOT NULL THEN
        RETURN;
      END IF;
    END IF;
  END IF;

  WITH eligible AS (
    SELECT q.id
    FROM pulse_fire_queue q
    WHERE q.status = 'pending'
      AND q.next_attempt_at <= NOW()
      AND (p_source_id IS NULL OR q.source_id = p_source_id)
    ORDER BY q.priority DESC, q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE pulse_fire_queue q
       SET status = 'running',
           dispatched_at = NOW(),
           attempts = q.attempts + 1
      FROM eligible
     WHERE q.id = eligible.id
    RETURNING q.id
  )
  SELECT array_agg(id) INTO claimed_ids FROM claimed;

  RETURN QUERY SELECT * FROM pulse_fire_queue WHERE id = ANY(COALESCE(claimed_ids, ARRAY[]::UUID[]));
END;
$func$;

COMMENT ON FUNCTION public.pulse_fire_queue_claim_next(TEXT, INT) IS
  'Atomic claim + stagger enforcement. Uses pg_catalog.pg_advisory_xact_lock per source_id to serialize claim attempts. Stagger interval read from pulse_source_configs. See migrations 099 (semantics) and 320 (pg_catalog-qualified).';


-- ── 5) pulse_merge_contact — fully-qualify pg_advisory_xact_lock ─────
-- Body identical to mig 111 v2; only the search_path adds pg_catalog and
-- the advisory lock call is pg_catalog-qualified.
CREATE OR REPLACE FUNCTION public.pulse_merge_contact(
  p_table         TEXT,
  p_row_id        UUID,
  p_field         TEXT,
  p_value         TEXT,
  p_source        TEXT,
  p_emit_timeline BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $func$
DECLARE
  v_normalised     TEXT;
  v_confidence     SMALLINT;
  v_primary_col    TEXT;
  v_source_col     TEXT;
  v_conf_col       TEXT;
  v_alt_col        TEXT;
  v_current_primary      TEXT;
  v_current_source       TEXT;
  v_current_confidence   SMALLINT;
  v_current_alts         JSONB;
  v_existing_alt_idx     INT;
  v_existing_alt         JSONB;
  v_new_alt_entry        JSONB;
  v_new_alts             JSONB;
  v_action               TEXT;
  v_sql                  TEXT;
  v_row_found            BOOLEAN;
  v_row_first_seen       TIMESTAMPTZ;
  v_lock_key             BIGINT;
BEGIN
  -- Input validation
  IF p_table NOT IN ('pulse_agents', 'pulse_agencies') THEN
    RAISE EXCEPTION 'invalid p_table: %', p_table;
  END IF;
  IF p_field NOT IN ('email', 'mobile', 'business_phone', 'phone') THEN
    RAISE EXCEPTION 'invalid p_field: %', p_field;
  END IF;
  IF p_table = 'pulse_agents' AND p_field = 'phone' THEN
    RAISE EXCEPTION 'pulse_agents uses mobile/business_phone, not phone';
  END IF;
  IF p_table = 'pulse_agencies' AND p_field IN ('mobile', 'business_phone') THEN
    RAISE EXCEPTION 'pulse_agencies uses phone, not %', p_field;
  END IF;

  -- Normalise value
  IF p_field = 'email' THEN
    v_normalised := pulse_normalize_email(p_value);
  ELSE
    v_normalised := pulse_normalize_phone(p_value);
  END IF;
  IF v_normalised IS NULL THEN
    RETURN jsonb_build_object('action', 'no_change', 'reason', 'invalid_value');
  END IF;

  -- B06: Advisory lock to serialise concurrent writers on this row+field.
  -- W12 C: pg_catalog-qualified so resolution does not depend on search_path.
  v_lock_key := abs(hashtextextended(p_table || ':' || p_row_id::text || ':' || p_field, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_key);

  -- Column names
  v_primary_col := p_field;
  v_source_col  := p_field || '_source';
  v_conf_col    := p_field || '_confidence';
  v_alt_col     := 'alternate_' || CASE p_field
    WHEN 'email'          THEN 'emails'
    WHEN 'mobile'         THEN 'mobiles'
    WHEN 'business_phone' THEN 'phones'
    WHEN 'phone'          THEN 'phones'
  END;

  v_confidence := pulse_source_confidence(p_source);

  -- Load current state + B05 row-exists guard
  v_sql := format(
    'SELECT %I, %I, %I, COALESCE(%I, ''[]''::jsonb), first_seen_at FROM %I WHERE id = $1',
    v_primary_col, v_source_col, v_conf_col, v_alt_col, p_table
  );
  BEGIN
    EXECUTE v_sql INTO v_current_primary, v_current_source, v_current_confidence, v_current_alts, v_row_first_seen
    USING p_row_id;
    GET DIAGNOSTICS v_row_found = ROW_COUNT;
  EXCEPTION WHEN undefined_column THEN
    v_sql := format(
      'SELECT %I, %I, %I, COALESCE(%I, ''[]''::jsonb), NULL::timestamptz FROM %I WHERE id = $1',
      v_primary_col, v_source_col, v_conf_col, v_alt_col, p_table
    );
    EXECUTE v_sql INTO v_current_primary, v_current_source, v_current_confidence, v_current_alts, v_row_first_seen
    USING p_row_id;
    GET DIAGNOSTICS v_row_found = ROW_COUNT;
  END;

  IF NOT v_row_found THEN
    RETURN jsonb_build_object('action', 'no_change', 'reason', 'row_not_found');
  END IF;

  -- Normalise existing primary for comparison
  IF v_current_primary IS NOT NULL THEN
    IF p_field = 'email' THEN
      v_current_primary := pulse_normalize_email(v_current_primary);
    ELSE
      v_current_primary := pulse_normalize_phone(v_current_primary);
    END IF;
  END IF;

  -- Path 1: primary null → set it
  IF v_current_primary IS NULL THEN
    v_sql := format(
      'UPDATE %I SET %I = $1, %I = $2, %I = $3 WHERE id = $4',
      p_table, v_primary_col, v_source_col, v_conf_col
    );
    EXECUTE v_sql USING v_normalised, p_source, v_confidence, p_row_id;
    v_action := 'primary_set_from_null';

    v_new_alt_entry := jsonb_build_object(
      'value',         v_normalised,
      'sources',       jsonb_build_array(p_source),
      'confidence',    v_confidence,
      'first_seen_at', COALESCE(v_row_first_seen, now()),
      'last_seen_at',  now()
    );
    v_sql := format('UPDATE %I SET %I = $1 WHERE id = $2', p_table, v_alt_col);
    EXECUTE v_sql USING jsonb_build_array(v_new_alt_entry), p_row_id;

    RETURN jsonb_build_object(
      'action', v_action, 'old_primary', NULL, 'new_primary', v_normalised, 'alternates_count', 1
    );
  END IF;

  -- Path 2: primary matches new value → deepen provenance
  IF v_current_primary = v_normalised THEN
    v_existing_alt_idx := NULL;
    FOR i IN 0 .. jsonb_array_length(v_current_alts) - 1 LOOP
      IF (v_current_alts -> i ->> 'value') = v_normalised THEN
        v_existing_alt_idx := i; EXIT;
      END IF;
    END LOOP;

    IF v_existing_alt_idx IS NOT NULL THEN
      v_existing_alt := v_current_alts -> v_existing_alt_idx;
      IF NOT (v_existing_alt -> 'sources' @> to_jsonb(p_source)) THEN
        v_existing_alt := jsonb_set(v_existing_alt, '{sources}',
          (v_existing_alt -> 'sources') || to_jsonb(p_source));
      END IF;
      v_existing_alt := jsonb_set(v_existing_alt, '{last_seen_at}', to_jsonb(now()::text));
      IF (v_existing_alt ->> 'confidence')::SMALLINT < v_confidence THEN
        v_existing_alt := jsonb_set(v_existing_alt, '{confidence}', to_jsonb(v_confidence));
      END IF;
      v_new_alts := jsonb_set(v_current_alts, ARRAY[v_existing_alt_idx::TEXT], v_existing_alt);
    ELSE
      v_new_alt_entry := jsonb_build_object(
        'value', v_normalised, 'sources', jsonb_build_array(p_source),
        'confidence', v_confidence, 'first_seen_at', now(), 'last_seen_at', now()
      );
      v_new_alts := v_current_alts || v_new_alt_entry;
    END IF;

    v_new_alts := pulse_alts_lru_cap(v_new_alts, 10);

    IF COALESCE(v_current_confidence, 0) < v_confidence THEN
      v_sql := format(
        'UPDATE %I SET %I = $1, %I = $2, %I = $3 WHERE id = $4',
        p_table, v_source_col, v_conf_col, v_alt_col
      );
      EXECUTE v_sql USING p_source, v_confidence, v_new_alts, p_row_id;
    ELSE
      v_sql := format('UPDATE %I SET %I = $1 WHERE id = $2', p_table, v_alt_col);
      EXECUTE v_sql USING v_new_alts, p_row_id;
    END IF;

    RETURN jsonb_build_object(
      'action', 'alt_source_deepened',
      'old_primary', v_current_primary, 'new_primary', v_current_primary,
      'alternates_count', jsonb_array_length(v_new_alts)
    );
  END IF;

  -- Path 3: primary differs from new value
  v_existing_alt_idx := NULL;
  FOR i IN 0 .. jsonb_array_length(v_current_alts) - 1 LOOP
    IF (v_current_alts -> i ->> 'value') = v_normalised THEN
      v_existing_alt_idx := i; EXIT;
    END IF;
  END LOOP;

  IF v_existing_alt_idx IS NOT NULL THEN
    v_existing_alt := v_current_alts -> v_existing_alt_idx;
    IF NOT (v_existing_alt -> 'sources' @> to_jsonb(p_source)) THEN
      v_existing_alt := jsonb_set(v_existing_alt, '{sources}',
        (v_existing_alt -> 'sources') || to_jsonb(p_source));
    END IF;
    v_existing_alt := jsonb_set(v_existing_alt, '{last_seen_at}', to_jsonb(now()::text));
    IF (v_existing_alt ->> 'confidence')::SMALLINT < v_confidence THEN
      v_existing_alt := jsonb_set(v_existing_alt, '{confidence}', to_jsonb(v_confidence));
    END IF;
    v_new_alts := jsonb_set(v_current_alts, ARRAY[v_existing_alt_idx::TEXT], v_existing_alt);
  ELSE
    v_new_alt_entry := jsonb_build_object(
      'value', v_normalised, 'sources', jsonb_build_array(p_source),
      'confidence', v_confidence, 'first_seen_at', now(), 'last_seen_at', now()
    );
    v_new_alts := v_current_alts || v_new_alt_entry;
  END IF;

  -- Promote?
  IF v_confidence > COALESCE(v_current_confidence, 0) THEN
    DECLARE
      v_old_primary_in_alts BOOL := FALSE;
      v_old_primary_entry JSONB;
      v_new_primary_idx INT := NULL;
    BEGIN
      FOR i IN 0 .. jsonb_array_length(v_new_alts) - 1 LOOP
        IF (v_new_alts -> i ->> 'value') = v_normalised THEN
          v_new_primary_idx := i; EXIT;
        END IF;
      END LOOP;
      IF v_new_primary_idx IS NOT NULL THEN
        v_existing_alt := v_new_alts -> v_new_primary_idx;
      END IF;

      FOR i IN 0 .. jsonb_array_length(v_new_alts) - 1 LOOP
        IF (v_new_alts -> i ->> 'value') = v_current_primary THEN
          v_old_primary_in_alts := TRUE; EXIT;
        END IF;
      END LOOP;

      IF NOT v_old_primary_in_alts THEN
        v_old_primary_entry := jsonb_build_object(
          'value', v_current_primary,
          'sources', jsonb_build_array(COALESCE(v_current_source, 'unknown')),
          'confidence', COALESCE(v_current_confidence, 40),
          'first_seen_at', COALESCE(v_row_first_seen, now() - INTERVAL '1 day'),
          'last_seen_at', now()
        );
        v_new_alts := v_new_alts || v_old_primary_entry;
      END IF;
    END;

    v_new_alts := pulse_alts_lru_cap(v_new_alts, 10);

    v_sql := format(
      'UPDATE %I SET %I = $1, %I = $2, %I = $3, %I = $4 WHERE id = $5',
      p_table, v_primary_col, v_source_col, v_conf_col, v_alt_col
    );
    EXECUTE v_sql USING v_normalised, p_source, v_confidence, v_new_alts, p_row_id;
    v_action := 'primary_promoted';
  ELSE
    v_new_alts := pulse_alts_lru_cap(v_new_alts, 10);
    v_sql := format('UPDATE %I SET %I = $1 WHERE id = $2', p_table, v_alt_col);
    EXECUTE v_sql USING v_new_alts, p_row_id;
    v_action := 'alt_added';
  END IF;

  RETURN jsonb_build_object(
    'action', v_action,
    'old_primary', v_current_primary,
    'new_primary', CASE WHEN v_action = 'primary_promoted' THEN v_normalised ELSE v_current_primary END,
    'alternates_count', jsonb_array_length(v_new_alts)
  );
END;
$func$;

COMMENT ON FUNCTION public.pulse_merge_contact(TEXT, UUID, TEXT, TEXT, TEXT, BOOLEAN) IS
  'v2 + W12 C: row-exists guard (B05), pg_catalog.pg_advisory_xact_lock (B06), multi-source carry on promote (B08), first_seen preservation on demote (B09), inline LRU cap (B10), table/field routing validation (B48). See migrations 111 (semantics) and 320 (pg_catalog-qualified).';

NOTIFY pgrst, 'reload schema';

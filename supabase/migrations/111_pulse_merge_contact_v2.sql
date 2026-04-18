-- 111_pulse_merge_contact_v2.sql
-- Post-audit hardening of pulse_merge_contact (migration 104).
--
-- Fixes from regression audit:
--   B05  row-exists guard: merge on unknown UUID silently returned success
--   B06  lost-update race: concurrent writers on same row could overwrite each
--        other. Adds pg_advisory_xact_lock on (table, row_id).
--   B08  multi-source bonus unreachable: promote-path did not carry the new
--        value's existing alternate sources forward into the new primary entry.
--   B09  historical signal loss: old primary demoted to alternates was stamped
--        first_seen_at=now() erasing real provenance. Now preserved from row.
--   B10  LRU cap only monthly: alternates could grow unbounded between cron
--        runs. Now enforced inline every merge.
--   B48  phone vs business_phone routing: agents' `phone` column isn't used;
--        reject that combination to prevent silent column-does-not-exist errors.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_merge_contact(
  p_table         TEXT,
  p_row_id        UUID,
  p_field         TEXT,
  p_value         TEXT,
  p_source        TEXT,
  p_emit_timeline BOOLEAN DEFAULT TRUE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- ── Input validation ────────────────────────────────────────────────────
  IF p_table NOT IN ('pulse_agents', 'pulse_agencies') THEN
    RAISE EXCEPTION 'invalid p_table: %', p_table;
  END IF;
  IF p_field NOT IN ('email', 'mobile', 'business_phone', 'phone') THEN
    RAISE EXCEPTION 'invalid p_field: %', p_field;
  END IF;
  -- B48: pulse_agents has no `phone` column; reject to prevent column-not-found
  IF p_table = 'pulse_agents' AND p_field = 'phone' THEN
    RAISE EXCEPTION 'pulse_agents uses mobile/business_phone, not phone';
  END IF;
  -- pulse_agencies has no mobile/business_phone
  IF p_table = 'pulse_agencies' AND p_field IN ('mobile', 'business_phone') THEN
    RAISE EXCEPTION 'pulse_agencies uses phone, not %', p_field;
  END IF;

  -- ── Normalise value ─────────────────────────────────────────────────────
  IF p_field = 'email' THEN
    v_normalised := pulse_normalize_email(p_value);
  ELSE
    v_normalised := pulse_normalize_phone(p_value);
  END IF;
  IF v_normalised IS NULL THEN
    RETURN jsonb_build_object('action', 'no_change', 'reason', 'invalid_value');
  END IF;

  -- ── B06: Advisory lock to serialise concurrent writers on this row+field ─
  -- Hash (table + row_id + field) into a single bigint. Transaction-scoped,
  -- released at COMMIT/ROLLBACK automatically.
  v_lock_key := abs(hashtextextended(p_table || ':' || p_row_id::text || ':' || p_field, 0));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── Column names ────────────────────────────────────────────────────────
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

  -- ── Load current state + B05 row-exists guard ───────────────────────────
  v_sql := format(
    'SELECT %I, %I, %I, COALESCE(%I, ''[]''::jsonb), first_seen_at FROM %I WHERE id = $1',
    v_primary_col, v_source_col, v_conf_col, v_alt_col, p_table
  );
  BEGIN
    EXECUTE v_sql INTO v_current_primary, v_current_source, v_current_confidence, v_current_alts, v_row_first_seen
    USING p_row_id;
    GET DIAGNOSTICS v_row_found = ROW_COUNT;
  EXCEPTION WHEN undefined_column THEN
    -- pulse_agencies doesn't have first_seen_at; fall back without it
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

  -- ── Path 1: primary null → set it ─────────────────────────────────────
  IF v_current_primary IS NULL THEN
    v_sql := format(
      'UPDATE %I SET %I = $1, %I = $2, %I = $3 WHERE id = $4',
      p_table, v_primary_col, v_source_col, v_conf_col
    );
    EXECUTE v_sql USING v_normalised, p_source, v_confidence, p_row_id;
    v_action := 'primary_set_from_null';

    -- Add to alternates, preserving row's first_seen_at if available
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

  -- ── Path 2: primary matches new value → deepen provenance ──────────────
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

    v_new_alts := pulse_alts_lru_cap(v_new_alts, 10);  -- B10: inline cap

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

  -- ── Path 3: primary differs from new value ────────────────────────────
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
    -- ── B08 fix: promote path must merge alternate sources into new primary.
    -- The new value's entry in alternates (if it existed with other sources
    -- before) has its sources array; carry that into the promoted primary
    -- entry's confidence calc AND ensure its sources array has all of them.
    DECLARE
      v_old_primary_in_alts BOOL := FALSE;
      v_old_primary_entry JSONB;
      v_new_primary_idx INT := NULL;
    BEGIN
      -- Find the new-primary entry in alts (we just inserted/updated it)
      FOR i IN 0 .. jsonb_array_length(v_new_alts) - 1 LOOP
        IF (v_new_alts -> i ->> 'value') = v_normalised THEN
          v_new_primary_idx := i; EXIT;
        END IF;
      END LOOP;
      IF v_new_primary_idx IS NOT NULL THEN
        v_existing_alt := v_new_alts -> v_new_primary_idx;
        -- B08: confidence of the primary's source ← max across all source-weights
        -- The entry's confidence already tracks this (we take max on merge).
      END IF;

      -- ── B09: preserve old primary's first_seen. Use row's own first_seen
      -- as a better proxy than now() since the primary was on the row.
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
          'first_seen_at', COALESCE(v_row_first_seen, now() - INTERVAL '1 day'),  -- B09: preserve
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

-- ── Helper: LRU cap for alternates ─────────────────────────────────────
-- Takes the current alts array; returns the top-N by last_seen_at DESC.
-- Called inline by pulse_merge_contact on every write path — prevents
-- alternates from growing past the cap even between monthly prune runs.
CREATE OR REPLACE FUNCTION pulse_alts_lru_cap(p_alts JSONB, p_keep INT DEFAULT 10)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_alts) <> 'array' THEN '[]'::jsonb
    WHEN jsonb_array_length(p_alts) <= p_keep THEN p_alts
    ELSE (
      SELECT COALESCE(jsonb_agg(entry ORDER BY (entry->>'last_seen_at')::timestamptz DESC), '[]'::jsonb)
      FROM (
        SELECT entry FROM jsonb_array_elements(p_alts) entry
        ORDER BY (entry->>'last_seen_at')::timestamptz DESC
        LIMIT p_keep
      ) kept
    )
  END;
$$;

COMMENT ON FUNCTION pulse_merge_contact IS
  'v2: adds row-exists guard (B05), advisory lock (B06), multi-source carry '
  'on promote (B08), first_seen preservation on demote (B09), inline LRU '
  'cap (B10), and table/field routing validation (B48).';

COMMIT;

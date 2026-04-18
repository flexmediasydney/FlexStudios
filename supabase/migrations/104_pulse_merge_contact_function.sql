-- 104_pulse_merge_contact_function.sql
-- Contact-value merge function: the single entry point for writing emails,
-- mobiles, and phones onto pulse_agents / pulse_agencies. Handles dedup by
-- value, source-stacking, primary promotion when a higher-confidence source
-- arrives, and LRU eviction of old alternates.
--
-- The pattern this replaces: every caller was doing ad-hoc "if primary is
-- null set it, else maybe update, else maybe append to all_emails". That
-- got us drift (primary flips, duplicate alternates, source provenance
-- lost). Single function = single source of truth.
--
-- Callers:
--   - pulseDataSync   (list-enrich: 'list_enrich' / 'cross_enrich' / 'websift_profile')
--   - pulseDetailEnrich (detail page: 'detail_page_lister' / 'detail_page_agency')
--   - cleanAgentEmails (post-hoc cleanup: 'hygiene')
--   - manual admin UI  ('manual_entry')
--
-- Return value:
--   jsonb {action: 'no_change' | 'alt_added' | 'alt_source_deepened'
--                | 'primary_promoted' | 'primary_set_from_null',
--          old_primary: text | null,
--          new_primary: text | null,
--          alternates_count: int}

BEGIN;

-- ── Source-to-confidence mapping (single source of truth) ────────────────
CREATE OR REPLACE FUNCTION pulse_source_confidence(p_source TEXT)
RETURNS SMALLINT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE p_source
    WHEN 'manual_entry'         THEN 100  -- user-entered, highest trust
    WHEN 'detail_page_lister'   THEN 95   -- REA internal canonical
    WHEN 'detail_page_agency'   THEN 90   -- REA agency object
    WHEN 'websift_profile'      THEN 90   -- agent profile page
    WHEN 'crm_import'           THEN 85   -- FlexMedia CRM linkage
    WHEN 'list_enrich'          THEN 70   -- azzouzana list search
    WHEN 'cross_enrich'         THEN 70   -- listing payload cross-enrich
    WHEN 'hygiene'              THEN 65   -- post-cleanup rewrite
    WHEN 'legacy'               THEN 60   -- pre-migration values
    WHEN 'legacy_all_emails'    THEN 50   -- pre-migration all_emails contents
    ELSE 40  -- unknown source
  END::SMALLINT;
$$;

-- ── Value normalisers ────────────────────────────────────────────────────
-- Email normalisation: lowercase, trim, drop whitespace-only.
CREATE OR REPLACE FUNCTION pulse_normalize_email(p_email TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN p_email IS NULL OR trim(p_email) = '' OR position('@' IN p_email) = 0 THEN NULL
    ELSE lower(trim(p_email))
  END;
$$;

-- Phone normalisation: strip non-digits, keep leading + if Australian intl.
CREATE OR REPLACE FUNCTION pulse_normalize_phone(p_phone TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN p_phone IS NULL OR trim(p_phone) = '' THEN NULL
    ELSE regexp_replace(trim(p_phone), '[^0-9+]', '', 'g')
  END;
$$;

-- ── The main merge function ──────────────────────────────────────────────
-- p_table:  'pulse_agents' | 'pulse_agencies'
-- p_row_id: uuid primary key
-- p_field:  'email' | 'mobile' | 'business_phone' | 'phone'
-- p_value:  raw input (will be normalised here)
-- p_source: one of the labels above
-- p_emit_timeline: reserved for future (timeline events fire in the edge
--                  function caller — DB function only returns the action).
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
BEGIN
  -- Validate inputs
  IF p_table NOT IN ('pulse_agents', 'pulse_agencies') THEN
    RAISE EXCEPTION 'invalid p_table: %', p_table;
  END IF;
  IF p_field NOT IN ('email', 'mobile', 'business_phone', 'phone') THEN
    RAISE EXCEPTION 'invalid p_field: %', p_field;
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

  -- Figure out column names
  v_primary_col := p_field;
  v_source_col  := p_field || '_source';
  v_conf_col    := p_field || '_confidence';
  v_alt_col     := 'alternate_' || CASE p_field
    WHEN 'email'          THEN 'emails'
    WHEN 'mobile'         THEN 'mobiles'
    WHEN 'business_phone' THEN 'phones'
    WHEN 'phone'          THEN 'phones'
  END;

  -- Source → confidence
  v_confidence := pulse_source_confidence(p_source);

  -- Load current state
  v_sql := format(
    'SELECT %I, %I, %I, COALESCE(%I, ''[]''::jsonb) FROM %I WHERE id = $1',
    v_primary_col, v_source_col, v_conf_col, v_alt_col, p_table
  );
  EXECUTE v_sql INTO v_current_primary, v_current_source, v_current_confidence, v_current_alts
  USING p_row_id;

  -- Normalise existing primary for comparison
  IF v_current_primary IS NOT NULL THEN
    IF p_field = 'email' THEN
      v_current_primary := pulse_normalize_email(v_current_primary);
    ELSE
      v_current_primary := pulse_normalize_phone(v_current_primary);
    END IF;
  END IF;

  -- ── Path 1: primary is null → set it ───────────────────────────────────
  IF v_current_primary IS NULL THEN
    v_sql := format(
      'UPDATE %I SET %I = $1, %I = $2, %I = $3 WHERE id = $4',
      p_table, v_primary_col, v_source_col, v_conf_col
    );
    EXECUTE v_sql USING v_normalised, p_source, v_confidence, p_row_id;
    v_action := 'primary_set_from_null';

    -- Also add to alternates (single entry, same value)
    v_new_alt_entry := jsonb_build_object(
      'value', v_normalised,
      'sources', jsonb_build_array(p_source),
      'confidence', v_confidence,
      'first_seen_at', now(),
      'last_seen_at', now()
    );
    v_sql := format('UPDATE %I SET %I = $1 WHERE id = $2', p_table, v_alt_col);
    EXECUTE v_sql USING jsonb_build_array(v_new_alt_entry), p_row_id;

    RETURN jsonb_build_object(
      'action', v_action,
      'old_primary', NULL,
      'new_primary', v_normalised,
      'alternates_count', 1
    );
  END IF;

  -- ── Path 2: primary matches new value → deepen provenance ─────────────
  IF v_current_primary = v_normalised THEN
    -- Find entry in alternates
    v_existing_alt_idx := NULL;
    FOR i IN 0 .. jsonb_array_length(v_current_alts) - 1 LOOP
      IF (v_current_alts -> i ->> 'value') = v_normalised THEN
        v_existing_alt_idx := i;
        EXIT;
      END IF;
    END LOOP;

    IF v_existing_alt_idx IS NOT NULL THEN
      -- Update existing alt: add source if new, bump last_seen_at, bump confidence
      v_existing_alt := v_current_alts -> v_existing_alt_idx;
      IF NOT (v_existing_alt -> 'sources' @> to_jsonb(p_source)) THEN
        v_existing_alt := jsonb_set(
          v_existing_alt, '{sources}',
          (v_existing_alt -> 'sources') || to_jsonb(p_source)
        );
      END IF;
      v_existing_alt := jsonb_set(v_existing_alt, '{last_seen_at}', to_jsonb(now()::text));
      IF (v_existing_alt ->> 'confidence')::SMALLINT < v_confidence THEN
        v_existing_alt := jsonb_set(v_existing_alt, '{confidence}', to_jsonb(v_confidence));
      END IF;
      v_new_alts := jsonb_set(v_current_alts, ARRAY[v_existing_alt_idx::TEXT], v_existing_alt);
    ELSE
      -- Insert new alt entry
      v_new_alt_entry := jsonb_build_object(
        'value', v_normalised,
        'sources', jsonb_build_array(p_source),
        'confidence', v_confidence,
        'first_seen_at', now(),
        'last_seen_at', now()
      );
      v_new_alts := v_current_alts || v_new_alt_entry;
    END IF;

    -- Also bump primary's confidence if new source outranks stored
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
      'old_primary', v_current_primary,
      'new_primary', v_current_primary,
      'alternates_count', jsonb_array_length(v_new_alts)
    );
  END IF;

  -- ── Path 3: primary differs from new value ────────────────────────────
  -- Three sub-cases based on confidence comparison.

  -- Always ensure the new value exists in alternates (dedup by value)
  v_existing_alt_idx := NULL;
  FOR i IN 0 .. jsonb_array_length(v_current_alts) - 1 LOOP
    IF (v_current_alts -> i ->> 'value') = v_normalised THEN
      v_existing_alt_idx := i;
      EXIT;
    END IF;
  END LOOP;

  IF v_existing_alt_idx IS NOT NULL THEN
    v_existing_alt := v_current_alts -> v_existing_alt_idx;
    IF NOT (v_existing_alt -> 'sources' @> to_jsonb(p_source)) THEN
      v_existing_alt := jsonb_set(
        v_existing_alt, '{sources}',
        (v_existing_alt -> 'sources') || to_jsonb(p_source)
      );
    END IF;
    v_existing_alt := jsonb_set(v_existing_alt, '{last_seen_at}', to_jsonb(now()::text));
    IF (v_existing_alt ->> 'confidence')::SMALLINT < v_confidence THEN
      v_existing_alt := jsonb_set(v_existing_alt, '{confidence}', to_jsonb(v_confidence));
    END IF;
    v_new_alts := jsonb_set(v_current_alts, ARRAY[v_existing_alt_idx::TEXT], v_existing_alt);
  ELSE
    v_new_alt_entry := jsonb_build_object(
      'value', v_normalised,
      'sources', jsonb_build_array(p_source),
      'confidence', v_confidence,
      'first_seen_at', now(),
      'last_seen_at', now()
    );
    v_new_alts := v_current_alts || v_new_alt_entry;
  END IF;

  -- Should we promote?
  IF v_confidence > COALESCE(v_current_confidence, 0) THEN
    -- Promote: new value becomes primary, old primary goes to alternates
    -- (if not already there) with its prior source.
    DECLARE
      v_old_primary_in_alts BOOL := FALSE;
      v_old_primary_entry JSONB;
    BEGIN
      FOR i IN 0 .. jsonb_array_length(v_new_alts) - 1 LOOP
        IF (v_new_alts -> i ->> 'value') = v_current_primary THEN
          v_old_primary_in_alts := TRUE;
          EXIT;
        END IF;
      END LOOP;

      IF NOT v_old_primary_in_alts THEN
        v_old_primary_entry := jsonb_build_object(
          'value', v_current_primary,
          'sources', jsonb_build_array(COALESCE(v_current_source, 'unknown')),
          'confidence', COALESCE(v_current_confidence, 40),
          'first_seen_at', now(),  -- we don''t know the real first_seen; stamp now
          'last_seen_at', now()
        );
        v_new_alts := v_new_alts || v_old_primary_entry;
      END IF;
    END;

    v_sql := format(
      'UPDATE %I SET %I = $1, %I = $2, %I = $3, %I = $4 WHERE id = $5',
      p_table, v_primary_col, v_source_col, v_conf_col, v_alt_col
    );
    EXECUTE v_sql USING v_normalised, p_source, v_confidence, v_new_alts, p_row_id;
    v_action := 'primary_promoted';
  ELSE
    -- Keep primary, save alt addition
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

COMMENT ON FUNCTION pulse_merge_contact IS
  'Single entry point for writing contact values (email/mobile/phone) onto '
  'pulse_agents + pulse_agencies. Handles dedup-by-value, source-stacking, '
  'primary promotion when higher-confidence source arrives. Callers: '
  'pulseDataSync, pulseDetailEnrich, cleanAgentEmails, admin UI.';

-- ── Alternates LRU eviction (keeps jsonb arrays bounded) ─────────────────
-- Called by the monthly pulse-alternate-contact-prune cron (see 109) AND
-- inline by pulse_merge_contact when adding the 11th entry. This is the
-- safety net against unbounded growth on agents who change contact details
-- frequently.
CREATE OR REPLACE FUNCTION pulse_prune_alternates(p_keep_count INT DEFAULT 10)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
  v_rows_pruned INT := 0;
  v_fields      TEXT[] := ARRAY[
    'alternate_emails',
    'alternate_mobiles',
    'alternate_phones'
  ];
  v_tables      TEXT[] := ARRAY['pulse_agents', 'pulse_agents', 'pulse_agents',
                                'pulse_agencies', 'pulse_agencies'];
  v_field       TEXT;
  v_table       TEXT;
  v_sql         TEXT;
  v_cnt         INT;
BEGIN
  -- pulse_agents: all three alt fields
  FOR v_field IN SELECT unnest(v_fields) LOOP
    v_sql := format($sql$
      UPDATE pulse_agents SET %I = (
        SELECT COALESCE(jsonb_agg(entry ORDER BY (entry->>'last_seen_at')::timestamptz DESC), '[]'::jsonb)
        FROM (
          SELECT entry FROM jsonb_array_elements(%I) entry
          ORDER BY (entry->>'last_seen_at')::timestamptz DESC
          LIMIT $1
        ) keep
      )
      WHERE %I IS NOT NULL
        AND jsonb_array_length(%I) > $1
    $sql$, v_field, v_field, v_field, v_field);
    EXECUTE v_sql USING p_keep_count;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_rows_pruned := v_rows_pruned + v_cnt;
  END LOOP;

  -- pulse_agencies: alternate_emails + alternate_phones only
  FOR v_field IN SELECT unnest(ARRAY['alternate_emails', 'alternate_phones']) LOOP
    v_sql := format($sql$
      UPDATE pulse_agencies SET %I = (
        SELECT COALESCE(jsonb_agg(entry ORDER BY (entry->>'last_seen_at')::timestamptz DESC), '[]'::jsonb)
        FROM (
          SELECT entry FROM jsonb_array_elements(%I) entry
          ORDER BY (entry->>'last_seen_at')::timestamptz DESC
          LIMIT $1
        ) keep
      )
      WHERE %I IS NOT NULL
        AND jsonb_array_length(%I) > $1
    $sql$, v_field, v_field, v_field, v_field);
    EXECUTE v_sql USING p_keep_count;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    v_rows_pruned := v_rows_pruned + v_cnt;
  END LOOP;

  RETURN jsonb_build_object('rows_pruned', v_rows_pruned, 'keep_count', p_keep_count, 'ran_at', now());
END;
$func$;

COMMENT ON FUNCTION pulse_prune_alternates IS
  'Caps alternates arrays at N entries (default 10) via LRU — keeps newest '
  'by last_seen_at. Run monthly via cron to prevent unbounded jsonb growth.';

COMMIT;

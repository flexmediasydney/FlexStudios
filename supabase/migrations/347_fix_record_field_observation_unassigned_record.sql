-- HOTFIX (2026-04-28): record_field_observation was throwing
--   "record \"v_new_promoted\" is not assigned yet"
-- whenever safr_reresolve returned a NULL promoted_id (legitimate case
-- when no source row clears the policy threshold). The function then
-- read v_new_promoted.value_normalized unconditionally, aborting every
-- call. pulseDataSync calls this RPC ~30+ times/sec → DB storm → 521s.
--
-- Fix: hold the promoted value in a plain text variable that defaults to
-- NULL, populated only when a row was found. No more record-field reads
-- on an uninitialized record.
--
-- Original definition: migration 178_entity_field_sources_schema.sql.
CREATE OR REPLACE FUNCTION record_field_observation(
  p_entity_type text,
  p_entity_id uuid,
  p_field_name text,
  p_value text,
  p_source text,
  p_source_ref_type text DEFAULT NULL,
  p_source_ref_id uuid DEFAULT NULL,
  p_confidence numeric DEFAULT NULL,
  p_observed_at timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  v_norm text;
  v_disp text;
  v_policy record;
  v_prior numeric;
  v_final_conf numeric;
  v_existing record;
  v_inserted boolean := false;
  v_updated boolean := false;
  v_resolve jsonb;
  v_new_row_id uuid;
  v_new_promoted_id uuid;
  v_new_promoted_value text;  -- ← was: v_new_promoted record;
  v_conflict boolean := false;
BEGIN
  v_norm := safr_normalize(p_field_name, p_value);
  IF v_norm IS NULL OR v_norm = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_value');
  END IF;
  v_disp := btrim(p_value);

  SELECT * INTO v_policy FROM field_merge_policies
    WHERE entity_type = p_entity_type AND field_name = p_field_name;

  IF p_confidence IS NULL THEN
    v_prior := COALESCE(
      (v_policy.source_priors ->> p_source)::numeric,
      0.5
    );
  ELSE
    v_prior := p_confidence;
  END IF;
  v_final_conf := GREATEST(LEAST(v_prior, 1.0), 0.0);

  SELECT * INTO v_existing FROM entity_field_sources
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id
      AND field_name = p_field_name AND value_normalized = v_norm
      AND source = p_source;

  IF v_existing.id IS NULL THEN
    INSERT INTO entity_field_sources (
      entity_type, entity_id, field_name, value_normalized, value_display,
      source, source_ref_type, source_ref_id, confidence,
      observed_at, first_seen_at, last_seen_at, times_seen
    ) VALUES (
      p_entity_type, p_entity_id, p_field_name, v_norm, v_disp,
      p_source, p_source_ref_type, p_source_ref_id, v_final_conf,
      p_observed_at, p_observed_at, p_observed_at, 1
    )
    RETURNING id INTO v_new_row_id;
    v_inserted := true;
  ELSE
    UPDATE entity_field_sources
      SET last_seen_at = GREATEST(last_seen_at, p_observed_at),
          observed_at = GREATEST(observed_at, p_observed_at),
          times_seen = times_seen + 1,
          confidence = GREATEST(confidence, v_final_conf),
          value_display = COALESCE(value_display, v_disp),
          source_ref_type = COALESCE(source_ref_type, p_source_ref_type),
          source_ref_id = COALESCE(source_ref_id, p_source_ref_id),
          updated_at = now(),
          status = CASE WHEN status = 'superseded' THEN 'active' ELSE status END
      WHERE id = v_existing.id
      RETURNING id INTO v_new_row_id;
    v_updated := true;
  END IF;

  v_resolve := safr_reresolve(p_entity_type, p_entity_id, p_field_name);
  v_new_promoted_id := (v_resolve ->> 'promoted_id')::uuid;

  -- Pull the promoted value into a plain text. NULL is a valid outcome —
  -- the rest of the function must tolerate it.
  IF v_new_promoted_id IS NOT NULL THEN
    SELECT value_normalized INTO v_new_promoted_value
    FROM entity_field_sources WHERE id = v_new_promoted_id;
  END IF;

  -- Conflict: at least one other active row within grace window with conf > 0.5
  SELECT EXISTS (
    SELECT 1 FROM entity_field_sources efs
    WHERE efs.entity_type = p_entity_type AND efs.entity_id = p_entity_id
      AND efs.field_name = p_field_name
      AND efs.status = 'active'
      AND efs.confidence > 0.5
      AND efs.value_normalized <> COALESCE(v_new_promoted_value, '')
      AND efs.last_seen_at > now() - make_interval(days => COALESCE(v_policy.conflict_grace_days, 30))
  ) INTO v_conflict;

  RETURN jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated', v_updated,
    'promotion_changed', (v_resolve ->> 'promotion_changed')::boolean,
    'new_promoted_value', v_new_promoted_value,
    'conflict_detected', v_conflict,
    'row_id', v_new_row_id
  );
END;
$fn$;

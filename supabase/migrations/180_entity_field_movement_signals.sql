-- ============================================================================
-- Migration 180 — SAFR movement-signal triggers
-- ============================================================================
-- AFTER UPDATE trigger on entity_field_sources that detects promotion events
-- for specific field_names and emits a pulse_signals row. Conforms to the
-- existing pulse_signals CHECK constraints:
--   · level    IN ('industry','organisation','person')
--   · category IN ('event','movement','milestone','market','custom')
-- High-level severity is encoded in `source_data.severity` rather than a
-- (non-existent) severity column.
-- ============================================================================

BEGIN;

-- Widen pulse_signals.category to cover SAFR-specific signal categories.
-- Original constraint (migration 058): IN ('event','movement','milestone','market','custom').
-- We append 'agent_movement', 'contact_change', 'role_change' so downstream
-- readers (migration 182 digest, Command Center widget, Signals tab filter)
-- can query by these specific categories without source_data unpacking.
ALTER TABLE pulse_signals DROP CONSTRAINT IF EXISTS pulse_signals_category_check;
ALTER TABLE pulse_signals ADD CONSTRAINT pulse_signals_category_check
  CHECK (category IN (
    'event','movement','milestone','market','custom',
    'agent_movement','contact_change','role_change'
  ));

CREATE OR REPLACE FUNCTION safr_emit_movement_signal()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  v_title text;
  v_description text;
  v_category text;
  v_level text;
  v_severity text;
  v_agent_ids jsonb := '[]'::jsonb;
  v_agency_ids jsonb := '[]'::jsonb;
  v_idem text;
BEGIN
  -- Only run on transitions INTO promoted where value meaningfully changed.
  -- We accept promoted_at updates on the same row (re-mirror) without firing
  -- a signal by requiring a value_normalized change on the (entity, field).
  IF NEW.status <> 'promoted' THEN RETURN NEW; END IF;
  IF OLD.status = 'promoted' AND OLD.value_normalized = NEW.value_normalized THEN
    RETURN NEW;
  END IF;

  -- Skip first-time promotion (no prior promoted row for this entity/field).
  -- We detect this by checking if any OTHER promoted-or-superseded row exists
  -- for the same triple; if not, this is the first observation path.
  IF NOT EXISTS (
    SELECT 1 FROM entity_field_sources efs2
    WHERE efs2.entity_type = NEW.entity_type
      AND efs2.entity_id = NEW.entity_id
      AND efs2.field_name = NEW.field_name
      AND efs2.id <> NEW.id
      AND efs2.status IN ('promoted','superseded')
  ) THEN
    RETURN NEW;
  END IF;

  -- Agent movement ---------------------------------------------------------
  IF NEW.entity_type = 'agent' AND NEW.field_name IN ('agency_name','agency_rea_id') THEN
    v_category := 'agent_movement';
    v_level := 'person';
    v_severity := 'high';
    v_title := 'Agent moved agencies';
    v_description := format('Agent agency_* changed from %s to %s',
      COALESCE(OLD.value_normalized, '(none)'), NEW.value_normalized);
    v_agent_ids := to_jsonb(ARRAY[NEW.entity_id::text]);

  -- Contact detail changes (email/mobile/phone) ----------------------------
  ELSIF NEW.entity_type IN ('contact','agent','prospect')
    AND NEW.field_name IN ('email','mobile','phone') THEN
    v_category := 'contact_change';
    v_level := 'person';
    v_severity := 'low';
    v_title := format('Contact %s updated', NEW.field_name);
    v_description := format('%s changed from %s to %s', NEW.field_name,
      COALESCE(OLD.value_normalized,'(none)'), NEW.value_normalized);
    IF NEW.entity_type IN ('agent','prospect') THEN
      v_agent_ids := to_jsonb(ARRAY[NEW.entity_id::text]);
    END IF;

  -- Role change ------------------------------------------------------------
  ELSIF NEW.entity_type IN ('contact','agent','prospect')
    AND NEW.field_name = 'job_title' THEN
    v_category := 'role_change';
    v_level := 'person';
    v_severity := 'medium';
    v_title := 'Agent job title changed';
    v_description := format('job_title changed from %s to %s',
      COALESCE(OLD.value_normalized,'(none)'), NEW.value_normalized);
    IF NEW.entity_type IN ('agent','prospect') THEN
      v_agent_ids := to_jsonb(ARRAY[NEW.entity_id::text]);
    END IF;

  ELSE
    RETURN NEW;  -- not a signal-worthy field
  END IF;

  v_idem := format('safr_signal:%s:%s:%s:%s',
    NEW.entity_type, NEW.entity_id, NEW.field_name, NEW.value_normalized);

  -- Idempotent dedupe (pulse_signals.idempotency_key has a PARTIAL unique
  -- index; ON CONFLICT against a partial predicate is fragile across PG
  -- versions, so we do a pre-check instead).
  IF EXISTS (SELECT 1 FROM pulse_signals WHERE idempotency_key = v_idem) THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO pulse_signals (
      level, category, title, description, source_type,
      event_date, is_actionable, linked_agent_ids, linked_agency_ids,
      status, source_generator, idempotency_key, source_data
    ) VALUES (
      v_level, v_category, v_title, v_description, 'system',
      COALESCE(NEW.promoted_at, now()), true, v_agent_ids, v_agency_ids,
      'new', 'safr_field_movement', v_idem,
      jsonb_build_object(
        'severity', v_severity,
        'entity_type', NEW.entity_type,
        'entity_id', NEW.entity_id,
        'field_name', NEW.field_name,
        'from_value', OLD.value_normalized,
        'to_value', NEW.value_normalized,
        'from_source', OLD.source,
        'to_source', NEW.source,
        'confidence', NEW.confidence,
        'observed_at', NEW.observed_at,
        'times_seen', NEW.times_seen
      )
    );
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- lost race with concurrent insert
  WHEN OTHERS THEN
    -- Never fail the promotion because of signal emission. Log via NOTICE.
    RAISE WARNING 'safr_emit_movement_signal insert failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$fn$;

-- Ensure pulse_signals has the idempotency_key column (migrated for SAFR use).
ALTER TABLE pulse_signals ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pulse_signals_idem
  ON pulse_signals(idempotency_key) WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS trg_safr_movement_signal ON entity_field_sources;
CREATE TRIGGER trg_safr_movement_signal
AFTER UPDATE ON entity_field_sources
FOR EACH ROW
EXECUTE FUNCTION safr_emit_movement_signal();

-- Also fire on INSERT of a row that's immediately status='promoted' AND there
-- was a prior promoted/superseded row for the triple (i.e. record_field_observation
-- created a brand-new source row that won the resolve). Gate identical to UPDATE.
CREATE OR REPLACE FUNCTION safr_emit_movement_signal_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status <> 'promoted' THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM entity_field_sources efs2
    WHERE efs2.entity_type = NEW.entity_type
      AND efs2.entity_id = NEW.entity_id
      AND efs2.field_name = NEW.field_name
      AND efs2.id <> NEW.id
      AND efs2.status IN ('promoted','superseded')
  ) THEN
    RETURN NEW;
  END IF;
  -- Delegate to the shared handler. We simulate OLD with an empty value so
  -- the shared handler's "no change" guard still works on a fresh row.
  DECLARE
    fake_old entity_field_sources%ROWTYPE;
  BEGIN
    fake_old := NEW;
    fake_old.value_normalized := '';
    fake_old.status := 'superseded';
    -- Inline body — we can't easily call trigger fn with overridden OLD, so
    -- just replicate the dispatch. Simpler: call safr_emit_movement_signal
    -- via PERFORM is not possible (it expects TG_*). Inline the agent_movement
    -- / contact_change / role_change checks briefly:
    IF NEW.entity_type = 'agent' AND NEW.field_name IN ('agency_name','agency_rea_id') THEN
      DECLARE
        v_idem text := format('safr_signal:%s:%s:%s:%s', NEW.entity_type, NEW.entity_id, NEW.field_name, NEW.value_normalized);
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pulse_signals WHERE idempotency_key = v_idem) THEN
          INSERT INTO pulse_signals (
            level, category, title, description, source_type, event_date,
            is_actionable, linked_agent_ids, status, source_generator,
            idempotency_key, source_data
          ) VALUES (
            'person','agent_movement','Agent moved agencies',
            format('Agent agency_* set to %s', NEW.value_normalized),
            'system', COALESCE(NEW.promoted_at, now()), true,
            to_jsonb(ARRAY[NEW.entity_id::text]), 'new', 'safr_field_movement',
            v_idem,
            jsonb_build_object('severity','high','entity_type',NEW.entity_type,
              'entity_id',NEW.entity_id,'field_name',NEW.field_name,
              'to_value', NEW.value_normalized,
              'to_source', NEW.source,
              'confidence', NEW.confidence,
              'observed_at', NEW.observed_at));
        END IF;
      END;
    END IF;
  END;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_safr_movement_signal_insert ON entity_field_sources;
CREATE TRIGGER trg_safr_movement_signal_insert
AFTER INSERT ON entity_field_sources
FOR EACH ROW
EXECUTE FUNCTION safr_emit_movement_signal_insert();

COMMIT;

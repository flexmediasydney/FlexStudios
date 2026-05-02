-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 408 — Wave 11.5: human override → raw_attribute_observation capture
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-5-human-reclassification-capture.md
--
-- Closes the W11.5 capture loop: every operator reclassification (per the
-- W11.5 backend on `composition_classification_overrides`) and every
-- shortlisting decision that names a `primary_signal_overridden` (per the
-- swimlane-review backend on `shortlisting_overrides`) is mirrored as a row
-- in `raw_attribute_observations` tagged `source_type='human_override'`.
--
-- Why DB triggers (not edge fn callbacks):
--   1. The two override tables are written from multiple call sites
--      (composition-override, approve-stage4-override, dragdrop-override,
--      manual swimlane backfills, fixture seeders). A trigger guarantees the
--      observation lands every time, regardless of caller.
--   2. The capture is a pure projection of the source row — no external I/O,
--      no LLM calls — so the trigger is cheap and deterministic.
--   3. canonical-rollup already consumes raw_attribute_observations in batch.
--      Triggers feed it the same shape as the existing internal_raw /
--      pulse_listing producers, so no rollup-side changes are required.
--
-- Idempotency / replay safety:
--   The partial unique index `uq_raw_obs_round_group_label` (mig 380) on
--   (round_id, group_id, raw_label) WHERE round_id IS NOT NULL AND group_id
--   IS NOT NULL serves as the conflict target. Re-running the trigger on
--   the same (round, group, label) UPSERTs the existing row and resets
--   raw_label_embedding/normalised_to_object_id/normalised_at/similarity_score
--   to NULL, so canonical-rollup re-processes on the next sweep.
--
-- IMPORTANT: this migration was applied to the live project on 2026-05-01
-- (remote version `20260501150251`). This file materialises that change on
-- disk for version control. It is fully idempotent — the DROP-then-recreate
-- on functions and triggers, plus the IF NOT EXISTS check on the constraint,
-- mean re-applying via `supabase db push` is safe.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extend source_type CHECK to allow 'human_override' ───────────────────
-- Drop any prior version of the CHECK that lacks 'human_override', then
-- (re-)create the canonical six-source check.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'raw_attribute_observations'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) ILIKE '%internal_raw%'
        AND pg_get_constraintdef(c.oid) NOT ILIKE '%human_override%'
  LOOP
    EXECUTE format('ALTER TABLE raw_attribute_observations DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'raw_attribute_observations'
        AND c.conname = 'raw_attribute_observations_source_type_chk'
  ) THEN
    ALTER TABLE raw_attribute_observations
      ADD CONSTRAINT raw_attribute_observations_source_type_chk
      CHECK (source_type IN (
        'internal_raw',
        'internal_finals',
        'pulse_listing',
        'pulse_floorplan',
        'manual_seed',
        'human_override'
      ));
  END IF;
END $$;

COMMENT ON CONSTRAINT raw_attribute_observations_source_type_chk
  ON raw_attribute_observations IS
  'Wave 11.5: extends mig 380 source_type CHECK with ''human_override''. '
  'human_override rows are emitted by the trg_class_override_capture and '
  'trg_shortlist_override_capture triggers (mig 408) whenever an operator '
  'reclassifies a composition or overrides a slot decision. The canonical-rollup '
  'edge fn processes these rows identically to internal_raw observations.';

-- ─── 2. Trigger fn: composition_classification_overrides → raw_obs ───────────
-- Emits up to three rows per override (room_type, composition_type,
-- vantage_point). combined_score is intentionally not captured — score is a
-- subjective per-image judgement and would pollute the canonical-feature
-- registry with non-canonical attributes. stage4_visual_override is skipped:
-- those rows are engine-emitted (not human reclassifications), captured
-- separately via shortlisting_stage4_overrides, and would cycle back into
-- the engine's prompt assembly if observed as "human_override".

CREATE OR REPLACE FUNCTION capture_human_override_as_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_excerpt TEXT;
  v_attributes JSONB;
BEGIN
  IF NEW.override_source = 'stage4_visual_override' THEN
    RETURN NEW;
  END IF;

  v_excerpt := LEFT(COALESCE(NEW.override_reason, ''), 500);

  v_attributes := jsonb_build_object(
    'override_id', NEW.id,
    'override_source', NEW.override_source,
    'actor_user_id', NEW.actor_user_id,
    'actor_at', NEW.actor_at
  );

  -- room_type
  IF NEW.human_room_type IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.human_room_type IS DISTINCT FROM OLD.human_room_type) THEN
    INSERT INTO raw_attribute_observations (
      round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
    ) VALUES (
      NEW.round_id, NEW.group_id,
      'room_type:' || NEW.human_room_type,
      'human_override', v_excerpt,
      v_attributes || jsonb_build_object('field', 'room_type', 'ai_value', NEW.ai_room_type, 'human_value', NEW.human_room_type),
      1.0
    )
    ON CONFLICT (round_id, group_id, raw_label)
      WHERE round_id IS NOT NULL AND group_id IS NOT NULL
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_excerpt = EXCLUDED.source_excerpt,
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      raw_label_embedding = NULL,
      normalised_to_object_id = NULL,
      normalised_at = NULL,
      similarity_score = NULL;
  END IF;

  -- composition_type
  IF NEW.human_composition_type IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.human_composition_type IS DISTINCT FROM OLD.human_composition_type) THEN
    INSERT INTO raw_attribute_observations (
      round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
    ) VALUES (
      NEW.round_id, NEW.group_id,
      'composition_type:' || NEW.human_composition_type,
      'human_override', v_excerpt,
      v_attributes || jsonb_build_object('field', 'composition_type', 'ai_value', NEW.ai_composition_type, 'human_value', NEW.human_composition_type),
      1.0
    )
    ON CONFLICT (round_id, group_id, raw_label)
      WHERE round_id IS NOT NULL AND group_id IS NOT NULL
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_excerpt = EXCLUDED.source_excerpt,
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      raw_label_embedding = NULL,
      normalised_to_object_id = NULL,
      normalised_at = NULL,
      similarity_score = NULL;
  END IF;

  -- vantage_point
  IF NEW.human_vantage_point IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.human_vantage_point IS DISTINCT FROM OLD.human_vantage_point) THEN
    INSERT INTO raw_attribute_observations (
      round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
    ) VALUES (
      NEW.round_id, NEW.group_id,
      'vantage_point:' || NEW.human_vantage_point,
      'human_override', v_excerpt,
      v_attributes || jsonb_build_object('field', 'vantage_point', 'ai_value', NEW.ai_vantage_point, 'human_value', NEW.human_vantage_point),
      1.0
    )
    ON CONFLICT (round_id, group_id, raw_label)
      WHERE round_id IS NOT NULL AND group_id IS NOT NULL
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_excerpt = EXCLUDED.source_excerpt,
      attributes = EXCLUDED.attributes,
      confidence = EXCLUDED.confidence,
      raw_label_embedding = NULL,
      normalised_to_object_id = NULL,
      normalised_at = NULL,
      similarity_score = NULL;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION capture_human_override_as_observation IS
  'Wave 11.5 (mig 408): trigger fn that emits raw_attribute_observations '
  'rows tagged source_type=''human_override'' for every non-null human_* '
  'field on a composition_classification_overrides row. Skips '
  'override_source=''stage4_visual_override'' (engine-emitted, not human). '
  'Idempotent via ON CONFLICT — re-running emits the same row, force-resets '
  'raw_label_embedding to drive canonical-rollup re-processing on the next '
  'sweep.';

DROP TRIGGER IF EXISTS trg_class_override_capture ON composition_classification_overrides;

CREATE TRIGGER trg_class_override_capture
  AFTER INSERT OR UPDATE ON composition_classification_overrides
  FOR EACH ROW
  EXECUTE FUNCTION capture_human_override_as_observation();

-- ─── 3. Trigger fn: shortlisting_overrides → raw_obs ─────────────────────────
-- Emits one row per swimlane override that names primary_signal_overridden,
-- anchored on ai_proposed_group_id (fallback: human_selected_group_id).
-- Skips:
--   - approved_as_proposed (no canonical signal corrected)
--   - rows with NULL/blank primary_signal_overridden
--   - rows with no group anchor

CREATE OR REPLACE FUNCTION capture_shortlist_decision_as_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label TEXT;
  v_excerpt TEXT;
  v_group_id UUID;
BEGIN
  IF NEW.human_action = 'approved_as_proposed' THEN
    RETURN NEW;
  END IF;

  IF NEW.primary_signal_overridden IS NULL OR LENGTH(TRIM(NEW.primary_signal_overridden)) = 0 THEN
    RETURN NEW;
  END IF;

  v_group_id := COALESCE(NEW.ai_proposed_group_id, NEW.human_selected_group_id);
  IF v_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_label := 'shortlist_action:' || NEW.human_action || ':' || NEW.primary_signal_overridden;
  v_excerpt := LEFT(COALESCE(NEW.override_note, NEW.override_reason, ''), 500);

  INSERT INTO raw_attribute_observations (
    round_id, group_id, raw_label, source_type, source_excerpt, attributes, confidence
  ) VALUES (
    NEW.round_id, v_group_id, v_label, 'human_override', v_excerpt,
    jsonb_build_object(
      'shortlisting_override_id', NEW.id,
      'human_action', NEW.human_action,
      'override_reason', NEW.override_reason,
      'primary_signal_overridden', NEW.primary_signal_overridden,
      'ai_proposed_group_id', NEW.ai_proposed_group_id,
      'human_selected_group_id', NEW.human_selected_group_id,
      'project_tier', NEW.project_tier
    ),
    1.0
  )
  ON CONFLICT (round_id, group_id, raw_label)
    WHERE round_id IS NOT NULL AND group_id IS NOT NULL
  DO UPDATE SET
    source_type = EXCLUDED.source_type,
    source_excerpt = EXCLUDED.source_excerpt,
    attributes = EXCLUDED.attributes,
    confidence = EXCLUDED.confidence,
    raw_label_embedding = NULL,
    normalised_to_object_id = NULL,
    normalised_at = NULL,
    similarity_score = NULL;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION capture_shortlist_decision_as_observation IS
  'Wave 11.5 (mig 408): trigger fn that emits raw_attribute_observations '
  'rows for shortlisting_overrides where the operator named a '
  'primary_signal_overridden. Skips approved_as_proposed and rows without '
  'a canonical signal. Anchored on ai_proposed_group_id (fallback: '
  'human_selected_group_id). Idempotent via ON CONFLICT.';

DROP TRIGGER IF EXISTS trg_shortlist_override_capture ON shortlisting_overrides;

CREATE TRIGGER trg_shortlist_override_capture
  AFTER INSERT ON shortlisting_overrides
  FOR EACH ROW
  EXECUTE FUNCTION capture_shortlist_decision_as_observation();

NOTIFY pgrst, 'reload schema';

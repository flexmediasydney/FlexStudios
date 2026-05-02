-- ─────────────────────────────────────────────────────────────────────────────
-- Wave 11.5 — human_override capture triggers (mig 409)
--
-- Integration test for the DB triggers that capture every operator
-- reclassification + every shortlisting decision as a row in
-- raw_attribute_observations tagged source_type='human_override'.
--
-- Spec: docs/design-specs/W11-5-human-reclassification-capture.md
-- Migration: supabase/migrations/409_w11_5_human_override_observations.sql
--
-- Scope:
--   1. composition_classification_overrides INSERT → 3 obs (room_type,
--      composition_type, vantage_point). combined_score not emitted.
--   2. composition_classification_overrides UPDATE (value change) → new obs
--      for the changed field; old obs row preserved (history not destroyed).
--   3. composition_classification_overrides UPDATE (no value change) → no-op.
--   4. override_source='stage4_visual_override' → SKIP (engine-emitted, not
--      a human reclassification).
--   5. shortlisting_overrides INSERT with primary_signal_overridden → emits
--      one obs row anchored on ai_proposed_group_id.
--   6. shortlisting_overrides INSERT with human_action='approved_as_proposed'
--      → SKIP (no canonical signal to learn).
--   7. shortlisting_overrides INSERT with NULL primary_signal_overridden →
--      SKIP (no canonical signal).
--   8. Replay safety: re-running the trigger via UPDATE produces no
--      duplicates (UPSERT on the partial unique index from mig 380).
--
-- Run from psql session against the target Supabase project:
--   psql "$DB_URL" -f supabase/tests/wave11_5_human_override_capture.sql
--
-- Each test is wrapped in a transaction that ROLLBACKs at the end so the
-- live DB stays unchanged. RAISE EXCEPTION on any assertion failure aborts
-- the transaction with a useful message; success returns silently.
--
-- Fixture data: assumes the test caller plugs in real (round, group, user,
-- project) UUIDs from a current dev/staging round. The DO blocks accept
-- placeholders; replace before run.
-- ─────────────────────────────────────────────────────────────────────────────

\echo '=== Wave 11.5 trigger capture tests ==='

-- ─── Configure these UUIDs to match your dev/staging fixture ────────────────
-- Defaults below worked on prod 2026-05-01 (Saladine round). Replace as
-- needed; they MUST be a real (round, group, group, user, project) tuple.
\set round_id    'c55374b1-1d10-4875-aaad-8dbba646ed3d'
\set group_id_a  '3b53208e-c2fe-4347-bbe5-52589690f4d0'
\set group_id_b  '65e62bb5-2aab-427f-8114-d08ab6dc379e'
\set group_id_c  'b350a69d-a1c4-42d5-b6c7-7487dd1190bf'
\set user_id     '2c40984e-3446-4e2d-b257-ed9a30f70637'
\set project_id  'b7c2c9ac-41b3-44b5-b3ec-c0cc6b63f750'

-- ─── Test 1: composition_classification_overrides INSERT → 3 obs ─────────────
\echo '-- Test 1: composition INSERT emits 3 observations'
BEGIN;
DO $$
DECLARE
  v_round_id UUID := :'round_id';
  v_group_id UUID := :'group_id_a';
  v_user_id  UUID := :'user_id';
  v_override_id UUID;
  v_obs_count INT;
  v_obs RECORD;
BEGIN
  -- pre-cleanup of any leftover state
  DELETE FROM composition_classification_overrides
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND override_source = 'stage1_correction';
  DELETE FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;

  INSERT INTO composition_classification_overrides (
    round_id, group_id, override_source,
    ai_room_type, human_room_type,
    ai_composition_type, human_composition_type,
    ai_vantage_point, human_vantage_point,
    override_reason, actor_user_id
  ) VALUES (
    v_round_id, v_group_id, 'stage1_correction',
    'exterior_front', 'exterior_rear',
    'hero_tight', 'hero_wide',
    'neutral', 'exterior_looking_in',
    'Hills Hoist clearly visible — clearly back yard, not facade', v_user_id
  ) RETURNING id INTO v_override_id;

  SELECT COUNT(*) INTO v_obs_count
    FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND source_type = 'human_override';
  ASSERT v_obs_count = 3,
    format('expected 3 obs after INSERT, got %s', v_obs_count);

  SELECT * INTO v_obs FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND raw_label = 'room_type:exterior_rear';
  ASSERT v_obs.source_type = 'human_override',
    format('source_type=%s, want human_override', v_obs.source_type);
  ASSERT v_obs.confidence = 1.0,
    format('confidence=%s, want 1.0', v_obs.confidence);
  ASSERT (v_obs.attributes->>'override_id') = v_override_id::TEXT,
    'attributes.override_id mismatch';
  ASSERT (v_obs.attributes->>'human_value') = 'exterior_rear',
    'attributes.human_value mismatch';
  ASSERT (v_obs.attributes->>'ai_value') = 'exterior_front',
    'attributes.ai_value mismatch';
END $$;
ROLLBACK;
\echo 'PASS'

-- ─── Test 2: stage4_visual_override SKIP ─────────────────────────────────────
\echo '-- Test 2: stage4_visual_override does not emit'
BEGIN;
DO $$
DECLARE
  v_round_id UUID := :'round_id';
  v_group_id UUID := :'group_id_b';
  v_obs_count INT;
BEGIN
  DELETE FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;
  INSERT INTO composition_classification_overrides (
    round_id, group_id, override_source,
    ai_room_type, human_room_type, override_reason
  ) VALUES (
    v_round_id, v_group_id, 'stage4_visual_override',
    'exterior_front', 'exterior_rear',
    'engine cross-stage correction'
  );

  SELECT COUNT(*) INTO v_obs_count FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND source_type = 'human_override';
  ASSERT v_obs_count = 0,
    format('stage4_visual_override should not emit, got %s', v_obs_count);
END $$;
ROLLBACK;
\echo 'PASS'

-- ─── Test 3: shortlisting_overrides → obs ────────────────────────────────────
\echo '-- Test 3a: shortlisting swap emits obs'
BEGIN;
DO $$
DECLARE
  v_project_id UUID := :'project_id';
  v_round_id   UUID := :'round_id';
  v_group_id   UUID := :'group_id_c';
  v_obs RECORD;
BEGIN
  DELETE FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;
  INSERT INTO shortlisting_overrides (
    project_id, round_id,
    ai_proposed_group_id, ai_proposed_slot_id, ai_proposed_score,
    human_action, human_selected_group_id,
    override_reason, override_note,
    primary_signal_overridden, project_tier
  ) VALUES (
    v_project_id, v_round_id,
    v_group_id, 'living_hero', 7.5,
    'swapped', v_group_id,
    'quality_preference', 'Composition was the real issue',
    'composition_strength', 'standard'
  );

  SELECT * INTO v_obs FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND raw_label = 'shortlist_action:swapped:composition_strength';
  ASSERT v_obs.id IS NOT NULL, 'swap did not emit obs';
  ASSERT v_obs.source_type = 'human_override',
    format('source_type=%s', v_obs.source_type);
  ASSERT (v_obs.attributes->>'human_action') = 'swapped',
    'attributes.human_action mismatch';
END $$;
ROLLBACK;
\echo 'PASS'

\echo '-- Test 3b: approved_as_proposed skipped'
BEGIN;
DO $$
DECLARE
  v_project_id UUID := :'project_id';
  v_round_id   UUID := :'round_id';
  v_group_id   UUID := :'group_id_c';
  v_obs_count  INT;
BEGIN
  DELETE FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;
  INSERT INTO shortlisting_overrides (
    project_id, round_id,
    ai_proposed_group_id, ai_proposed_slot_id, ai_proposed_score,
    human_action, human_selected_group_id,
    primary_signal_overridden
  ) VALUES (
    v_project_id, v_round_id,
    v_group_id, 'living_hero', 7.5,
    'approved_as_proposed', v_group_id,
    'composition_strength'
  );

  SELECT COUNT(*) INTO v_obs_count FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND source_type = 'human_override';
  ASSERT v_obs_count = 0,
    format('approved_as_proposed should not emit, got %s', v_obs_count);
END $$;
ROLLBACK;
\echo 'PASS'

\echo '-- Test 3c: NULL primary_signal_overridden skipped'
BEGIN;
DO $$
DECLARE
  v_project_id UUID := :'project_id';
  v_round_id   UUID := :'round_id';
  v_group_id   UUID := :'group_id_c';
  v_obs_count  INT;
BEGIN
  DELETE FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;
  INSERT INTO shortlisting_overrides (
    project_id, round_id,
    ai_proposed_group_id, ai_proposed_slot_id, ai_proposed_score,
    human_action, human_selected_group_id
  ) VALUES (
    v_project_id, v_round_id,
    v_group_id, 'living_hero', 7.5,
    'swapped', v_group_id
  );

  SELECT COUNT(*) INTO v_obs_count FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND source_type = 'human_override';
  ASSERT v_obs_count = 0,
    format('NULL primary_signal should not emit, got %s', v_obs_count);
END $$;
ROLLBACK;
\echo 'PASS'

-- ─── Test 4: Replay safety — UPDATE cycles produce no duplicates ─────────────
\echo '-- Test 4: replay-safe UPDATE cycles'
BEGIN;
DO $$
DECLARE
  v_round_id UUID := :'round_id';
  v_group_id UUID := :'group_id_a';
  v_user_id  UUID := :'user_id';
  v_override_id UUID;
  v_obs_count INT;
  v_obs_id UUID;
  v_existing_obs_id UUID;
BEGIN
  DELETE FROM composition_classification_overrides
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND override_source = 'stage1_correction';
  DELETE FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;

  INSERT INTO composition_classification_overrides (
    round_id, group_id, override_source,
    ai_room_type, human_room_type, override_reason, actor_user_id
  ) VALUES (
    v_round_id, v_group_id, 'stage1_correction',
    'exterior_front', 'exterior_rear', 'first', v_user_id
  ) RETURNING id INTO v_override_id;

  SELECT id INTO v_obs_id FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND raw_label = 'room_type:exterior_rear';

  -- Same-value UPDATE: no-op.
  UPDATE composition_classification_overrides
     SET override_reason = 'second' WHERE id = v_override_id;
  SELECT COUNT(*) INTO v_obs_count FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id;
  ASSERT v_obs_count = 1,
    format('same-value UPDATE created duplicate, got %s', v_obs_count);

  -- Value-change UPDATE: new obs row.
  UPDATE composition_classification_overrides
     SET human_room_type = 'laundry' WHERE id = v_override_id;
  SELECT COUNT(*) INTO v_obs_count FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND source_type = 'human_override';
  ASSERT v_obs_count = 2,
    format('value-change UPDATE wrong count, got %s want 2', v_obs_count);

  -- Revert UPDATE: upserts existing row, no duplicate.
  UPDATE composition_classification_overrides
     SET human_room_type = 'exterior_rear' WHERE id = v_override_id;
  SELECT COUNT(*) INTO v_obs_count FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND raw_label = 'room_type:exterior_rear';
  ASSERT v_obs_count = 1,
    format('revert UPDATE created duplicate, got %s', v_obs_count);

  SELECT id INTO v_existing_obs_id FROM raw_attribute_observations
   WHERE round_id = v_round_id AND group_id = v_group_id
     AND raw_label = 'room_type:exterior_rear';
  ASSERT v_existing_obs_id = v_obs_id,
    'revert created NEW row instead of UPSERTing existing';
END $$;
ROLLBACK;
\echo 'PASS'

\echo '=== All tests passed ==='

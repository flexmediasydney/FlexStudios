-- Migration 136: mirror pulse_signals into pulse_timeline so every signal
-- surfaces on the linked entity's dossier timeline.
--
-- Context: before this migration, pulseSignalGenerator inserted rows into
-- pulse_signals only — the Signals tab rendered them, but an operator opening
-- an agent or agency dossier saw zero record of the signal in the timeline.
-- pulseRelistDetector already mirrored its own listing_relisted rows onto the
-- listing but not onto linked agents/agencies.
--
-- Schema note: pulse_signals.linked_agent_ids and linked_agency_ids are jsonb
-- arrays (not uuid[]), so we unnest via jsonb_array_elements_text. Additional
-- pulse-native ids live in source_data.{agent_pulse_ids,agency_pulse_ids,
-- pulse_entity_id} (also jsonb).
--
-- This migration:
--   1. Registers event_type='signal_emitted' (category='signal') in the
--      pulse_timeline_event_types registry.
--   2. Backfills existing pulse_signals into pulse_timeline as signal_emitted
--      rows — one per linked entity, per known id array.
--   3. Uses idempotency_key signal_mirror:<signal_id>:<entity_type>:<entity_id>
--      so re-running, or the edge function emitting the same row forward,
--      produces no duplicates. The partial unique index
--      idx_pulse_timeline_idempotency requires the WHERE clause on the
--      ON CONFLICT target.

-- 1. Register the event type ───────────────────────────────────────────────
INSERT INTO pulse_timeline_event_types (event_type, category, description)
VALUES
  ('signal_emitted', 'signal',
   'Generated signal mirrored onto the linked entity''s dossier timeline (agent movement, agency growth, re-shoot candidate, price drop, CRM suggestion).')
ON CONFLICT (event_type) DO NOTHING;

-- 2. Backfill — linked_agent_ids (jsonb array of uuids) ────────────────────
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, event_type, event_category,
  title, description, new_value, metadata, source, created_at, idempotency_key
)
SELECT
  'agent',
  (agent_id_text)::uuid,
  'signal_emitted',
  'signal',
  ps.title,
  ps.description,
  jsonb_build_object(
    'signal_id', ps.id,
    'kind', ps.source_data->>'kind',
    'level', ps.level,
    'category', ps.category,
    'suggested_action', ps.suggested_action,
    'backfilled', true
  ),
  jsonb_build_object('signal_id', ps.id, 'kind', ps.source_data->>'kind', 'level', ps.level, 'backfilled', true),
  COALESCE(ps.source_generator, 'pulseSignalGenerator'),
  ps.created_at,
  'signal_mirror:' || ps.id || ':agent:' || agent_id_text
FROM pulse_signals ps
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(ps.linked_agent_ids, '[]'::jsonb)) AS agent_id_text
WHERE jsonb_typeof(ps.linked_agent_ids) = 'array'
  AND agent_id_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

-- 3. Backfill — linked_agency_ids (jsonb array of uuids) ───────────────────
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, event_type, event_category,
  title, description, new_value, metadata, source, created_at, idempotency_key
)
SELECT
  'agency',
  (agency_id_text)::uuid,
  'signal_emitted',
  'signal',
  ps.title,
  ps.description,
  jsonb_build_object(
    'signal_id', ps.id,
    'kind', ps.source_data->>'kind',
    'level', ps.level,
    'category', ps.category,
    'suggested_action', ps.suggested_action,
    'backfilled', true
  ),
  jsonb_build_object('signal_id', ps.id, 'kind', ps.source_data->>'kind', 'level', ps.level, 'backfilled', true),
  COALESCE(ps.source_generator, 'pulseSignalGenerator'),
  ps.created_at,
  'signal_mirror:' || ps.id || ':agency:' || agency_id_text
FROM pulse_signals ps
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(ps.linked_agency_ids, '[]'::jsonb)) AS agency_id_text
WHERE jsonb_typeof(ps.linked_agency_ids) = 'array'
  AND agency_id_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

-- 4. Backfill — source_data.agent_pulse_ids (agency_growth / relist) ───────
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, event_type, event_category,
  title, description, new_value, metadata, source, created_at, idempotency_key
)
SELECT
  'agent',
  (pid_text)::uuid,
  'signal_emitted',
  'signal',
  ps.title,
  ps.description,
  jsonb_build_object(
    'signal_id', ps.id,
    'kind', ps.source_data->>'kind',
    'level', ps.level,
    'category', ps.category,
    'suggested_action', ps.suggested_action,
    'backfilled', true
  ),
  jsonb_build_object('signal_id', ps.id, 'kind', ps.source_data->>'kind', 'level', ps.level, 'backfilled', true),
  COALESCE(ps.source_generator, 'pulseSignalGenerator'),
  ps.created_at,
  'signal_mirror:' || ps.id || ':agent:' || pid_text
FROM pulse_signals ps
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(ps.source_data->'agent_pulse_ids', '[]'::jsonb)) AS pid_text
WHERE jsonb_typeof(ps.source_data->'agent_pulse_ids') = 'array'
  AND pid_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

-- 5. Backfill — source_data.agency_pulse_ids (relist) ──────────────────────
INSERT INTO pulse_timeline (
  entity_type, pulse_entity_id, event_type, event_category,
  title, description, new_value, metadata, source, created_at, idempotency_key
)
SELECT
  'agency',
  (pid_text)::uuid,
  'signal_emitted',
  'signal',
  ps.title,
  ps.description,
  jsonb_build_object(
    'signal_id', ps.id,
    'kind', ps.source_data->>'kind',
    'level', ps.level,
    'category', ps.category,
    'suggested_action', ps.suggested_action,
    'backfilled', true
  ),
  jsonb_build_object('signal_id', ps.id, 'kind', ps.source_data->>'kind', 'level', ps.level, 'backfilled', true),
  COALESCE(ps.source_generator, 'pulseSignalGenerator'),
  ps.created_at,
  'signal_mirror:' || ps.id || ':agency:' || pid_text
FROM pulse_signals ps
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(ps.source_data->'agency_pulse_ids', '[]'::jsonb)) AS pid_text
WHERE jsonb_typeof(ps.source_data->'agency_pulse_ids') = 'array'
  AND pid_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

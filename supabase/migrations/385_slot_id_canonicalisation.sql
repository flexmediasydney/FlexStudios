-- 383_slot_id_canonicalisation.sql — W11.7.1 hygiene
--
-- Backfill `shortlisting_overrides.ai_proposed_slot_id` + `slot_group_id`
-- through the canonical alias map. Stage 4 has been emitting free-form
-- slot_id strings that drift across regen runs (e.g. `master_bedroom` vs
-- `master_bedroom_hero`, `living_dining_hero` vs `living_hero`,
-- `exterior_rear_hero` vs `exterior_rear`). The downstream swimlane keys
-- off slot_id, so dupes fragment the lane.
--
-- This migration:
--   1. Normalises every existing AI-proposed row's slot_id to the canonical
--      form (matching the runtime alias map in
--      supabase/functions/_shared/visionPrompts/blocks/slotEnumeration.ts).
--   2. Same normalisation applied to the legacy `slot_group_id` text field
--      (kept in lockstep with `ai_proposed_slot_id` under shape D).
--   3. Same for the human-edited counterparts `human_selected_slot_id` —
--      operators historically picked from the same drift set.
--
-- Deliberately NOT a CHECK constraint on the column: the canonical enum is
-- evolving (we may add `theatre_hero`, `wine_cellar_hero`, etc. as we hit new
-- typologies). The runtime layer (Stage 4 enum schema + persist-time
-- normalise) is the source of truth; this migration is one-shot cleanup.

BEGIN;

-- Build a temporary alias map matching slotEnumeration.ts. Two-column form
-- so we can apply via a single UPDATE..FROM.
CREATE TEMPORARY TABLE _slot_alias_map (
  alias_id text PRIMARY KEY,
  canonical_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO _slot_alias_map (alias_id, canonical_id) VALUES
  -- _hero suffix drift
  ('master_bedroom',         'master_bedroom_hero'),
  ('exterior_facade',        'exterior_facade_hero'),
  ('exterior_rear_hero',     'exterior_rear'),
  ('kitchen',                'kitchen_hero'),
  ('living',                 'living_hero'),
  ('dining',                 'dining_hero'),
  ('alfresco',               'alfresco_hero'),
  ('ensuite',                'ensuite_hero'),
  ('entry',                  'entry_hero'),
  ('study',                  'study_hero'),
  ('study_office',           'study_hero'),
  ('view',                   'view_hero'),
  ('pool',                   'pool_hero'),
  ('laundry',                'laundry_hero'),
  ('garage',                 'garage_hero'),
  ('bathroom',               'bathroom_main'),

  -- Compound-room collapse
  ('living_dining_hero',     'living_hero'),
  ('living_dining',          'living_hero'),
  ('open_plan_hero',         'living_hero'),
  ('open_plan',              'living_hero'),
  ('kitchen_living_hero',    'kitchen_hero'),
  ('kitchen_dining_hero',    'kitchen_hero'),

  -- Synonyms — exterior
  ('exterior_front_hero',    'exterior_facade_hero'),
  ('exterior_front',         'exterior_facade_hero'),
  ('facade_hero',            'exterior_facade_hero'),
  ('facade',                 'exterior_facade_hero'),
  ('street_view_hero',       'exterior_facade_hero'),
  ('exterior_back',          'exterior_rear'),
  ('exterior_back_hero',     'exterior_rear'),
  ('rear_hero',              'exterior_rear'),
  ('backyard_hero',          'exterior_rear'),
  ('backyard',               'exterior_rear'),

  -- Synonyms — alfresco / outdoor
  ('alfresco_outdoor_hero',  'alfresco_hero'),
  ('outdoor_hero',           'alfresco_hero'),
  ('outdoor',                'alfresco_hero'),
  ('patio_hero',             'alfresco_hero'),
  ('deck_hero',              'alfresco_hero'),
  ('balcony_terrace_hero',   'balcony_terrace'),
  ('balcony_hero',           'balcony_terrace'),
  ('terrace_hero',           'balcony_terrace'),

  -- Synonyms — bedrooms / bathrooms
  ('bedroom_2',              'bedroom_secondary'),
  ('bedroom_3',              'bedroom_secondary'),
  ('bedroom_4',              'bedroom_secondary'),
  ('secondary_bedroom',      'bedroom_secondary'),
  ('guest_bedroom',          'bedroom_secondary'),
  ('primary_bedroom',        'master_bedroom_hero'),
  ('primary_bedroom_hero',   'master_bedroom_hero'),
  ('main_bedroom',           'master_bedroom_hero'),
  ('main_bedroom_hero',      'master_bedroom_hero'),
  ('bathroom_hero',          'bathroom_main'),
  ('main_bathroom',          'bathroom_main'),
  ('main_bathroom_hero',     'bathroom_main'),
  ('ensuite_main',           'ensuite_hero'),

  -- Synonyms — Phase 3
  ('detail_hero',            'material_detail'),
  ('material_hero',          'material_detail'),
  ('garden_hero',            'garden_detail'),
  ('landscape_detail',       'garden_detail'),
  ('kitchen_detail_hero',    'kitchen_detail'),
  ('bathroom_detail_hero',   'bathroom_detail'),
  ('games_room_hero',        'games_room'),
  ('media_room_hero',        'media_room'),
  ('cinema_room',            'media_room'),
  ('cinema_room_hero',       'media_room'),
  ('rumpus_room',            'games_room'),
  ('rumpus',                 'games_room'),

  -- Free-recommendation sentinel
  ('ai_recommendation',      'ai_recommended'),
  ('free_recommendation',    'ai_recommended'),
  ('bonus',                  'ai_recommended'),
  ('bonus_recommendation',   'ai_recommended');

-- Apply to ai_proposed_slot_id + the legacy slot_group_id mirror.
UPDATE shortlisting_overrides AS so
   SET ai_proposed_slot_id = m.canonical_id,
       slot_group_id       = m.canonical_id
  FROM _slot_alias_map AS m
 WHERE LOWER(TRIM(so.ai_proposed_slot_id)) = m.alias_id
   AND so.ai_proposed_slot_id IS DISTINCT FROM m.canonical_id;

-- Apply to human_selected_slot_id — operators picked from the same drift set.
UPDATE shortlisting_overrides AS so
   SET human_selected_slot_id = m.canonical_id
  FROM _slot_alias_map AS m
 WHERE LOWER(TRIM(so.human_selected_slot_id)) = m.alias_id
   AND so.human_selected_slot_id IS DISTINCT FROM m.canonical_id;

-- Lowercase + trim canonical entries that are correct but cosmetically off.
UPDATE shortlisting_overrides
   SET ai_proposed_slot_id = LOWER(TRIM(ai_proposed_slot_id)),
       slot_group_id       = LOWER(TRIM(slot_group_id))
 WHERE ai_proposed_slot_id IS NOT NULL
   AND (ai_proposed_slot_id <> LOWER(TRIM(ai_proposed_slot_id))
     OR slot_group_id IS NULL OR slot_group_id <> LOWER(TRIM(slot_group_id)));

COMMIT;

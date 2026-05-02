-- W11.6.24 — Slot expansion: 12 → 43 slots.
--
-- Joseph confirmed (after the room_type-vs-slot conversation) that he wants
-- the slot universe expanded to better match the 24+ image gallery delivery
-- patterns we ship to agents. Today there are 12 slots; this migration adds
-- 28 across four buckets:
--
--   Bucket A — Phase 2 conditional rooms (10 slots): study, gym, theatre,
--              wine cellar, kids/secondary bedrooms + ensuite, walk-in robe,
--              mudroom, home office.
--   Bucket B — Zone-focused intra-room splits (10 slots): kitchen island /
--              gulley / appliance cluster, lounge window / fireplace,
--              dining overhead / outlook, master bed window outlook, master
--              ensuite freestanding bath, master walk-in robe detail.
--   Bucket C — Lifestyle / outdoor / aerial (7 slots, Phase 3): pool day +
--              dusk hero, garden hero + path, balcony view, drone aerial
--              oblique + nadir.
--   Bucket D — Detail shots (4 slots, Phase 3): kitchen pendant detail,
--              bathroom tile detail, joinery detail, period feature detail.
--
-- All defaults: selection_mode='ai_decides', is_active=true, version=1.
-- Joseph can flip individual slots to 'curated_positions' later via the
-- W11.6.22b editor.
--
-- ── Vocabulary mapping ─────────────────────────────────────────────────────
-- The brief's spec table referenced several zone_focus values that are NOT
-- in the canonical SPACE_ZONE_TAXONOMY (W11.6.13 v1.0) emitted by Stage 1.
-- Adding new vocabulary would require bumping the prompt block version and
-- re-running Stage 1 over historical compositions — out of scope for this
-- wave (the brief explicitly forbids re-classification). Instead, every
-- spec value has been mapped to its closest CANONICAL parent so the
-- existing Stage 1 prompt + Gemini schema validation still emit a value
-- the slot resolver can match on. Mappings (spec → canonical):
--   kitchen_island_centered, kitchen_island_axial      → kitchen_island
--   kitchen_gulley, kitchen_through_view               → kitchen_island
--                                                        (no canonical
--                                                         gulley term — see
--                                                         report Vocab Gaps)
--   kitchen_butler                                     → kitchen_pantry
--   lounge_window, living_window_outlook,
--     dining_window_outlook, dining_view, master_bed_window,
--     balcony_outlook, terrace_outlook                 → window_view
--   lounge_fireplace, living_fireplace                 → fireplace_focal
--   dining_table_overhead, dining_overhead             → dining_table
--   ensuite_bath, freestanding_bath                    → bath_focal
--   wir_detail                                         → wardrobe_built_in
--   pool_main_view                                     → pool_focal
--   garden_overview                                    → landscape_overview
--   garden_path                                        → landscape_overview
--                                                        (no canonical path
--                                                         term — see report)
--   kitchen_pendant                                    → ceiling_detail
--                                                        (closest canonical;
--                                                         pendant-specific is
--                                                         a vocab gap)
--
-- ── eligible_image_types[] (option a) ──────────────────────────────────────
-- Bucket D needs to filter on the image_type column (is_detail_shot et al.).
-- The slot_definitions table doesn't have an eligible_image_types[] gate
-- today, so we add it here and update slotEligibility.ts in the same wave
-- (Tier 1+ check, ANDed with space/zone gates). Default is empty array
-- (= no gate) so existing 12 slots + Buckets A/B/C are unaffected.
--
-- ── Idempotence ─────────────────────────────────────────────────────────────
-- All INSERT statements use ON CONFLICT (slot_id, version) DO NOTHING.
-- The ALTER TABLE uses IF NOT EXISTS. Replay-safe.
--
-- (No explicit BEGIN/COMMIT — Supabase migration runner wraps each file in
-- its own transaction.)

-- ─── 1. Add eligible_image_types[] column for Bucket D ─────────────────────

ALTER TABLE public.shortlisting_slot_definitions
  ADD COLUMN IF NOT EXISTS eligible_image_types TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

COMMENT ON COLUMN public.shortlisting_slot_definitions.eligible_image_types IS
  'W11.6.24 — gate by image_type values (e.g. is_detail_shot). Empty array = no gate (legacy default). When non-empty, an image must have image_type ∈ this array to match the slot. ANDed with eligible_space_types / eligible_zone_focuses / eligible_room_types in slotEligibility.imageMatchesSlot.';

-- ─── 2. Bucket A — Phase 2 conditional rooms (10 slots) ────────────────────
-- All gate by eligible_room_types (matches the legacy phase-2 conditional
-- pattern from mig 291). Stage 1 emits room_type as a compatibility alias.
-- min_images=0 → slot is skipped silently when the property has no matching
-- room. max_images=1 default; secondary_bedroom_hero allows 2.

INSERT INTO public.shortlisting_slot_definitions
  (slot_id, display_name, phase, eligible_when_engine_roles, eligible_room_types, min_images, max_images, notes, version, is_active)
VALUES
  ('study_hero', 'Study — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['study','study_office'],
    0, 1, 'Conditional — appears when property has a study/home office.', 1, TRUE),
  ('gym_hero', 'Gym — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['gym','home_gym'],
    0, 1, 'Conditional — appears when property has a gym.', 1, TRUE),
  ('theatre_hero', 'Theatre / media room — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['theatre','media_room'],
    0, 1, 'Conditional — theatre or dedicated media room.', 1, TRUE),
  ('wine_cellar_hero', 'Wine cellar — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['wine_cellar','wine_room','cellar'],
    0, 1, 'Conditional — wine cellar / wine room.', 1, TRUE),
  ('kids_bedroom_hero', 'Kids bedroom — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['kids_bedroom','child_bedroom'],
    0, 1, 'Conditional — distinct from secondary_bedroom (kid-themed dressing).', 1, TRUE),
  ('secondary_bedroom_hero', 'Secondary bedroom — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['secondary_bedroom','bedroom_2','bedroom_3','bedroom_secondary'],
    0, 2, 'Up to 2 secondary beds.', 1, TRUE),
  ('secondary_ensuite_hero', 'Secondary ensuite — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['secondary_ensuite','ensuite_2'],
    0, 1, 'Conditional — second ensuite distinct from primary.', 1, TRUE),
  ('walk_in_robe_hero', 'Walk-in robe — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['walk_in_robe','wir','dressing_room'],
    0, 1, 'Conditional — dedicated walk-in robe / dressing room.', 1, TRUE),
  ('mudroom_hero', 'Mudroom — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['mudroom','laundry_mudroom'],
    0, 1, 'Conditional — distinct from primary laundry.', 1, TRUE),
  ('home_office_hero', 'Home office — hero', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['home_office','office'],
    0, 1, 'Conditional — distinct from study_hero (workplace, not bookwall).', 1, TRUE)
ON CONFLICT (slot_id, version) DO NOTHING;

-- ─── 3. Bucket B — Zone-focused intra-room splits (10 slots) ───────────────
-- Use the W11.6.13 SPACE/ZONE arrays. Where the spec referenced an
-- off-canonical zone (e.g. kitchen_gulley, lounge_fireplace), values were
-- mapped to the canonical parent — see header NOTICE. Multiple rows can
-- share a kitchen room but their zone_focus arrays segment which image
-- fills which slot via Tier-1 AND-intersection in slotEligibility.

INSERT INTO public.shortlisting_slot_definitions
  (slot_id, display_name, phase, eligible_when_engine_roles, eligible_room_types, eligible_space_types, eligible_zone_focuses, min_images, max_images, notes, version, is_active)
VALUES
  ('kitchen_island', 'Kitchen — island', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['kitchen_main','kitchenette'],
    ARRAY['kitchen_dedicated','kitchen_dining_living_combined'],
    ARRAY['kitchen_island'],
    0, 1, 'Maps spec kitchen_island_centered + _axial → canonical kitchen_island.', 1, TRUE),
  ('kitchen_gulley', 'Kitchen — gulley / through-view', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['kitchen_main'],
    ARRAY['kitchen_dedicated','kitchen_dining_living_combined'],
    ARRAY['kitchen_island'],
    0, 1, 'Spec kitchen_gulley + kitchen_through_view collapsed to canonical kitchen_island (vocab gap — see W11.6.24 report).', 1, TRUE),
  ('kitchen_appliance_cluster', 'Kitchen — appliance cluster / butler', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['kitchen_main'],
    ARRAY['kitchen_dedicated','kitchen_dining_living_combined'],
    ARRAY['kitchen_appliance_wall','kitchen_pantry'],
    0, 1, 'Spec kitchen_butler → canonical kitchen_pantry. Captures pantry + appliance-wall splits.', 1, TRUE),
  ('lounge_window', 'Lounge — window outlook', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['living_room','living_secondary'],
    ARRAY['living_room_dedicated','living_dining_combined','kitchen_dining_living_combined'],
    ARRAY['window_view'],
    0, 1, 'Spec lounge_window + living_window_outlook → canonical window_view.', 1, TRUE),
  ('lounge_fireplace', 'Lounge — fireplace', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['living_room','living_secondary'],
    ARRAY['living_room_dedicated','living_dining_combined','kitchen_dining_living_combined'],
    ARRAY['fireplace_focal'],
    0, 1, 'Spec lounge_fireplace + living_fireplace → canonical fireplace_focal.', 1, TRUE),
  ('dining_overhead', 'Dining — overhead pendant', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['dining_room'],
    ARRAY['dining_room_dedicated','living_dining_combined','kitchen_dining_living_combined'],
    ARRAY['dining_table'],
    0, 1, 'Spec dining_table_overhead + dining_overhead collapsed to canonical dining_table (no overhead-specific zone in taxonomy).', 1, TRUE),
  ('dining_outlook', 'Dining — view / outlook', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['dining_room'],
    ARRAY['dining_room_dedicated','living_dining_combined','kitchen_dining_living_combined'],
    ARRAY['window_view'],
    0, 1, 'Spec dining_window_outlook + dining_view → canonical window_view.', 1, TRUE),
  ('master_bed_window_outlook', 'Master bed — window outlook', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['master_bedroom'],
    ARRAY['master_bedroom'],
    ARRAY['window_view'],
    0, 1, 'Spec master_bed_window → canonical window_view.', 1, TRUE),
  ('master_ensuite_freestanding_bath', 'Master ensuite — freestanding bath', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['ensuite_primary','ensuite'],
    ARRAY['ensuite'],
    ARRAY['bath_focal'],
    0, 1, 'Spec ensuite_bath + freestanding_bath → canonical bath_focal.', 1, TRUE),
  ('master_walk_in_robe_detail', 'Master walk-in robe — detail', 2,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['master_bedroom','walk_in_robe'],
    ARRAY['master_bedroom'],
    ARRAY['wardrobe_built_in'],
    0, 1, 'Spec wir_detail → canonical wardrobe_built_in.', 1, TRUE)
ON CONFLICT (slot_id, version) DO NOTHING;

-- ─── 4. Bucket C — Lifestyle / outdoor / aerial (7 slots, Phase 3) ─────────
-- Phase 3 = free-recommendation tier (post mandatory + conditional). Drone
-- slots are gated by engine_role only — Stage 1 doesn't emit zone_focus for
-- aerial because the SPACE_TAXONOMY's aerial_oblique / aerial_nadir already
-- carries the vantage info via space_type.

INSERT INTO public.shortlisting_slot_definitions
  (slot_id, display_name, phase, eligible_when_engine_roles, eligible_room_types, eligible_space_types, eligible_zone_focuses, min_images, max_images, notes, version, is_active)
VALUES
  ('pool_dusk_hero', 'Pool — dusk hero', 3,
    ARRAY['photo_dusk_shortlist'],
    ARRAY['pool','outdoor_pool'],
    ARRAY['pool_area'],
    ARRAY['pool_focal'],
    0, 1, 'Phase 3 free-rec — dusk-only.', 1, TRUE),
  ('pool_day_hero', 'Pool — day hero', 3,
    ARRAY['photo_day_shortlist'],
    ARRAY['pool','outdoor_pool'],
    ARRAY['pool_area'],
    ARRAY['pool_focal'],
    0, 1, 'Phase 3 free-rec — day-only.', 1, TRUE),
  ('garden_hero', 'Garden — hero', 3,
    ARRAY['photo_day_shortlist'],
    ARRAY['garden','outdoor'],
    ARRAY['garden'],
    ARRAY['landscape_overview'],
    0, 1, 'Spec garden_overview → canonical landscape_overview.', 1, TRUE),
  ('garden_path', 'Garden — path / journey', 3,
    ARRAY['photo_day_shortlist'],
    ARRAY['garden','outdoor'],
    ARRAY['garden'],
    ARRAY['landscape_overview'],
    0, 1, 'Spec garden_path collapsed to canonical landscape_overview (vocab gap — see W11.6.24 report).', 1, TRUE),
  ('view_from_balcony', 'Balcony / terrace — view', 3,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['balcony','terrace'],
    ARRAY['balcony','terrace'],
    ARRAY['window_view'],
    0, 1, 'Spec balcony_outlook + terrace_outlook → canonical window_view (semantically correct: composition shows the view).', 1, TRUE),
  ('drone_aerial_oblique', 'Drone — aerial oblique', 3,
    ARRAY['drone_shortlist'],
    ARRAY[]::TEXT[],
    ARRAY['aerial_oblique'],
    ARRAY[]::TEXT[],
    0, 2, 'Engine_role + space_type=aerial_oblique gate (Tier 2 space-only match in slotEligibility).', 1, TRUE),
  ('drone_aerial_nadir', 'Drone — aerial nadir', 3,
    ARRAY['drone_shortlist'],
    ARRAY[]::TEXT[],
    ARRAY['aerial_nadir'],
    ARRAY[]::TEXT[],
    0, 1, 'Engine_role + space_type=aerial_nadir gate (Tier 2 space-only match).', 1, TRUE)
ON CONFLICT (slot_id, version) DO NOTHING;

-- ─── 5. Bucket D — Detail shots (4 slots, Phase 3) ─────────────────────────
-- These rely on the new eligible_image_types[] column added in step 1.
-- joinery_detail + period_feature_detail intentionally have no
-- room/space/zone gate — they're "any room" detail captures. To keep the
-- defensive misconfigured-slot rule (slotEligibility.imageMatchesSlot returns
-- false when ALL gates are empty), we set eligible_image_types to filter,
-- and slotEligibility.ts is updated in this wave to honour image_type as a
-- valid spatial-or-image gate.

INSERT INTO public.shortlisting_slot_definitions
  (slot_id, display_name, phase, eligible_when_engine_roles, eligible_room_types, eligible_space_types, eligible_zone_focuses, eligible_image_types, min_images, max_images, notes, version, is_active)
VALUES
  ('kitchen_pendant_detail', 'Kitchen — pendant detail', 3,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['kitchen_main'],
    ARRAY['kitchen_dedicated','kitchen_dining_living_combined'],
    ARRAY['ceiling_detail'],
    ARRAY['is_detail_shot'],
    0, 1, 'Spec kitchen_pendant → canonical ceiling_detail. Image must also be image_type=is_detail_shot.', 1, TRUE),
  ('bathroom_tile_detail', 'Bathroom — tile / material detail', 3,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY['bathroom','ensuite_primary','ensuite'],
    ARRAY['bathroom','ensuite'],
    ARRAY[]::TEXT[],
    ARRAY['is_detail_shot'],
    0, 1, 'Detail shot scoped to bathroom/ensuite spaces.', 1, TRUE),
  ('joinery_detail', 'Joinery / cabinetry detail', 3,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    ARRAY['is_detail_shot'],
    0, 1, 'Any room — detail-only gate via image_type.', 1, TRUE),
  ('period_feature_detail', 'Period feature / heritage detail', 3,
    ARRAY['photo_day_shortlist','photo_dusk_shortlist'],
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    ARRAY['is_detail_shot'],
    0, 1, 'Any room — detail-only gate via image_type. Pairs with W11.6.13 detail-frame heuristic.', 1, TRUE)
ON CONFLICT (slot_id, version) DO NOTHING;

-- ─── 6. Verification + NOTICE ──────────────────────────────────────────────

DO $$
DECLARE
  v_added INT;
  v_total_active INT;
  v_expected_ids TEXT[] := ARRAY[
    -- Bucket A (10)
    'study_hero','gym_hero','theatre_hero','wine_cellar_hero','kids_bedroom_hero',
    'secondary_bedroom_hero','secondary_ensuite_hero','walk_in_robe_hero',
    'mudroom_hero','home_office_hero',
    -- Bucket B (10)
    'kitchen_island','kitchen_gulley','kitchen_appliance_cluster',
    'lounge_window','lounge_fireplace',
    'dining_overhead','dining_outlook',
    'master_bed_window_outlook','master_ensuite_freestanding_bath',
    'master_walk_in_robe_detail',
    -- Bucket C (7)
    'pool_dusk_hero','pool_day_hero','garden_hero','garden_path',
    'view_from_balcony','drone_aerial_oblique','drone_aerial_nadir',
    -- Bucket D (4)
    'kitchen_pendant_detail','bathroom_tile_detail','joinery_detail',
    'period_feature_detail'
  ];
BEGIN
  SELECT COUNT(*) INTO v_added
    FROM public.shortlisting_slot_definitions
    WHERE slot_id = ANY(v_expected_ids) AND version = 1;
  SELECT COUNT(*) INTO v_total_active
    FROM public.shortlisting_slot_definitions
    WHERE is_active = TRUE;

  IF v_added <> 31 THEN
    -- The 31 expected slot_ids: 10 Bucket A + 10 Bucket B + 7 Bucket C + 4
    -- Bucket D = 31. (The brief's exec summary says "~28", but the actual
    -- spec tables sum to 31.) Hard fail on drift.
    RAISE EXCEPTION 'W11.6.24 slot expansion: expected 31 matching rows after insert, found %', v_added;
  END IF;

  RAISE NOTICE 'W11.6.24 slot expansion: matched_expected_ids=% (target=31), total_active_slots=%', v_added, v_total_active;
END $$;

-- Force PostgREST schema reload so the new column is visible to clients.
NOTIFY pgrst, 'reload schema';

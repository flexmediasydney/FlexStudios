-- Wave 6 P4 SHORTLIST: mig 291: seed slot definitions + signal weights + Stream B anchors per spec §10, §12
--
-- Day-one seed data so the engine works the moment Pass 2 first runs. Three
-- INSERT batches, all idempotent (ON CONFLICT DO NOTHING using the existing
-- UNIQUE constraints from mig 286):
--
--   1. shortlisting_slot_definitions — 12 rows total
--      Phase 1 (mandatory, 4): exterior_front_hero, master_bedroom_hero,
--        kitchen_hero, open_plan_hero
--      Phase 2 (conditional, 8): ensuite_hero, bathroom_main, bedroom_secondary,
--        alfresco_hero, exterior_rear, study_laundry_powder, lounge_upstairs,
--        dining_hero
--      No phase 3 rows — phase 3 is unbounded AI free recommendations bounded
--      only by the package ceiling at runtime (spec §12).
--
--   2. shortlisting_signal_weights — 4 rows (the v2 NEW/MODIFIED signals
--      from spec §9: vantage_point, living_zone_count, clutter_severity,
--      indoor_outdoor_connection_quality). poi_count is omitted because
--      drone shortlisting is parked.
--
--   3. shortlisting_stream_b_anchors — 3 rows (Tier S=5, P=8, A=9.5)
--      with the verbatim spec §10 descriptor text.
--
-- All rows: version=1, is_active=TRUE. UNIQUE constraints from mig 286
-- prevent duplicate (slot_id, version) / (signal_key, version) /
-- (tier, version) — re-running this migration is safe.

-- ============================================================================
-- 1. shortlisting_slot_definitions — 12 rows (4 phase1 + 8 phase2)
-- ============================================================================

INSERT INTO shortlisting_slot_definitions
  (slot_id, display_name, phase, package_types, eligible_room_types, max_images, min_images, notes, version, is_active)
VALUES
  -- ─── Phase 1 — Mandatory (always filled) ─────────────────────────────────
  (
    'exterior_front_hero',
    'Front facade — hero',
    1,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['exterior_front'],
    1,
    1,
    'Best available facade angle. Mandatory for every package.',
    1,
    TRUE
  ),
  (
    'master_bedroom_hero',
    'Master bedroom — hero',
    1,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['master_bedroom'],
    1,
    1,
    'Highest combined score among bedroom candidates.',
    1,
    TRUE
  ),
  (
    'kitchen_hero',
    'Kitchen — hero',
    1,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['kitchen_main'],
    1,
    1,
    'Island + run visible preferred.',
    1,
    TRUE
  ),
  (
    'open_plan_hero',
    'Open plan — hero',
    1,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['interior_open_plan','living_room','kitchen_main','dining_room'],
    1,
    1,
    'Most living zones in single frame.',
    1,
    TRUE
  ),
  -- ─── Phase 2 — Conditional (filled if room found in Pass 1) ──────────────
  (
    'ensuite_hero',
    'Primary ensuite — hero',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['ensuite_primary'],
    2,
    0,
    '2 images allowed if angle delta > 30° (e.g. shower-side + vanity-side).',
    1,
    TRUE
  ),
  (
    'bathroom_main',
    'Main bathroom — hero',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['bathroom'],
    1,
    0,
    'Distinct from any ensuite.',
    1,
    TRUE
  ),
  (
    'bedroom_secondary',
    'Secondary bedroom(s)',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['bedroom_secondary'],
    2,
    0,
    'Selection by highest aesthetic_score, NOT combined score.',
    1,
    TRUE
  ),
  (
    'alfresco_hero',
    'Alfresco — hero',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['alfresco'],
    1,
    0,
    'Structure + garden visible.',
    1,
    TRUE
  ),
  (
    'exterior_rear',
    'Rear exterior',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['exterior_rear','alfresco'],
    1,
    0,
    'alfresco eligible when vantage_point=exterior_looking_in (composition_classifications.eligible_for_exterior_rear=TRUE).',
    1,
    TRUE
  ),
  (
    'study_laundry_powder',
    'Study / laundry / powder',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['study_office','laundry','bathroom'],
    2,
    0,
    'Notable utility spaces.',
    1,
    TRUE
  ),
  (
    'lounge_upstairs',
    'Upstairs lounge',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['living_secondary'],
    1,
    0,
    'Distinct from open_plan_hero — does not compete.',
    1,
    TRUE
  ),
  (
    'dining_hero',
    'Dining — hero',
    2,
    ARRAY['Gold','Day to Dusk','Premium'],
    ARRAY['dining_room'],
    1,
    0,
    'If distinct from open plan hero.',
    1,
    TRUE
  )
ON CONFLICT (slot_id, version) DO NOTHING;

-- ============================================================================
-- 2. shortlisting_signal_weights — 4 v2 NEW/MODIFIED signals (spec §9)
-- ============================================================================

INSERT INTO shortlisting_signal_weights
  (signal_key, dimension, weight, per_room_modifiers, description, version, is_active)
VALUES
  (
    'vantage_point',
    'compositional',
    1.000,
    '{}'::jsonb,
    'Camera position relative to space (interior_looking_out vs exterior_looking_in vs neutral). Determines slot eligibility — alfresco + exterior_looking_in qualifies a composition for the exterior_rear slot.',
    1,
    TRUE
  ),
  (
    'living_zone_count',
    'compositional',
    1.000,
    '{"interior_open_plan":1.4,"living_room":1.2,"kitchen_main":1.2,"dining_room":1.1}'::jsonb,
    'Number of distinct living zones visible in a single open-plan frame. Primary differentiator for open_plan_hero selection. Scoring guidance: 1 zone = 4, 2 zones = 6, 3 zones = 8, 4 zones = 10.',
    1,
    TRUE
  ),
  (
    'clutter_severity',
    'aesthetic',
    1.000,
    '{}'::jsonb,
    'Graduated severity (none / minor_photoshoppable / moderate_retouch / major_reject). Only major_reject hard-rejects from shortlisting. Replaces the v1 binary clutter_reject. Impact at scoring time: none=0, minor_photoshoppable=-0.5, moderate_retouch=-2, major_reject=-10.',
    1,
    TRUE
  ),
  (
    'indoor_outdoor_connection_quality',
    'compositional',
    1.000,
    '{"kitchen_main":1.4,"living_room":1.4,"dining_room":1.2,"master_bedroom":0.8}'::jsonb,
    'Degree to which alfresco/outdoor space is visible through doors/windows. Scoring guidance: none=0, implied=3, partial_visible=6, full_visible=9, hero_feature=10. Per-room weighting: kitchens and living rooms weighted higher; master bedroom de-weighted.',
    1,
    TRUE
  )
ON CONFLICT (signal_key, version) DO NOTHING;

-- ============================================================================
-- 3. shortlisting_stream_b_anchors — Tier S/P/A (spec §10)
-- ============================================================================
-- Descriptor strings are VERBATIM from spec §10 — match the hardcoded
-- defaults in supabase/functions/_shared/streamBInjector.ts (TIER_S_DEFAULT,
-- TIER_P_DEFAULT, TIER_A_DEFAULT). The newline structure within each
-- descriptor matters because it appears literally in the prompt.

INSERT INTO shortlisting_stream_b_anchors
  (tier, score_anchor, descriptor, version, is_active)
VALUES
  (
    'S',
    5.00,
    E'TIER S — STANDARD REAL ESTATE (Score: 5 on our scale)\nMandatory: vertical lines straight, windows show recoverable exterior detail, no visible clutter, camera at correct height (counter-top for kitchen, chest height for bedrooms), coverage complete.\nA score of 5 means: competent, professional, acceptable for REA/Domain.',
    1,
    TRUE
  ),
  (
    'P',
    8.00,
    E'TIER P — PREMIUM PRESTIGE (Score: 8 on our scale)\nMandatory (in addition to Tier S): minimum 3 depth layers, foreground anchoring element required, indoor-outdoor connection visible where applicable, material texture visible (stone veining, timber grain, tile grout), HDR blend invisible, set-level colour grade consistent.\nA score of 8 means: would appear in premium agent brochure for $2M+ property.',
    1,
    TRUE
  ),
  (
    'A',
    9.50,
    E'TIER A — ARCHITECTURAL EDITORIAL (Score: 9.5+ on our scale)\nThe picture tells the story of the building. Materials are the subject. Light reveals architecture. Human/lifestyle elements add narrative. Coverage is tertiary — one extraordinary image outscores five adequate ones.\nA score of 9.5 means: publication-grade, Architectural Digest / dezeen standard.',
    1,
    TRUE
  )
ON CONFLICT (tier, version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

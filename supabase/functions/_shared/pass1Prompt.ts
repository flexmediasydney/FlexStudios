/**
 * pass1Prompt.ts — pure Pass 1 classification prompt builder.
 *
 * Constructs the reasoning-FIRST prompt for the Pass 1 vision call. Verbatim
 * from spec §5.1 with the Stream B SCORING ANCHORS block injected from
 * `streamBInjector.buildScoringReferenceBlock()`.
 *
 * Two critical v2 architectural rules baked into this prompt (DO NOT REMOVE):
 *
 *   1. STEP 1 / STEP 2 ordering (spec L9 reasoning-first). The model writes
 *      the full `analysis` paragraph BEFORE producing any scores. Scores are
 *      derived from the analysis, not generated alongside it. Without this,
 *      the prose becomes post-hoc justification of an arbitrary number and
 *      score/text consistency drops.
 *
 *   2. STREAM B SCORING ANCHORS injection (spec L8). Without explicit tier
 *      definitions, Sonnet clusters all scores 7–9. The anchors give the
 *      model concrete reference points (5=Tier S floor, 8=Tier P, 9.5+=Tier A)
 *      and the score distribution actually spreads.
 *
 * The prompt also includes:
 *   - HDR bracket explainer ("this is a RAW HDR exposure — don't penalise dark")
 *   - Full ROOM TYPE TAXONOMY (40 values incl. living_secondary per L18)
 *   - Full COMPOSITION TYPE TAXONOMY
 *   - VANTAGE POINT explanation with alfresco/exterior_rear disambiguation (L6)
 *   - JSON output schema (22 fields, raw JSON only)
 *
 * Single export: buildPass1Prompt(anchors) → { system, userPrefix }.
 *   The caller appends the image as a separate content part after userPrefix.
 *
 * Temperature is set to 0 by the calling edge function — this builder is
 * temperature-agnostic.
 */

import {
  buildScoringReferenceBlock,
  type StreamBAnchors,
} from './streamBInjector.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Pass1Prompt {
  /** System message — sets role and the reasoning-first STEP 1/STEP 2 contract. */
  system: string;
  /** User-message text part, concatenated BEFORE the image part by the caller. */
  userPrefix: string;
}

// ─── System prompt (role, framing, anti-grade-inflation) ─────────────────────

const SYSTEM_PROMPT = `You are classifying a real estate photography image for a professional Sydney-based media company. This image is a RAW HDR bracket exposure — it may appear dark or have blown highlights in some areas. This is expected and correct for HDR capture. Do NOT penalise darkness or blown windows.

You operate in two strict steps:
  STEP 1 — Write a full descriptive ANALYSIS paragraph FIRST.
  STEP 2 — Derive structured SCORES from your analysis.

The analysis must be written before any scores. The scores must be consistent with — and derivable from — what you wrote in the analysis. Do not skip the analysis. Do not produce scores that contradict your analysis text.

You are NOT making shortlisting decisions in this pass. You are classifying and scoring every composition individually. Selection happens in a separate downstream pass that has access to the entire shoot. Do not try to be selective here — score what you see.`;

// ─── Taxonomies (verbatim from spec §5.1) ────────────────────────────────────

const ROOM_TYPE_TAXONOMY =
  `interior_open_plan | kitchen_main | kitchen_scullery | living_room | ` +
  `living_secondary | dining_room | master_bedroom | bedroom_secondary | ` +
  `ensuite_primary | ensuite_secondary | bathroom | wir_wardrobe | ` +
  `study_office | laundry | entry_foyer | staircase | hallway_corridor | ` +
  `home_cinema | games_room | gymnasium | wine_cellar | garage_showcase | ` +
  `garage_standard | alfresco | pool_area | outdoor_kitchen | ` +
  `courtyard_internal | balcony_terrace | exterior_front | exterior_rear | ` +
  `exterior_side | exterior_detail | drone_contextual | drone_nadir | ` +
  `drone_oblique | floorplan | detail_material | detail_lighting | ` +
  `lifestyle_vehicle | special_feature`;

const COMPOSITION_TYPE_TAXONOMY =
  `hero_wide | corner_two_point | detail_closeup | corridor_leading | ` +
  `straight_on | overhead | upward_void | threshold_transition | ` +
  `drone_nadir | drone_oblique_contextual | architectural_abstract`;

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildPass1Prompt(anchors: StreamBAnchors): Pass1Prompt {
  const scoringReference = buildScoringReferenceBlock(anchors);

  const userPrefix = [
    // ─── STEP 1 — write analysis first (reasoning-first, spec L9) ────────────
    'STEP 1 — WRITE YOUR ANALYSIS FIRST.',
    'Before producing any scores or classifications, write a paragraph describing what you observe about this composition. Cover:',
    '- What space or room is shown',
    '- Camera angle and height choice',
    '- What depth layers are visible (foreground / midground / background)',
    '- Key architectural elements and features visible',
    '- Composition strengths and any weaknesses',
    '- Whether this appears to be a hero shot, a supporting angle, or a detail',
    '- Any quality concerns (clutter, distraction, technical issue)',
    '',
    'Minimum 3 sentences. The analysis is the primary reasoning artifact — the scores must be derivable from it.',
    '',
    // ─── STEP 2 — derive scores ──────────────────────────────────────────────
    'STEP 2 — DERIVE SCORES FROM YOUR ANALYSIS.',
    'Using your analysis above as the basis, produce the structured output below. Your scores must be consistent with and derivable from your written analysis. The Stream B scoring anchors define the reference scale.',
    '',
    // ─── Stream B anchors (spec L8) ──────────────────────────────────────────
    scoringReference,
    // ─── JSON schema (22 fields, raw JSON only) ──────────────────────────────
    'Return ONLY valid JSON, no other text, no Markdown fences:',
    '{',
    '  "analysis": "Full descriptive paragraph from Step 1. Minimum 3 sentences.",',
    '  "room_type": "see taxonomy below",',
    '  "room_type_confidence": 0.95,',
    '  "composition_type": "see taxonomy below",',
    '  "vantage_point": "interior_looking_out | exterior_looking_in | neutral",',
    '  "time_of_day": "day | golden_hour | dusk_twilight | night",',
    '  "is_drone": false,',
    '  "is_exterior": false,',
    '  "is_detail_shot": false,',
    '  "zones_visible": ["zone1", "zone2"],',
    '  "key_elements": ["element1", "element2"],',
    '  "is_styled": true,',
    '  "indoor_outdoor_visible": false,',
    '  "clutter_severity": "none | minor_photoshoppable | moderate_retouch | major_reject",',
    '  "clutter_detail": null,',
    '  "flag_for_retouching": false,',
    '  "technical_score": 7,',
    '  "lighting_score": 7,',
    '  "composition_score": 7,',
    '  "aesthetic_score": 7',
    '}',
    '',
    // ─── ROOM TYPE TAXONOMY ──────────────────────────────────────────────────
    'ROOM TYPE TAXONOMY (use exactly these values):',
    ROOM_TYPE_TAXONOMY,
    '',
    'Note on living_secondary (spec L18): Use for upstairs lounges, sitting rooms, rumpus rooms, and secondary living zones on different floors from the main open-plan area. These are NOT near-duplicates of living_room — they are physically distinct rooms that happen to share a function. Misclassifying an upstairs lounge as living_room causes it to be culled as a near-duplicate downstream — use living_secondary instead.',
    '',
    // ─── COMPOSITION TYPE TAXONOMY ───────────────────────────────────────────
    'COMPOSITION TYPE TAXONOMY (use exactly these values):',
    COMPOSITION_TYPE_TAXONOMY,
    '',
    // ─── VANTAGE POINT (spec L6 disambiguation) ──────────────────────────────
    'VANTAGE POINT (critical for alfresco/exterior_rear disambiguation):',
    'interior_looking_out: camera is inside the structure looking outward through doors/windows.',
    'exterior_looking_in: camera is outside the structure looking toward the building.',
    'neutral: neither (e.g. straight-on facade, flat exterior, internal view with no outward orientation).',
    '',
    'IMPORTANT: alfresco + exterior_looking_in means the composition is also eligible for the exterior_rear slot. The downstream selection logic uses this combination to disambiguate "alfresco from inside the pavilion looking out" (an alfresco hero) from "alfresco from the garden looking back at the structure" (a rear exterior). Set vantage_point honestly so this distinction is preserved.',
    '',
    // ─── Quality/clutter rules ───────────────────────────────────────────────
    'CLUTTER SEVERITY (spec L10) — graduated, NOT binary:',
    '- "none": no clutter, scene is clean.',
    '- "minor_photoshoppable": small distractions like council bins on exterior, single visible cord, small personal item — flag for retouching but do NOT reject. Strong compositions with minor flagged distractions are still shortlist-eligible.',
    '- "moderate_retouch": multiple distractions, meaningful retouch effort required. Flag and deduct.',
    '- "major_reject": catastrophic clutter — primary subject completely obscured, scene unrecoverable.',
    '',
    'Set flag_for_retouching=true whenever clutter_severity is minor_photoshoppable or moderate_retouch. Set it to false only when clutter_severity is "none" or "major_reject".',
    '',
    'Output requirement: respond with the JSON object only. No prose before or after. No Markdown fences. No commentary.',
  ].join('\n');

  return {
    system: SYSTEM_PROMPT,
    userPrefix,
  };
}

/**
 * stage1ResponseSchema.ts — Wave 11.7.1 (W7.6 block) Stage 1 per-image schema.
 *
 * Promoted to production from `vendor-retroactive-compare/iter5Schema.ts` after
 * iter-5 Saladine validation. ONE call per image (validated harness pattern):
 * the model sees a single preview and emits this object directly — no
 * `per_image[]` wrapper, no stem-echo (identity is implicit because 1 call =
 * 1 image).
 *
 * Why per-image instead of batched: Gemini's stem-echo isn't reliable. The
 * batched-mode `per_image[]` schema with stem keys failed 42/42 on the Saladine
 * smoke test because the model dropped or renamed stems. The harness's
 * 1-image-per-call shape ran 42/42 perfect across iter-1 through iter-5b.
 * Per-image is also CHEAPER (smaller individual calls, no batched-output token
 * bloat, comparable parallelism via the dispatcher's existing concurrency).
 *
 * Block architecture (W7.6 pattern): pure exported tool name + JSON schema.
 * Versioned via STAGE1_RESPONSE_SCHEMA_VERSION so prompt-cache invalidation
 * tracks block changes. Persisted in `composition_classifications.prompt_block_versions`.
 *
 * Schema-as-prompt: every property's `description` is read by the model as
 * inline instruction. We match the harness verbosity standard — specific
 * targets, examples, forbidden patterns.
 *
 * Gemini responseSchema honoured constraints:
 *   - no $ref, no oneOf/anyOf
 *   - no patternProperties / additionalProperties
 *   - no minLength/maxLength on strings (use description guidance instead)
 *   - minItems / required honoured
 */

// W11.6.13 — bumped from v1.0 to v1.1 for space_type / zone_focus /
// space_zone_count additions. The room_type field is preserved as a
// compatibility alias (legacy consumers + admin-curated taxonomy table).
// W11.2 — bumped from v1.1 to v1.2 for the 22-key signal_scores object;
// each property's description doubles as the per-signal measurement prompt.
export const STAGE1_RESPONSE_SCHEMA_VERSION = 'v1.2';
export const STAGE1_RESPONSE_TOOL_NAME = 'classify_image';

/**
 * W11.2 — 22 per-signal measurement keys (0-10 scale).
 * Exported separately so unit tests + tier-config wiring can reference the
 * canonical key list without parsing the schema object.
 *
 * Scoring rubric (applies to every signal):
 *   10  = exemplary (top 5% of professional output)
 *   7-9 = strong (publishable as-is)
 *   4-6 = competent (acceptable with minor remediation)
 *   1-3 = weak (needs significant rework)
 *   0   = catastrophic (unrecoverable / unusable)
 *
 * Each key's description in STAGE1_RESPONSE_SCHEMA below is read by the model
 * as inline per-signal measurement instruction.
 */
export const STAGE1_SIGNAL_KEYS = [
  'exposure_balance',
  'color_cast',
  'sharpness_subject',
  'sharpness_corners',
  'depth_layering',
  'composition_geometry',
  'vantage_quality',
  'framing_quality',
  'leading_lines',
  'negative_space',
  'symmetry_quality',
  'perspective_distortion',
  'plumb_verticals',
  'material_specificity',
  'period_reading',
  'styling_quality',
  'distraction_freeness',
  'retouch_debt',
  'gallery_arc_position',
  'social_crop_survival',
  'brochure_print_survival',
  'reading_grade_match',
] as const;

export type Stage1SignalKey = typeof STAGE1_SIGNAL_KEYS[number];

export const STAGE1_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    analysis: {
      type: 'string',
      description:
        'Write 5-7 detailed sentences (~250 words minimum) covering: ' +
        '(1) composition geometry, vantage and depth layering; ' +
        '(2) lighting condition, exposure stage (single bracket vs final HDR), and tonal balance; ' +
        '(3) distinguishing architectural features and materials with specific descriptors ' +
        '(e.g. "Corinthian column with capital", "terracotta hipped roof", "shaker cabinetry", ' +
        '"gooseneck mixer tap" — NOT generic nouns like "column", "roof", "cabinetry"); ' +
        '(4) styling state, distractions, clutter, and retouch concerns; ' +
        '(5) hero-shot vs supporting-angle judgement with reasoning. ' +
        'Do NOT emit nested JSON — return only the descriptive paragraph as a single string.',
    },
    room_type: {
      type: 'string',
      description:
        'Use one room_type value from the canonical taxonomy in the system prompt. ' +
        'Prefer the most specific applicable value — e.g. bedroom_guest over bedroom_secondary ' +
        'when the bedroom is clearly a formally-styled spare room; alfresco_undercover over alfresco ' +
        'when the alfresco is roofed; exterior_facade_hero over exterior_front when the shot is ' +
        'a hero-quality framing of the front facade. ' +
        'COMPATIBILITY ALIAS (W11.6.13): the new SPACE/ZONE pair (space_type + zone_focus) is the ' +
        'authoritative classification going forward. Keep emitting room_type for backward ' +
        'compatibility, but always also emit space_type and zone_focus.',
    },
    room_type_confidence: { type: 'number' },
    // W11.6.13 — orthogonal SPACE/ZONE separation. The architectural
    // enclosure (space_type) and the compositional subject (zone_focus)
    // are independent axes. In studios + open-plan apartments ONE space
    // contains MANY zones; the new schema lets the engine reason about
    // both correctly.
    space_type: {
      type: 'string',
      description:
        'The architectural enclosure (the 4 walls). Pick from canonical SPACE taxonomy: ' +
        'master_bedroom | bedroom_secondary | bedroom_third | living_dining_combined | living_room_dedicated | dining_room_dedicated | ' +
        'kitchen_dining_living_combined | kitchen_dedicated | studio_open_plan | bathroom | ensuite | powder_room | ' +
        'entry_foyer | hallway | study | media_room | rumpus | laundry | mudroom | garage | alfresco_undercover | ' +
        'alfresco_open | balcony | terrace | exterior_facade | exterior_rear | exterior_side | pool_area | garden | ' +
        'streetscape | aerial_oblique | aerial_nadir.',
    },
    zone_focus: {
      type: 'string',
      description:
        'The compositional SUBJECT of the shot — what the photographer is actually showing. ' +
        'Pick from canonical ZONE taxonomy: bed_focal | wardrobe_built_in | dining_table | kitchen_island | ' +
        'kitchen_appliance_wall | kitchen_pantry | lounge_seating | fireplace_focal | study_desk | tv_media_wall | ' +
        'bath_focal | shower_focal | vanity_detail | toilet_visible | window_view | door_threshold | stair_focal | ' +
        'feature_wall | ceiling_detail | floor_detail | material_proof | landscape_overview | full_facade | ' +
        'pool_focal | outdoor_dining | outdoor_kitchen | bbq_zone | drying_zone | parking_zone. ' +
        'Useful when space_type implies multiple zones (e.g. living_dining_combined → zone_focus distinguishes ' +
        'dining_table vs lounge_seating). For single-zone shots, the zone_focus is still meaningful (e.g. ' +
        'space_type=master_bedroom → zone_focus=bed_focal vs wardrobe_built_in vs window_view).',
    },
    space_zone_count: {
      type: 'integer',
      description:
        '1 = single-purpose enclosed room (dedicated bedroom, dedicated bathroom). ' +
        '2-4 = multi-zone open plan (living/dining combined = 2; kitchen+dining+living = 3). ' +
        '5+ = studio-style (kitchen + bed + lounge + bathroom in one envelope).',
    },
    composition_type: {
      type: 'string',
      description: 'Use one value from the composition_type taxonomy in the system prompt.',
    },
    vantage_point: {
      type: 'string',
      description:
        'Use one of: interior_looking_out | exterior_looking_in | neutral | ' +
        'low_angle | high_angle | eye_level_through_threshold | aerial_oblique | aerial_nadir.',
    },
    time_of_day: { type: 'string' },
    is_drone: { type: 'boolean' },
    is_exterior: { type: 'boolean' },
    is_detail_shot: { type: 'boolean' },
    zones_visible: {
      type: 'array',
      minItems: 2,
      description:
        'List of distinct functional zones visible in the frame ' +
        '(e.g. "kitchen", "dining_zone", "alfresco_through_doors", "study_through_archway"). ' +
        'Different from key_elements — these are AREAS, not objects.',
      items: { type: 'string' },
    },
    key_elements: {
      type: 'array',
      minItems: 8,
      description:
        'List 8 OR MORE specific architectural and styling elements visible in the frame. ' +
        'Each entry MUST be a multi-noun phrase that includes a material, treatment, style or ' +
        'descriptor — NOT a generic single noun. ' +
        'GOOD: "casement window with venetian blinds", "four-poster bed with timber frame", ' +
        '"patterned Persian rug", "shaker-style cabinetry", "gooseneck mixer tap", ' +
        '"terracotta tiled hipped roof", "Corinthian column with capital", ' +
        '"variegated red-brown brick veneer", "ornate white turned baluster railing". ' +
        'FORBIDDEN single-noun entries: "window", "bed", "rug", "cabinetry", "tap", ' +
        '"roof", "column", "brick", "balustrade". ' +
        'Aim for the level of granularity a master architectural photographer would write ' +
        'in a Tier P feature description.',
      items: { type: 'string' },
    },
    is_styled: { type: 'boolean' },
    indoor_outdoor_visible: { type: 'boolean' },
    clutter_severity: {
      type: 'string',
      description: 'One of: none | minor_photoshoppable | moderate_retouch | major_reject.',
    },
    clutter_detail: {
      type: 'string',
      description:
        'Prose paragraph identifying clutter or retouch concerns and proposing remediation. ' +
        'Empty string when clutter_severity is "none".',
    },
    flag_for_retouching: { type: 'boolean' },
    technical_score: { type: 'number' },
    lighting_score: { type: 'number' },
    composition_score: { type: 'number' },
    aesthetic_score: { type: 'number' },

    // ─── W11.2 per-signal granularity ───────────────────────────────────────
    // 22 underlying signals that ROLL UP into the 4 aggregate axis scores.
    // Tier configs (W8) can weight per-signal once we capture the data.
    // Scoring rubric (every signal): 10=exemplary, 7-9=strong, 4-6=competent,
    // 1-3=weak, 0=catastrophic. Score what you ACTUALLY observe, not the
    // platonic ideal of what the image could be.
    signal_scores: {
      type: 'object',
      description:
        'W11.2: per-signal 0-10 scores. 10=exemplary; 7-9=strong; 4-6=competent; ' +
        '1-3=weak; 0=catastrophic. Score what you actually observe in this image, ' +
        'not the platonic ideal. The 4 aggregate scores ' +
        '(technical/lighting/composition/aesthetic) are weighted rollups of these — ' +
        'be internally consistent (e.g. exposure_balance and sharpness_subject ' +
        'should track technical_score; composition_geometry and framing_quality ' +
        'should track composition_score).',
      properties: {
        exposure_balance: {
          type: 'number',
          description:
            '0-10: highlights AND shadows held without clipping. 10 = both ends ' +
            'preserved with detail; 5 = one end clips; 0 = both ends blow out. ' +
            'Under RAW source: score the FINAL HDR-merged result implied, not the ' +
            'individual bracket frame.',
        },
        color_cast: {
          type: 'number',
          description:
            '0-10: white balance neutrality. 10 = neutral whites and skin tones; ' +
            'lower as cast strengthens (warm orange, cool blue, magenta/green). ' +
            'Mixed-light scenes get partial credit for hero-zone neutrality.',
        },
        sharpness_subject: {
          type: 'number',
          description:
            '0-10: focus accuracy on the hero subject. 10 = razor-crisp on the ' +
            'intended hero zone; 5 = soft but recognisable; 0 = motion-blurred or ' +
            'mis-focused beyond recovery.',
        },
        sharpness_corners: {
          type: 'number',
          description:
            '0-10: lens corner sharpness. 10 = uniformly crisp edge-to-edge; ' +
            '5 = visible corner softness expected of a wide-aperture wide-angle; ' +
            '0 = corners smeared or coma-distorted to the point of unusability.',
        },
        depth_layering: {
          type: 'number',
          description:
            '0-10: foreground / middleground / background separation. 10 = three ' +
            'distinct planes drawing the eye through the frame; 5 = two planes ' +
            'present; 0 = flat, no depth cues.',
        },
        composition_geometry: {
          type: 'number',
          description:
            '0-10: rule of thirds, leading lines, symmetry — geometric strength ' +
            'of the frame. 10 = textbook geometric balance; 5 = adequate but ' +
            'unremarkable; 0 = chaotic, no structure.',
        },
        vantage_quality: {
          type: 'number',
          description:
            '0-10: camera position appropriateness for the subject. 10 = ideal ' +
            'vantage that flatters the architecture; 5 = workable but not optimal; ' +
            '0 = wrong vantage (e.g. shooting up at a ceiling-heavy room from low).',
        },
        framing_quality: {
          type: 'number',
          description:
            '0-10: subject placement and breathing room. 10 = generous, intentional ' +
            'framing; 5 = subject placed but cramped or floating; 0 = subject ' +
            'amputated by the frame edge or lost in dead space.',
        },
        leading_lines: {
          type: 'number',
          description:
            '0-10: do lines in the frame pull the eye toward the subject? 10 = ' +
            'strong convergence on hero; 5 = lines present but neutral; 0 = lines ' +
            'lead the eye AWAY from the subject. Score 5 if no lines are present.',
        },
        negative_space: {
          type: 'number',
          description:
            '0-10: intentional vs accidental negative space. 10 = negative space ' +
            'amplifies the subject; 5 = neutral; 0 = empty space feels like ' +
            'unfinished framing or dead air.',
        },
        symmetry_quality: {
          type: 'number',
          description:
            '0-10: when symmetry is the intent, how well executed? 10 = pixel-' +
            'perfect symmetry; 5 = near-symmetric but visibly off; 0 = symmetry ' +
            'attempted and badly broken. Score 7 if symmetry is clearly NOT the ' +
            'intent (e.g. a documentary corner shot).',
        },
        perspective_distortion: {
          type: 'number',
          description:
            '0-10: wide-angle stretch — appropriate or excessive? 10 = no visible ' +
            'distortion or distortion used intentionally; 5 = mild stretch typical ' +
            'of a 16-24mm wide; 0 = severe barrel/pincushion that warps the ' +
            'architecture.',
        },
        plumb_verticals: {
          type: 'number',
          description:
            '0-10: vertical lines vertical or converging? 10 = walls plumb, no ' +
            'keystoning; 5 = mild lean correctable in post; 0 = severe converging ' +
            'verticals that read as amateur (camera tilted up).',
        },
        material_specificity: {
          type: 'number',
          description:
            '0-10: how specifically can materials be identified from this image? ' +
            '10 = "Caesarstone with veined Calacatta pattern" identifiable; ' +
            '5 = "stone benchtop" identifiable but not the specific stone; ' +
            '0 = materials unreadable (under-lit, over-styled, blurred).',
        },
        period_reading: {
          type: 'number',
          description:
            '0-10: era / architectural style legibility. 10 = period unambiguous ' +
            '(e.g. clearly Federation, clearly post-war fibro, clearly ' +
            'contemporary); 5 = era ambiguous; 0 = period unreadable from this ' +
            'frame.',
        },
        styling_quality: {
          type: 'number',
          description:
            '0-10: intentional vs neglected styling. 10 = thoughtful, magazine-' +
            'level styling; 5 = lived-in but not staged; 0 = visibly cluttered, ' +
            'mismatched, or pre-styling state.',
        },
        distraction_freeness: {
          type: 'number',
          description:
            '0-10: clutter, power lines, neighbouring properties, errant objects. ' +
            '10 = clean frame, no distractions; 5 = minor distractions ' +
            'photoshoppable; 0 = major distractions that reject the image.',
        },
        retouch_debt: {
          type: 'number',
          description:
            '0-10: how much post-processing work does this image need? 10 = ' +
            'publish-ready as-is; 5 = standard 5-10 min retouch (clone garbage ' +
            'bins, level horizons); 0 = >30 min of retouch or unrecoverable ' +
            '(e.g. moiré on screens, deep noise).',
        },
        gallery_arc_position: {
          type: 'number',
          description:
            '0-10: how well does this image fit a marketing-gallery arc? ' +
            '10 = lead-image candidate (position 1); 7-9 = early gallery ' +
            '(positions 2-6); 4-6 = late/supporting; 0-3 = archive only. Score ' +
            "the image's role in the SEQUENCE, not its standalone quality.",
        },
        social_crop_survival: {
          type: 'number',
          description:
            '0-10: does a 1:1 Instagram crop preserve the subject? 10 = centre ' +
            'square keeps hero feature intact; 5 = crop loses some context but ' +
            'subject survives; 0 = subject is amputated or lost in 1:1 crop.',
        },
        brochure_print_survival: {
          type: 'number',
          description:
            '0-10: print-quality at A4 brochure size. 10 = sharp, vibrant, ' +
            'tonally rich at full-page A4; 5 = passable at quarter-page; 0 = ' +
            'too soft / noisy / under-resolved for any print use.',
        },
        reading_grade_match: {
          type: 'number',
          description:
            '0-10: does the image match the reading grade / property tier the ' +
            'listing copy will target? 10 = image quality matches premium-tier ' +
            'voice; 5 = image fits standard tier; 0 = image quality contradicts ' +
            'the implied tier (e.g. luxury copy paired with bargain-tier shot).',
        },
      },
      required: [
        'exposure_balance',
        'color_cast',
        'sharpness_subject',
        'sharpness_corners',
        'depth_layering',
        'composition_geometry',
        'vantage_quality',
        'framing_quality',
        'leading_lines',
        'negative_space',
        'symmetry_quality',
        'perspective_distortion',
        'plumb_verticals',
        'material_specificity',
        'period_reading',
        'styling_quality',
        'distraction_freeness',
        'retouch_debt',
        'gallery_arc_position',
        'social_crop_survival',
        'brochure_print_survival',
        'reading_grade_match',
      ],
    },

    // ─── iter-5 enrichments ─────────────────────────────────────────────────
    listing_copy: {
      type: 'object',
      description:
        'Per-image listing copy in the voice anchor rubric supplied in the user ' +
        'prompt. Each image gets its own headline + 2-3 paragraph caption block — ' +
        'used in swimlane "why this image" panels and gallery image captions. ' +
        'Voice MUST match the supplied tier (premium / standard / approachable). ' +
        'Forbidden patterns from the rubric apply (no "stunning", "boasts", ' +
        '"nestled", "must inspect", no exclamation marks).',
      properties: {
        headline: {
          type: 'string',
          description:
            '5-12 words depending on tier (premium 8-12, standard 6-10, ' +
            'approachable 5-8). Specific to THIS image, not generic. Lead with ' +
            "the image's distinguishing feature (material, room, vantage). " +
            'GOOD: "Caesarstone island anchors a north-light kitchen". ' +
            'FORBIDDEN: "Beautiful kitchen with modern features".',
        },
        paragraphs: {
          type: 'string',
          description:
            '2-3 short paragraphs, ~120-180 words for standard tier (premium ' +
            '140-200, approachable 80-140). Describe what the buyer sees in ' +
            'this image: vantage, light, materials, atmosphere, how this room ' +
            'feels to be in. Concrete and image-grounded; do not infer rooms ' +
            'or features outside the frame.',
        },
      },
      required: ['headline', 'paragraphs'],
    },
    appeal_signals: {
      type: 'array',
      description:
        'Marketing-relevant positives visible in this image. Use snake_case ' +
        'tokens from a known set + extend when needed. KNOWN SET: ' +
        'indoor_outdoor_living, natural_light, established_landscaping, ' +
        'period_features_intact, entertaining_layout, low_maintenance_garden, ' +
        'open_plan_flow, hero_view, calm_palette, warm_styling, ' +
        'oversized_kitchen_island, walk_in_pantry, scullery_visible, ' +
        'mudroom_visible, fireplace_focal, north_facing_rear, ' +
        'level_block_visible, study_nook, lock_up_garage, side_access. ' +
        'Empty array when none apply.',
      items: { type: 'string' },
    },
    concern_signals: {
      type: 'array',
      description:
        'Marketing-relevant negatives visible in this image. Use snake_case ' +
        'tokens. EXAMPLES: power_lines_visible, neighbouring_property_intrudes, ' +
        'dated_finishes, privacy_concerns, busy_road_visible, ' +
        'water_stains, ceiling_damage, mismatched_flooring, ' +
        'overgrown_garden, exposed_cables, cluttered_benchtops, ' +
        'kids_toys_present, agent_or_owner_in_frame, mirror_reflection_camera. ' +
        'Empty array when none apply.',
      items: { type: 'string' },
    },
    buyer_persona_hints: {
      type: 'array',
      description:
        'Likely buyer personas this image speaks to. Tokens: ' +
        'young_family_upgrader, downsizer, first_home_buyer, investor, ' +
        'renovator, working_professional_couple, multi_generational, ' +
        'lifestyle_buyer, school_catchment_seeker. Up to 3 entries.',
      items: { type: 'string' },
    },
    retouch_priority: {
      type: 'string',
      description:
        'Editor-time priority. "urgent" = blocks shortlist (must retouch ' +
        'before publishing), "recommended" = improves but not blocking, ' +
        '"none" = no retouch needed.',
    },
    retouch_estimate_minutes: {
      type: 'integer',
      description:
        'Rough editor-time estimate in minutes for the retouch needed. 0 when ' +
        'retouch_priority="none".',
    },
    gallery_position_hint: {
      type: 'string',
      description:
        'Pre-Stage-4 preference for where this image should sit in the ' +
        'marketing gallery. "lead_image" = candidate for position 1; ' +
        '"early_gallery" = positions 2-6; "late_gallery" = supporting; ' +
        '"archive_only" = not for gallery.',
    },
    social_first_friendly: {
      type: 'boolean',
      description:
        'Does this image survive a 1:1 Instagram crop without losing its ' +
        'subject? True if the centre square preserves the hero feature.',
    },
    requires_human_review: {
      type: 'boolean',
      description:
        'True when the model is uncertain enough that an operator should ' +
        'eyeball this image before publishing (e.g. confidence_per_field ' +
        'flagged any sub-field <0.6, or the image has unusual content).',
    },
    confidence_per_field: {
      type: 'object',
      description:
        '0-1 self-reported confidence per field. Use 1.0 only when the ' +
        'evidence is unambiguous. Drop below 0.7 when you would not want ' +
        'this answer published without an operator eyeballing it.',
      properties: {
        room_type: { type: 'number' },
        scoring: { type: 'number' },
        classification: { type: 'number' },
      },
      required: ['room_type', 'scoring', 'classification'],
    },
    style_archetype: {
      type: 'string',
      description:
        'Architectural typology label, anchored against the Sydney primer in ' +
        'the system prompt. Examples: "Federation cottage", "1980s brick ' +
        'veneer ranch", "post-war fibro pavilion", "1960s Sydney School ' +
        'pavilion", "contemporary project home". When the building period or ' +
        'style is unclear, use "uncertain provenance".',
    },
    era_hint: {
      type: 'string',
      description:
        'Likely construction era or refurbishment hint. Examples: ' +
        '"circa 1955-1965", "post-war", "1980s with 2021 renovation", ' +
        '"contemporary build". Use "uncertain" when not visible.',
    },
    material_palette_summary: {
      type: 'array',
      description:
        'Top 3 materials by visual weight in this frame. Specific phrases ' +
        '("face brick", "Caesarstone benchtop", "spotted gum flooring") ' +
        'rather than generic ("brick", "stone", "wood"). Empty array if no ' +
        'materials are visibly distinguishable.',
      items: { type: 'string' },
    },
    embedding_anchor_text: {
      type: 'string',
      description:
        '~50-word concise summary optimised for vector embedding (downstream ' +
        'pgvector similarity search). Single dense paragraph naming room_type, ' +
        'archetype, key materials, vantage, time-of-day, dominant feature. ' +
        'Avoid stop-word fluff ("this image shows...", "a photo of..."). ' +
        'Lead with the most distinctive content tokens.',
    },
    searchable_keywords: {
      type: 'array',
      description:
        '5-12 single-word or hyphenated keyword tokens for SEO/search. ' +
        'lowercase, snake_case or single words. Examples: ' +
        '"caesarstone", "shaker-cabinetry", "north-facing", "alfresco", ' +
        '"federation-style", "ducted-ac".',
      items: { type: 'string' },
    },
    shot_intent: {
      type: 'string',
      description:
        "Photographer's likely intent for this frame. One of: " +
        'hero_establishing | scale_clarification | lifestyle_anchor | ' +
        'material_proof | indoor_outdoor_connection | detail_specimen | ' +
        'record_only | reshoot_candidate. ' +
        'hero_establishing = signature wide. material_proof = close-in for ' +
        'spec validation. record_only = documentation, not marketing. ' +
        'reshoot_candidate = your own shot you would redo.',
    },
  },
  required: [
    'analysis',
    'room_type',
    // W11.6.13 — both new orthogonal axes are required (space_zone_count
    // remains optional but recommended; the model is encouraged but not
    // forced to emit it).
    'space_type',
    'zone_focus',
    'composition_type',
    'technical_score',
    'lighting_score',
    'composition_score',
    'aesthetic_score',
    'key_elements',
    'zones_visible',
    // W11.2 — per-signal granularity. The 22-key signal_scores object lets
    // tier_configs (W8) weight per-signal in addition to per-axis.
    'signal_scores',
    'listing_copy',
    'appeal_signals',
    'concern_signals',
    'retouch_priority',
    'gallery_position_hint',
    'requires_human_review',
    'confidence_per_field',
    'style_archetype',
    'era_hint',
    'material_palette_summary',
    'embedding_anchor_text',
    'shot_intent',
  ],
};

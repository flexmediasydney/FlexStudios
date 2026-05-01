/**
 * stage1Prompt.ts — Wave 11.7.1 production Stage 1 prompt + schema.
 *
 * Per-batch Stage 1 emits ONE response containing per-image entries (keyed by
 * stem) covering the full W11 universal schema + iter-5 enrichments:
 *   - analysis (verbose ~1,700 char)
 *   - room_type / composition_type / vantage_point / scoring (4 dims)
 *   - key_elements (≥8 multi-noun phrases)
 *   - listing_copy { headline, paragraphs }
 *   - appeal_signals / concern_signals / buyer_persona_hints
 *   - retouch_priority / retouch_estimate_minutes
 *   - gallery_position_hint / social_first_friendly / requires_human_review
 *   - confidence_per_field
 *   - style_archetype / era_hint / material_palette_summary
 *   - embedding_anchor_text / searchable_keywords / shot_intent
 *
 * The schema is W11.universal-compatible (per-image fields validated against
 * mig 283 composition_classifications columns) plus the iter-5 enrichment
 * fields stored in JSONB columns or surfaced to Stage 4 via the merged JSON.
 *
 * Differences from the harness `iter5Schema.ts`:
 *   - Wraps per-image entries in `per_image[]` keyed by `stem` so a single
 *     batched call returns 50 stems in one structured response
 *     (vs harness which fans out one call per image).
 *   - Tightens `description` text to instruct the model to emit one entry per
 *     supplied image, in order, matching the stems listed in the user prompt.
 */

import type { VoiceAnchorOpts } from '../_shared/visionPrompts/blocks/voiceAnchorBlock.ts';

export const STAGE1_PROMPT_VERSION = 'v1.0';
export const STAGE1_TOOL_NAME = 'classify_image_batch';

/**
 * Stage 1 batched per-image schema. The model receives N images (≤50) and
 * emits N entries in `per_image[]`, one per stem, in the same order.
 *
 * Gemini responseSchema constraints honoured:
 *   - no $ref / oneOf / anyOf
 *   - no patternProperties / additionalProperties
 *   - no minLength / maxLength on strings (use description guidance instead)
 *   - minItems / required are honoured
 */
export const STAGE1_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    schema_version: {
      type: 'string',
      description: 'Always "v1.0".',
    },
    per_image: {
      type: 'array',
      minItems: 1,
      description:
        'One entry per input image, in the SAME ORDER as the supplied previews. ' +
        'The `stem` field must EXACTLY match the stem listed in the user prompt ' +
        'for the corresponding image. Do not skip, reorder, or invent stems.',
      items: {
        type: 'object',
        properties: {
          stem: {
            type: 'string',
            description:
              'The image stem (filename without extension), exactly as listed ' +
              'in the user prompt for this image position.',
          },
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
              'a hero-quality framing of the front facade.',
          },
          room_type_confidence: { type: 'number' },
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
              '"roof", "column", "brick", "balustrade".',
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

          // ─── iter-5 enrichments ───────────────────────────────────────────
          listing_copy: {
            type: 'object',
            description:
              'Per-image listing copy in the voice anchor rubric supplied in the user ' +
              'prompt. Each image gets its own headline + 2-3 paragraph caption block. ' +
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
              'tokens. KNOWN SET: indoor_outdoor_living, natural_light, ' +
              'established_landscaping, period_features_intact, entertaining_layout, ' +
              'low_maintenance_garden, open_plan_flow, hero_view, calm_palette, ' +
              'warm_styling, oversized_kitchen_island, walk_in_pantry, scullery_visible, ' +
              'mudroom_visible, fireplace_focal, north_facing_rear, level_block_visible, ' +
              'study_nook, lock_up_garage, side_access. Empty array when none apply.',
            items: { type: 'string' },
          },
          concern_signals: {
            type: 'array',
            description:
              'Marketing-relevant negatives visible in this image. Use snake_case ' +
              'tokens. EXAMPLES: power_lines_visible, neighbouring_property_intrudes, ' +
              'dated_finishes, privacy_concerns, busy_road_visible, water_stains, ' +
              'ceiling_damage, mismatched_flooring, overgrown_garden, exposed_cables, ' +
              'cluttered_benchtops, kids_toys_present, agent_or_owner_in_frame, ' +
              'mirror_reflection_camera. Empty array when none apply.',
            items: { type: 'string' },
          },
          buyer_persona_hints: {
            type: 'array',
            description:
              'Likely buyer personas this image speaks to. Tokens: ' +
              'young_family_upgrader, downsizer, first_home_buyer, investor, renovator, ' +
              'working_professional_couple, multi_generational, lifestyle_buyer, ' +
              'school_catchment_seeker. Up to 3 entries.',
            items: { type: 'string' },
          },
          retouch_priority: {
            type: 'string',
            description:
              'Editor-time priority. "urgent" = blocks shortlist; "recommended" = ' +
              'improves but not blocking; "none" = no retouch needed.',
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
              'Pre-Stage-4 preference for where this image should sit in the marketing ' +
              'gallery. "lead_image" | "early_gallery" | "late_gallery" | "archive_only".',
          },
          social_first_friendly: {
            type: 'boolean',
            description:
              'Does this image survive a 1:1 Instagram crop without losing its subject?',
          },
          requires_human_review: {
            type: 'boolean',
            description:
              'True when the model is uncertain enough that an operator should ' +
              'eyeball this image before publishing.',
          },
          confidence_per_field: {
            type: 'object',
            description:
              '0-1 self-reported confidence per field. Use 1.0 only when the evidence ' +
              'is unambiguous. Drop below 0.7 when you would not want this answer ' +
              'published without an operator eyeballing it.',
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
              'the system prompt. Use "uncertain provenance" when the building period ' +
              'or style is unclear.',
          },
          era_hint: {
            type: 'string',
            description:
              'Likely construction era or refurbishment hint. Use "uncertain" when ' +
              'not visible.',
          },
          material_palette_summary: {
            type: 'array',
            description:
              'Top 3 materials by visual weight in this frame. Specific phrases ' +
              '("face brick", "Caesarstone benchtop", "spotted gum flooring") rather than ' +
              'generic ("brick", "stone", "wood"). Empty array if no materials are ' +
              'visibly distinguishable.',
            items: { type: 'string' },
          },
          embedding_anchor_text: {
            type: 'string',
            description:
              '~50-word concise summary optimised for vector embedding (downstream ' +
              'pgvector similarity search). Single dense paragraph naming room_type, ' +
              'archetype, key materials, vantage, time-of-day, dominant feature.',
          },
          searchable_keywords: {
            type: 'array',
            description:
              '5-12 single-word or hyphenated keyword tokens for SEO/search. ' +
              'lowercase, snake_case or single words.',
            items: { type: 'string' },
          },
          shot_intent: {
            type: 'string',
            description:
              "Photographer's likely intent for this frame. One of: " +
              'hero_establishing | scale_clarification | lifestyle_anchor | ' +
              'material_proof | indoor_outdoor_connection | detail_specimen | ' +
              'record_only | reshoot_candidate.',
          },
        },
        required: [
          'stem',
          'analysis',
          'room_type',
          'composition_type',
          'technical_score',
          'lighting_score',
          'composition_score',
          'aesthetic_score',
          'key_elements',
          'zones_visible',
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
      },
    },
  },
  required: ['schema_version', 'per_image'],
};

// ─── Prompt builders ─────────────────────────────────────────────────────────

export interface BuildStage1SystemPromptOpts {
  voice: VoiceAnchorOpts;
  sydneyPrimer: string;
}

export function buildStage1SystemPrompt(opts: BuildStage1SystemPromptOpts): string {
  return [
    'You are a senior architectural photo editor working on a professional Sydney',
    "real estate media company's shortlisting engine. Your job is per-image",
    'classification + scoring + listing-copy synthesis in a single batched call.',
    '',
    'TASK',
    'You will receive a batch of up to 50 images from a single property shoot.',
    'For EACH image, emit a structured per-image entry containing:',
    '  - analysis (5-7 sentences, verbose, reasoning-first)',
    '  - room_type / composition_type / vantage_point classification',
    '  - 4-dimension scoring (technical, lighting, composition, aesthetic)',
    '  - key_elements (≥8 multi-noun phrases — material + treatment + style)',
    '  - listing_copy { headline, paragraphs } in the voice tier rubric',
    '  - appeal_signals / concern_signals / buyer_persona_hints',
    '  - retouch_priority + estimate / gallery_position_hint',
    '  - style_archetype + era_hint + material_palette_summary',
    '  - embedding_anchor_text + searchable_keywords + shot_intent',
    '',
    'STEP 1 / STEP 2 ordering (REASONING-FIRST):',
    '  Write the full `analysis` paragraph BEFORE producing any scores. Scores',
    '  are derived from the analysis, not generated alongside it. Without this,',
    '  the prose becomes post-hoc justification of an arbitrary number and',
    '  score/text consistency drops.',
    '',
    'BATCH DISCIPLINE',
    '  - Emit ONE entry per input image, in the SAME ORDER as the supplied',
    '    previews. The `stem` field MUST exactly match the stem listed in the',
    '    user prompt for that image position.',
    '  - Never skip an image, never reorder, never invent stems.',
    '',
    opts.sydneyPrimer,
    '',
    'Return ONE JSON object matching the schema in the user prompt.',
  ].join('\n');
}

export interface BuildStage1UserPromptOpts {
  sourceContextBlockText: string;
  voiceBlockText: string;
  selfCritiqueBlockText: string;
  imageStems: string[];
}

export function buildStage1UserPrompt(opts: BuildStage1UserPromptOpts): string {
  return [
    opts.sourceContextBlockText,
    '',
    '── VOICE ANCHOR (drives per-image listing_copy register) ──',
    opts.voiceBlockText,
    '',
    `── BATCH (${opts.imageStems.length} images, in this order) ──`,
    'Each image preview attached after this prompt corresponds to one stem in the',
    'list below, in order. Emit `per_image[i]` for stems[i], with `stem` set to',
    'the matching string.',
    '',
    'Stems in this batch:',
    opts.imageStems.map((s, i) => `  ${i + 1}. ${s}`).join('\n'),
    '',
    opts.selfCritiqueBlockText,
    '',
    '── REQUIRED OUTPUT ──',
    'Return one JSON object matching the schema. `per_image` MUST have exactly',
    `${opts.imageStems.length} entries — one per image — with stems matching the list`,
    'above. All required fields must be present per entry.',
  ].join('\n');
}

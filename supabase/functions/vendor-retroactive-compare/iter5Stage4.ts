/**
 * iter5Stage4.ts — Stage 4 visual master synthesis schema + prompt builder.
 *
 * Stage 4 is the architectural core of iter-5 (Shape D). It runs ONCE per
 * round AFTER all Stage 1 per-image batches succeed:
 *   - Sees ALL preview images at once (visual cross-image reasoning)
 *   - Receives merged Stage 1 JSON as text context (per-image enrichment)
 *   - Receives property facts (CRM-derived; never invented)
 *   - Receives voice anchor rubric (tier-aware)
 *
 * Outputs:
 *   - slot_decisions[]               (which image is the hero kitchen?)
 *   - master_listing{}               (full publication-ready listing copy)
 *   - gallery_sequence[]             (ordered stems for marketing gallery)
 *   - dedup_groups[]                 (visually similar clusters)
 *   - missing_shot_recommendations[] (proactive callouts)
 *   - narrative_arc_score            (gallery walkthrough coherence)
 *   - property_archetype_consensus   (master-level archetype)
 *   - overall_property_score         (single property-level rating)
 *   - stage_4_overrides[]            (audit when visual-context corrects Stage 1)
 *   - coverage_notes / quality_outliers
 *
 * Budget: thinkingBudget=16384, max_output_tokens=16000.
 *
 * Dependencies: voiceAnchorBlock, SYDNEY_PRIMER_BLOCK, SELF_CRITIQUE_BLOCK
 * from iter5VoiceAnchor.ts. Property facts injected from `projects` row.
 */

import type { VoiceAnchorOpts } from './iter5VoiceAnchor.ts';
import {
  voiceAnchorBlock,
  SELF_CRITIQUE_BLOCK,
  VOICE_ANCHOR_BLOCK_VERSION,
} from './iter5VoiceAnchor.ts';

export const STAGE4_TOOL_NAME = 'synthesise_round';
export const STAGE4_PROMPT_VERSION = 'iter5-stage4-v1.0';

/**
 * Property facts pulled from `projects` row before Stage 4. Injected into the
 * Stage 4 prompt as authoritative; the prompt explicitly forbids the model
 * from inventing any factual figure not present here.
 */
export interface PropertyFacts {
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  land_size_sqm: number | null;
  internal_size_sqm: number | null;
  price_guide_band: string | null;
  auction_or_private_treaty: string | null;
}

/**
 * Per-image entry in the Stage 1 merged JSON context handed to Stage 4.
 * Trimmed for prompt-budget reasons — we keep the load-bearing fields and
 * drop the long fluff (full analysis prose, attribute objects).
 */
export interface Stage1MergedEntry {
  stem: string;
  group_id: string;
  group_index: number;
  room_type?: string | null;
  composition_type?: string | null;
  vantage_point?: string | null;
  technical_score?: number | null;
  lighting_score?: number | null;
  composition_score?: number | null;
  aesthetic_score?: number | null;
  is_styled?: boolean | null;
  indoor_outdoor_visible?: boolean | null;
  clutter_severity?: string | null;
  flag_for_retouching?: boolean | null;
  // iter-5 additions surfaced verbatim to Stage 4
  appeal_signals?: string[] | null;
  concern_signals?: string[] | null;
  retouch_priority?: string | null;
  gallery_position_hint?: string | null;
  shot_intent?: string | null;
  style_archetype?: string | null;
  era_hint?: string | null;
  material_palette_summary?: string[] | null;
  embedding_anchor_text?: string | null;
  key_elements?: string[] | null;
  zones_visible?: string[] | null;
  listing_copy?: { headline?: string; paragraphs?: string } | null;
  social_first_friendly?: boolean | null;
  requires_human_review?: boolean | null;
  confidence_per_field?: { room_type?: number; scoring?: number; classification?: number } | null;
}

// ─── Stage 4 output schema (Gemini responseSchema-compatible) ────────────────

/**
 * Schema-as-prompt: every property's `description` field is read by the model
 * as inline instruction. Match the iter-4 standard (specific verbosity targets,
 * forbidden vs accepted patterns, length bands).
 *
 * Gemini responseSchema constraints honoured:
 *   - no $ref / oneOf / anyOf
 *   - no patternProperties / additionalProperties
 *   - no minLength / maxLength on strings (use description guidance instead)
 *   - minItems / required are honoured
 */
export const STAGE4_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    schema_version: {
      type: 'string',
      description: 'Always "iter5-stage4-v1.0".',
    },

    // ─── Slot decisions ──────────────────────────────────────────────────
    slot_decisions: {
      type: 'array',
      minItems: 4,
      description:
        'Slot-by-slot hero picks made WITH visual cross-comparison. Cover the ' +
        'standard slot lattice for a 3-bed family home: exterior_facade_hero, ' +
        'kitchen_hero, living_hero, master_bedroom, alfresco/outdoor_hero plus ' +
        'any obvious supporting slots (additional bedrooms, bathrooms, exterior_rear). ' +
        'For each slot: pick the single image that best fills the role given ' +
        'lighting, vantage, styling, distractions, and how it sits within the ' +
        'gallery flow. Provide 1-2 alternatives + rationale per slot.',
      items: {
        type: 'object',
        properties: {
          slot_id: {
            type: 'string',
            description:
              'Slot identifier (canonical lowercase snake_case): exterior_facade_hero | ' +
              'kitchen_hero | living_hero | master_bedroom | alfresco_hero | ' +
              'exterior_rear | bedroom_secondary | bathroom_main | etc.',
          },
          phase: {
            type: 'integer',
            description: '1 = lead/hero gallery; 2 = supporting; 3 = detail/archive.',
          },
          winner: {
            type: 'object',
            properties: {
              stem: { type: 'string' },
              rationale: {
                type: 'string',
                description:
                  '2-4 sentences citing specific visual evidence: lighting, ' +
                  'vantage, styling, distinguishing material, why this beats the ' +
                  'alternatives. Refer to other stems by name when comparing.',
              },
            },
            required: ['stem', 'rationale'],
          },
          alternatives: {
            type: 'array',
            description: 'Up to 2 backup picks with one-sentence rationale each.',
            items: {
              type: 'object',
              properties: {
                stem: { type: 'string' },
                rationale: { type: 'string' },
              },
              required: ['stem', 'rationale'],
            },
          },
          rejected_near_duplicates: {
            type: 'array',
            description:
              'Stems rejected as visually-near-identical to the winner. Each ' +
              'entry includes which winning stem it duplicates.',
            items: {
              type: 'object',
              properties: {
                stem: { type: 'string' },
                near_dup_of: { type: 'string' },
              },
              required: ['stem', 'near_dup_of'],
            },
          },
        },
        required: ['slot_id', 'phase', 'winner', 'alternatives'],
      },
    },

    // ─── Master listing object ───────────────────────────────────────────
    master_listing: {
      type: 'object',
      description:
        'Complete publication-ready listing copy. Voice locked to property_tier ' +
        'rubric supplied in the prompt. Every factual figure (bedrooms, bathrooms, ' +
        'sqm, price guide) MUST come from the property_facts block — never invent ' +
        'a number. If a fact is missing from property_facts, omit it from the copy.',
      properties: {
        headline: {
          type: 'string',
          description:
            '8-15 words. Specific, image-grounded; no exclamation marks; no ' +
            'cliches. Premium tier: lead with architectural lineage or material. ' +
            'Standard tier: suburb position + character ("Brick Cottage on a Level ' +
            'Block in Punchbowl\'s Leafy West"). Approachable: bed/bath count + ' +
            'distinguishing feature.',
        },
        sub_headline: {
          type: 'string',
          description:
            '12-25 words. Elaborates the headline with one substantive specific ' +
            '(material + lifestyle frame). Single sentence.',
        },
        scene_setting_paragraph: {
          type: 'string',
          description:
            '150-200 words. Facade + character + first-impression. Material-led ' +
            'opening, period reference where warranted. Forbid "welcome to", ' +
            '"nestled in", "boasting".',
        },
        interior_paragraph: {
          type: 'string',
          description:
            '150-220 words. Floor plan + key rooms with specifics — bench ' +
            'material, flooring, window orientation. Forbid generic listing of ' +
            'room counts.',
        },
        lifestyle_paragraph: {
          type: 'string',
          description:
            '150-200 words. Entertaining, family, indoor-outdoor. Concrete ' +
            'lifestyle evidence. Forbid hypothetical scenarios divorced from images.',
        },
        closing_paragraph: {
          type: 'string',
          description:
            '100-150 words optional 4th paragraph. Material specificity / unique ' +
            'angle. Use empty string for standard-tier suburban homes when not ' +
            'warranted; populate on premium / character properties.',
        },
        key_features: {
          type: 'array',
          minItems: 6,
          description:
            '6-10 specific noun-verb fragments. Material + count + context. ' +
            'GOOD: "Caesarstone island bench, 20mm matte stone", "Federation-' +
            'style ceiling roses preserved in front formal", "Covered alfresco ' +
            'with mains-gas BBQ outlet". FORBIDDEN: bare clichés ("modern ' +
            'kitchen", "spacious living").',
          items: { type: 'string' },
        },
        location_paragraph: {
          type: 'string',
          description:
            '80-120 words. Suburb pocket, numeric walking distances when known. ' +
            'Forbid vague distance language ("close to amenities" / "quiet ' +
            'street").',
        },
        target_buyer_summary: {
          type: 'string',
          description:
            '15-25 words. Direct identification of the buyer profile. ' +
            'Example: "A first-home upgrader or growing family looking for a ' +
            'cleanly renovated three-bedroom on a real backyard in catchment."',
        },
        seo_meta_description: {
          type: 'string',
          description:
            '<=155 chars. Single sentence: suburb + property type + one ' +
            'distinguishing feature + one benefit. Declarative, no exclamation marks.',
        },
        social_post_caption: {
          type: 'string',
          description:
            'Instagram-ready, 1-2 lines + 5-8 hashtags. Caption leads with the ' +
            'most arresting visual or feature, ends with suburb. No emoji.',
        },
        print_brochure_summary: {
          type: 'string',
          description:
            '~200 word distillation. Opening sentence -> 4-5 most compelling ' +
            'specifics -> closing buyer-fit sentence. No em-dashes (do not render ' +
            'reliably in budget print). Short paragraphs.',
        },
        agent_one_liner: {
          type: 'string',
          description:
            '10-15 words for verbal pitch. Single sentence the listing agent ' +
            'can deliver naturally.',
        },
        open_home_email_blurb: {
          type: 'string',
          description:
            '3-4 lines for buyer-database email. Open-time anchor + 2-3 ' +
            'distinguishing specifics + parking/RSVP optional.',
        },
        word_count: {
          type: 'integer',
          description:
            'Self-reported word count across headline + sub_headline + body ' +
            'paragraphs (scene + interior + lifestyle + closing if present). ' +
            'Standard tier target: 500-750. Premium: 700-1000. Approachable: 350-500.',
        },
        reading_grade_level: {
          type: 'number',
          description:
            'Self-reported Flesch-Kincaid grade. Standard target 8-10, ' +
            'premium 9-12, approachable 6-8.',
        },
        tone_anchor: {
          type: 'string',
          description:
            'Self-report of the voice anchor used. Free-text label e.g. ' +
            '"Domain editorial, warm-but-grounded".',
        },
      },
      required: [
        'headline',
        'sub_headline',
        'scene_setting_paragraph',
        'interior_paragraph',
        'lifestyle_paragraph',
        'key_features',
        'location_paragraph',
        'target_buyer_summary',
        'seo_meta_description',
        'social_post_caption',
        'print_brochure_summary',
        'agent_one_liner',
        'open_home_email_blurb',
        'word_count',
        'reading_grade_level',
        'tone_anchor',
      ],
    },

    // ─── Cross-image fields ──────────────────────────────────────────────
    gallery_sequence: {
      type: 'array',
      minItems: 8,
      description:
        'Ordered stems for the marketing gallery. Lead with the strongest hero ' +
        '(usually facade), then narrative arc through the property: outside-in, ' +
        'kitchen + living + dining group, bedrooms, bathrooms, alfresco/outdoor, ' +
        'closing on a hero detail or sunset/exterior rear. Length should reflect ' +
        'a publishable gallery (typically 12-25 images).',
      items: { type: 'string' },
    },
    dedup_groups: {
      type: 'array',
      description:
        'Clusters of visually-near-identical images ("6 angles of the same ' +
        'kitchen"). Each cluster gets a label + member stems. Empty array if ' +
        'every image is distinct.',
      items: {
        type: 'object',
        properties: {
          group_label: {
            type: 'string',
            description:
              'Short label naming the shared subject e.g. "kitchen wide angles" or "facade variants".',
          },
          image_stems: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['group_label', 'image_stems'],
      },
    },
    missing_shot_recommendations: {
      type: 'array',
      description:
        'Proactive callouts of shots the photographer should have captured ' +
        'but did not. Examples: "no clean exterior_facade_hero captured", ' +
        '"missing master_bedroom shot from the bed-side", "no alfresco-' +
        'through-glass shot". Empty array when coverage is complete.',
      items: { type: 'string' },
    },
    narrative_arc_score: {
      type: 'number',
      description:
        '0-10 — how well the gallery_sequence narrates the property as a ' +
        'walkthrough (does it flow from outside-in, build emotional anchor ' +
        'points, close with a hero detail). 10 = exceptional gallery flow; ' +
        '5 = competent but uninspired; 0 = no coherent arc.',
    },
    property_archetype_consensus: {
      type: 'string',
      description:
        'Master-level archetype anchored to the actual property after seeing ' +
        'all images. Examples: "1980s brick veneer ranch, partially renovated ' +
        '2021", "1920s Federation cottage with sympathetic 2022 rear pavilion".',
    },
    overall_property_score: {
      type: 'number',
      description:
        '0-10 single property-level Tier rating reflecting gallery quality + ' +
        'architectural interest + coverage completeness.',
    },
    stage_4_overrides: {
      type: 'array',
      description:
        'Audit trail for visual cross-comparison corrections of Stage 1. ' +
        'When Stage 4\'s view of all images shows that Stage 1 was wrong on a ' +
        'per-image field (e.g. room_type), emit a row here rather than silently ' +
        'changing the answer. Healthy override rate: 2-8% of images. Empty ' +
        'array when no corrections needed.',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          field: {
            type: 'string',
            description: 'Stage 1 field that needs correction e.g. "room_type" or "vantage_point".',
          },
          stage_1_value: { type: 'string' },
          stage_4_value: { type: 'string' },
          reason: {
            type: 'string',
            description:
              '1-2 sentences citing the visual cross-comparison evidence ' +
              '(reference other stems by name).',
          },
        },
        required: ['stem', 'field', 'stage_1_value', 'stage_4_value', 'reason'],
      },
    },
    coverage_notes: {
      type: 'string',
      description:
        '2-4 sentences summarising overall shoot coverage: which slots are ' +
        'well-covered vs thin, any retouch concerns, any package-level gaps.',
    },
    quality_outliers: {
      type: 'array',
      description:
        'Images that scored materially above or below the round average. ' +
        'Use direction "over_delivered" or "under_delivered". Suggest a ' +
        'production action (reshoot, retouch, surface as bonus hero, etc).',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          actual_score: { type: 'number' },
          expected_for_tier: { type: 'number' },
          direction: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['stem', 'actual_score', 'expected_for_tier', 'direction', 'suggestion'],
      },
    },
  },
  required: [
    'schema_version',
    'slot_decisions',
    'master_listing',
    'gallery_sequence',
    'dedup_groups',
    'missing_shot_recommendations',
    'narrative_arc_score',
    'property_archetype_consensus',
    'overall_property_score',
    'stage_4_overrides',
    'coverage_notes',
    'quality_outliers',
  ],
};

// ─── Stage 4 system + user prompt builders ───────────────────────────────────

export function buildStage4SystemPrompt(): string {
  return [
    'You are a senior architectural photo editor + real estate copy editor with',
    "20+ years' experience working on Sydney premium and family-home listings.",
    '',
    'TASK',
    'You will receive ALL approved images from a single property shoot at once,',
    'plus the per-image enrichment JSON produced by Stage 1 of the engine, plus',
    'authoritative property facts from the CRM, plus a voice anchor rubric.',
    '',
    'Your job is to:',
    '  1. Make slot decisions WITH visual cross-comparison (which image is the',
    '     hero kitchen? which is the lead facade? which alfresco does the job?).',
    "  2. Draft a complete publication-ready master listing in the property's",
    '     tier voice.',
    '  3. Sequence the marketing gallery (ordered stems, narrative arc).',
    '  4. Group near-duplicates so production knows where to cull.',
    "  5. Call out missing shots the photographer didn't capture.",
    '  6. Where your visual cross-comparison shows Stage 1 was wrong on any',
    '     per-image field, emit a stage_4_overrides[] row rather than silently',
    '     changing the answer. The override entries are first-class training',
    '     data for the engine and operator review surface.',
    '',
    'DISCIPLINE',
    "- Never invent factual figures. If a number isn't in property_facts, omit",
    '  it from listing copy.',
    '- Never describe what is not in the frame. If a feature is implied but',
    '  unseen, say "implied" or omit.',
    '- Voice anchor rubric is law — if it says "no exclamation marks" or "no',
    '  stunning", do not slip those in.',
    '- Apply the Sydney typology primer when naming style_archetype + period.',
    '',
    'Return ONE JSON object matching the schema in the user prompt.',
  ].join('\n');
}

export interface BuildStage4UserPromptOpts {
  voice: VoiceAnchorOpts;
  propertyFacts: PropertyFacts;
  stage1Merged: Stage1MergedEntry[];
  imageStemsInBatchOrder: string[];
  totalImages: number;
}

export function buildStage4UserPrompt(opts: BuildStage4UserPromptOpts): string {
  const facts = opts.propertyFacts;
  const factLines: string[] = [];
  if (facts.address_line) factLines.push(`address_line: ${facts.address_line}`);
  if (facts.suburb) factLines.push(`suburb: ${facts.suburb}`);
  if (facts.state) factLines.push(`state: ${facts.state}`);
  if (typeof facts.bedrooms === 'number') factLines.push(`bedrooms: ${facts.bedrooms}`);
  if (typeof facts.bathrooms === 'number') factLines.push(`bathrooms: ${facts.bathrooms}`);
  if (typeof facts.car_spaces === 'number') factLines.push(`car_spaces: ${facts.car_spaces}`);
  if (typeof facts.land_size_sqm === 'number') factLines.push(`land_size_sqm: ${facts.land_size_sqm}`);
  if (typeof facts.internal_size_sqm === 'number') factLines.push(`internal_size_sqm: ${facts.internal_size_sqm}`);
  if (facts.price_guide_band) factLines.push(`price_guide_band: ${facts.price_guide_band}`);
  if (facts.auction_or_private_treaty) {
    factLines.push(`auction_or_private_treaty: ${facts.auction_or_private_treaty}`);
  }
  if (factLines.length === 0) factLines.push('(no CRM facts populated — describe what is visible only)');

  // Compact Stage 1 JSON to keep prompt under budget. Drop large prose
  // (analysis full text), keep load-bearing classification + scores +
  // iter-5 enrichments.
  const compactStage1 = opts.stage1Merged.map((e) => ({
    stem: e.stem,
    room_type: e.room_type ?? null,
    composition_type: e.composition_type ?? null,
    vantage: e.vantage_point ?? null,
    scores: {
      tech: e.technical_score ?? null,
      light: e.lighting_score ?? null,
      comp: e.composition_score ?? null,
      aes: e.aesthetic_score ?? null,
    },
    is_styled: e.is_styled ?? null,
    indoor_outdoor: e.indoor_outdoor_visible ?? null,
    clutter: e.clutter_severity ?? null,
    retouch_priority: e.retouch_priority ?? null,
    gallery_position_hint: e.gallery_position_hint ?? null,
    shot_intent: e.shot_intent ?? null,
    style_archetype: e.style_archetype ?? null,
    era_hint: e.era_hint ?? null,
    appeal_signals: (e.appeal_signals ?? []).slice(0, 6),
    concern_signals: (e.concern_signals ?? []).slice(0, 4),
    key_elements: (e.key_elements ?? []).slice(0, 8),
    listing_headline: e.listing_copy?.headline ?? null,
  }));

  return [
    voiceAnchorBlock(opts.voice),
    '',
    '── PROPERTY FACTS (authoritative; do NOT invent) ──',
    factLines.join('\n'),
    '',
    `── STAGE 1 PER-IMAGE ENRICHMENT (${opts.stage1Merged.length} entries) ──`,
    'Use this as text context alongside the visual previews. Each entry is the',
    'compact summary of what Stage 1 said about that image. You see the actual',
    'images directly via the inline previews — use both. When the visual',
    'evidence contradicts Stage 1, emit a stage_4_overrides[] entry.',
    '',
    JSON.stringify(compactStage1, null, 0),
    '',
    `── IMAGE PREVIEWS (${opts.totalImages} images, in this order) ──`,
    'The previews following this prompt are in the same order as the stems below.',
    'Refer to images by stem. Stems in delivered order:',
    opts.imageStemsInBatchOrder.join(', '),
    '',
    SELF_CRITIQUE_BLOCK,
    '',
    '── REQUIRED OUTPUT ──',
    'Return one JSON object exactly matching the schema. All required fields',
    'must be present. Use empty array [] for collections with no entries (do',
    'not omit). Use empty string "" for closing_paragraph when not warranted.',
  ].join('\n');
}

export function stage4PromptVersions(): Record<string, string> {
  return {
    stage4_prompt: STAGE4_PROMPT_VERSION,
    voice_anchor: VOICE_ANCHOR_BLOCK_VERSION,
  };
}

/**
 * stage4Prompt.ts — Wave 11.7.1 production Stage 4 visual master synthesis.
 *
 * Promoted from `vendor-retroactive-compare/iter5Stage4.ts` after iter-5
 * Saladine validation. Sees ALL preview images at once + reads merged Stage 1
 * JSON as supplementary text context. Produces:
 *   - slot_decisions[]
 *   - master_listing{} (full publication-ready listing copy per W11.7.7)
 *   - gallery_sequence[]
 *   - dedup_groups[]
 *   - missing_shot_recommendations[]
 *   - narrative_arc_score / property_archetype_consensus / overall_property_score
 *   - stage_4_overrides[] (audit when visual cross-comparison corrects Stage 1)
 *   - coverage_notes / quality_outliers
 *
 * Budget: thinkingBudget=16384, max_output_tokens=16000, timeout=240s.
 *
 * The system + user prompts compose source-context preamble (W11.7.1) at the
 * top, then voice anchor (W11.7.7/8), then property facts, then Stage 1 JSON
 * context, then image stems list, then self-critique block.
 */

import { CANONICAL_SLOT_IDS } from '../_shared/visionPrompts/blocks/slotEnumeration.ts';

// W11.6.22 — bumped to v1.2: slot_decisions[] now accepts optional
// position_index + position_filled_via fields so curated_positions slots can
// fill one image per position with a curated_match / ai_backfill marker.
// Legacy ai_decides slot_decisions stay unchanged (both fields null).
export const STAGE4_PROMPT_VERSION = 'v1.2';
export const STAGE4_TOOL_NAME = 'synthesise_round';

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
  // W11.6.13 — orthogonal SPACE/ZONE pair. Stage 4 reads both alongside the
  // legacy room_type so visual cross-comparison can correct any axis
  // independently (e.g. space wrong but zone right, or vice-versa).
  space_type?: string | null;
  zone_focus?: string | null;
  space_zone_count?: number | null;
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
  key_elements?: string[] | null;
  zones_visible?: string[] | null;
}

// ─── Stage 4 schema (Gemini responseSchema-compatible) ──────────────────────

export const STAGE4_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    // QC-iter2-W3 F-D-005: description was hardcoded `Always "v1.0"` so the
    // model echoed v1.0 forever even after STAGE4_PROMPT_VERSION advanced.
    // Source the version dynamically from the constant so future bumps stay
    // in sync without touching the schema.
    schema_version: {
      type: 'string',
      description: `Echo "${STAGE4_PROMPT_VERSION}".`,
    },

    // ─── Slot decisions ──────────────────────────────────────────────────
    // QC-iter2-W3 F-D-006: previous examples (`master_bedroom`,
    // `alfresco/outdoor_hero`) were NOT in the canonical slot_id enum. The
    // model parroted these and then tripped Gemini's enum constraint or
    // collapsed onto bad aliases. Use canonical Phase-1 ids only.
    slot_decisions: {
      type: 'array',
      minItems: 4,
      description:
        'Slot-by-slot hero picks made WITH visual cross-comparison. Cover the ' +
        'standard slot lattice for a 3-bed family home: exterior_facade_hero, ' +
        'kitchen_hero, living_hero, master_bedroom_hero, alfresco_hero plus ' +
        'any obvious supporting slots (e.g. bedroom_secondary, bathroom_main, ' +
        'exterior_rear). See the slot_id enum for the full canonical list. ' +
        'For each slot: pick the single image that best fills the role given ' +
        'lighting, vantage, styling, distractions, and how it sits within the ' +
        'gallery flow. Provide 1-2 alternatives + rationale per slot.',
      items: {
        type: 'object',
        properties: {
          slot_id: {
            type: 'string',
            // W11.7.1 hygiene: closed enum sourced from CANONICAL_SLOT_IDS.
            // Gemini honours JSON-schema `enum` in responseSchema and will
            // refuse to emit anything outside the list. Drift like
            // `living_dining_hero`, `exterior_rear_hero`, `master_bedroom`
            // (vs `master_bedroom_hero`) is now structurally impossible.
            enum: [...CANONICAL_SLOT_IDS],
            description:
              'Slot identifier (canonical lowercase snake_case). Pick the ' +
              'closest match from the enum. Use `ai_recommended` for Phase 3 ' +
              'free recommendations not tied to a specific slot.',
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
                  'alternatives. Refer to other stems by name when comparing. ' +
                  'CRITICAL FIDELITY RULE: when this winner has LOWER per-image ' +
                  'quality scores than a rejected alternative, the rationale MUST ' +
                  'acknowledge this explicitly with the phrase "Despite ' +
                  '[winner_stem]\'s lower quality (X vs alternative\'s Y), it ' +
                  'better fits the slot because…". NEVER claim the winner is ' +
                  '"strongest" if its combined score is lower than rejected ' +
                  'alternatives — that contradicts the stored data.',
              },
              // W11.6.15: separate slot-fit dimension. Stage 4 frequently picks
              // a lower-scored image because of compositional intent (e.g. an
              // entry-hero that captures the foyer-as-subject vs a higher-
              // quality threshold shot). Without this, operators cannot tell
              // whether a slot decision was a deliberate slot-fit override of
              // raw quality or a reasoning error.
              slot_fit_score: {
                type: 'number',
                description:
                  '0-10 — how strongly this image fits the slot\'s compositional ' +
                  'intent, INDEPENDENT of per-image quality scores. ' +
                  'A 7/10 quality shot may be a 9/10 slot-fit if it captures the ' +
                  'slot\'s defining compositional move (e.g. a wide-angle corner ' +
                  'shot of the foyer for entry_hero beats a higher-quality ' +
                  'threshold shot looking through the screen). ' +
                  'Required to be transparent about slot-vs-quality trade-offs.',
              },
            },
            required: ['stem', 'rationale', 'slot_fit_score'],
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
          // W11.6.22 — curated_positions support. Both fields are OPTIONAL:
          // legacy ai_decides slots leave them null. For curated slots, emit
          // the 1-based position_index AND position_filled_via='curated_match'
          // (matched position's criteria) or 'ai_backfill' (no match, fell
          // back to AI choice when the position allowed it).
          position_index: {
            type: 'integer',
            nullable: true,
            description:
              'W11.6.22 — for curated_positions slots, the 1-based position ' +
              'this winner fills. NULL for ai_decides slots.',
          },
          position_filled_via: {
            type: 'string',
            nullable: true,
            enum: ['curated_match', 'ai_backfill'],
            description:
              'W11.6.22 — curated_match: winner satisfies the position\'s ' +
              'composition / zone / space / lighting / image_type criteria. ' +
              'ai_backfill: no candidate matched and you filled the position ' +
              'with your best AI alternative. NULL for ai_decides slots.',
          },
        },
        required: ['slot_id', 'phase', 'winner', 'alternatives'],
      },
    },

    // ─── Master listing object (W11.7.7) ─────────────────────────────────
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
            'Standard tier: suburb position + character. Approachable: bed/bath ' +
            'count + distinguishing feature.',
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
            'Forbid vague distance language.',
        },
        target_buyer_summary: {
          type: 'string',
          description:
            '15-25 words. Direct identification of the buyer profile.',
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
            'paragraphs. Standard tier target: 500-750. Premium: 700-1000. ' +
            'Approachable: 350-500.',
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

    // ─── Slot taxonomy proposals (W11.6.1-followup / W11.7 hook) ─────────
    // Optional surface so Gemini can flag patterns it sees REPEATEDLY across
    // a round that don't fit any of the canonical slot_ids. Empty array when
    // nothing warrants a new slot. The persistence layer (W11.6.6) writes
    // each entry to `shortlisting_events.event_type='pass2_slot_suggestion'`
    // for downstream operator review and (eventually) auto-promotion via the
    // SettingsObjectRegistryDiscovery admin surface (W12).
    proposed_slots: {
      type: 'array',
      description:
        'Suggested NEW slot taxonomy entries when Stage 4 sees a recurring ' +
        "composition pattern that doesn't fit any canonical slot. Empty array " +
        'when no proposals.',
      items: {
        type: 'object',
        properties: {
          proposed_slot_id: {
            type: 'string',
            description: 'snake_case lowercase, e.g. "cellar_hero", "wine_room"',
          },
          candidate_stems: {
            type: 'array',
            items: { type: 'string' },
          },
          reasoning: {
            type: 'string',
            description: '1-3 sentences why this should be a canonical slot',
          },
        },
        required: ['proposed_slot_id', 'candidate_stems', 'reasoning'],
      },
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
              'Short label naming the shared subject e.g. "kitchen wide angles".',
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
        'Proactive callouts of shots the photographer should have captured but ' +
        'did not. Empty array when coverage is complete.',
      items: { type: 'string' },
    },
    narrative_arc_score: {
      type: 'number',
      description:
        '0-10 — how well the gallery_sequence narrates the property as a ' +
        'walkthrough. 10 = exceptional gallery flow; 5 = competent but ' +
        'uninspired; 0 = no coherent arc.',
    },
    property_archetype_consensus: {
      type: 'string',
      description:
        'Master-level archetype anchored to the actual property after seeing ' +
        'all images.',
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
        'per-image field (e.g. space_type, zone_focus, room_type, vantage_point), ' +
        'emit a row here rather than silently changing the answer. Healthy ' +
        'override rate: 2-8% of images. Empty array when no corrections needed. ' +
        'W11.6.13: when correcting space_type OR zone_focus the rationale MUST ' +
        'reference BOTH axes explicitly — distinguish "wrong space" (architectural ' +
        'enclosure misread) from "wrong zone" (compositional subject misread). ' +
        'Same applies when correcting one axis: explain why the OTHER axis stayed ' +
        'the same so the operator review surface understands the distinction.',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          field: {
            type: 'string',
            description:
              'Stage 1 field that needs correction. W11.6.13: prefer the new ' +
              'orthogonal axes "space_type" or "zone_focus" over the legacy ' +
              '"room_type" when both are wrong. Other supported fields: ' +
              'composition_type, vantage_point, time_of_day, is_drone, ' +
              'is_exterior, clutter_severity.',
          },
          stage_1_value: { type: 'string' },
          stage_4_value: { type: 'string' },
          reason: {
            type: 'string',
            description:
              '1-2 sentences citing the visual cross-comparison evidence ' +
              '(reference other stems by name). W11.6.13: when the field is ' +
              'space_type or zone_focus, the rationale MUST address BOTH axes — ' +
              'name the architectural enclosure AND the compositional subject ' +
              'so the override is interpretable without reloading Stage 1 context.',
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
        'production action.',
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

// ─── Prompt builders ─────────────────────────────────────────────────────────

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
    "- If you see a recurring composition pattern that doesn't fit any of the",
    '  canonical slot_ids, surface it via `proposed_slots[]` rather than silently',
    "  picking the closest fit. Empty array when nothing warrants a new slot —",
    "  don't manufacture proposals.",
    '- W11.6.13: when emitting stage_4_overrides[] entries that correct',
    '  space_type or zone_focus, the rationale MUST address BOTH axes. Name',
    '  the architectural enclosure (space) AND the compositional subject (zone)',
    '  — distinguish "wrong space, right zone" from "right space, wrong zone"',
    '  from "both wrong". The override entries are first-class training data;',
    '  ambiguous rationale dilutes the signal.',
    '',
    'Return ONE JSON object matching the schema in the user prompt.',
  ].join('\n');
}

export interface BuildStage4UserPromptOpts {
  sourceContextBlockText: string;
  /**
   * Photographer-techniques preamble (W11.7.1 photographerTechniquesBlock).
   * Tells Stage 4 to recognise deliberate craft moves (e.g. fingers blocking
   * the sun for flare suppression) as PROTECTIVE techniques, not flaws —
   * never emit `photographer_error` overrides for these. Optional for
   * back-compat; production paths always supply it.
   */
  photographerTechniquesBlockText?: string;
  /**
   * W11.6.14: per-image EXIF metadata table rendered via
   * exifContextTable (compact pipe-separated rows, one per image).
   * Injected BEFORE the Stage 1 enrichment JSON so Gemini reads
   * focal/aperture/shutter/iso/bracket/risks for every image when
   * making cross-image slot decisions. Optional for back-compat;
   * production paths always supply it.
   */
  exifContextTableText?: string;
  voiceBlockText: string;
  selfCritiqueBlockText: string;
  propertyFacts: PropertyFacts;
  stage1Merged: Stage1MergedEntry[];
  imageStemsInOrder: string[];
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
  // (analysis full text), keep load-bearing classification + scores.
  // W11.6.13 — surface space_type / zone_focus / space_zone_count next to
  // the legacy room_type so Stage 4 can reason about both axes when emitting
  // overrides.
  const compactStage1 = opts.stage1Merged.map((e) => ({
    stem: e.stem,
    room_type: e.room_type ?? null,
    space_type: e.space_type ?? null,
    zone_focus: e.zone_focus ?? null,
    space_zone_count: e.space_zone_count ?? null,
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
    flag_for_retouching: e.flag_for_retouching ?? null,
    key_elements: (e.key_elements ?? []).slice(0, 8),
    zones_visible: (e.zones_visible ?? []).slice(0, 4),
  }));

  const photographerTechniquesSection = opts.photographerTechniquesBlockText
    ? [opts.photographerTechniquesBlockText, '']
    : [];

  // W11.6.14: per-image EXIF metadata table BEFORE the Stage 1 enrichment
  // JSON. Gives Gemini focal/aperture/shutter/iso/bracket/risks for every
  // image so cross-image slot decisions can reason about perspective +
  // depth-of-field + exposure intent. Optional for back-compat.
  const exifTableSection = opts.exifContextTableText && opts.exifContextTableText.length > 0
    ? [opts.exifContextTableText, '']
    : [];

  return [
    opts.sourceContextBlockText,
    '',
    ...photographerTechniquesSection,
    opts.voiceBlockText,
    '',
    '── PROPERTY FACTS (authoritative; do NOT invent) ──',
    factLines.join('\n'),
    '',
    ...exifTableSection,
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
    opts.imageStemsInOrder.join(', '),
    '',
    opts.selfCritiqueBlockText,
    '',
    '── REQUIRED OUTPUT ──',
    'Return one JSON object exactly matching the schema. All required fields',
    'must be present. Use empty array [] for collections with no entries (do',
    'not omit). Use empty string "" for closing_paragraph when not warranted.',
  ].join('\n');
}

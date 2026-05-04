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
//
// Mig 444 (engine rewrite, 2026-05-02) — bumped to v1.3:
//   - Added top-level `position_decisions[]` for the new constraint-based
//     gallery_positions model (one row per resolved position, not per slot).
//   - Added top-level `proposed_position_templates[]` so Gemini can suggest
//     recurring constraint patterns that should become saved templates.
//   - Legacy `slot_decisions[]` retained for ONE deploy cycle (dual emission
//     window). Audit + swimlane queries continue to consume slot_decisions
//     until R3 validation lands; the follow-up will drop slot_decisions and
//     keep position_decisions only.
//
// Mig 451 (taxonomy decompose, 2026-05-02) — bumped to v1.4:
//   - position_constraints + constraint_pattern: DROPPED room_type and
//     composition_type (no longer columns on gallery_positions).
//   - position_constraints + constraint_pattern: ADDED vantage_position
//     and composition_geometry (the new decomposed axes).
//   - Constraint axis surface now mirrors the gallery_positions schema 1:1.
//
// W11.8 (mig 453+454, 2026-05-02) — bumped to v1.5:
//   - position_decisions[]: ADDED `space_instance_id` (string, nullable) so
//     each decision records which physical-room instance was selected.
//   - User prompt: NEW round-level summary block listing the
//     shortlisting_space_instances rows and which composition_groups belong
//     to each instance. Stage 4 reads this BEFORE position selection so it
//     can prefer DIFFERENT instances when multiple positions share a
//     constraint tuple, and respect instance_unique_constraint=true.
//   - Stage 1 entry shape: ADDED space_instance_id (per-group instance id
//     populated by detect_instances). The model uses this to group its
//     candidates per position.
//
// Mig 465 (editorial engine, 2026-05-04) — bumped to v1.6:
//   - NEW top-level `editorial_picks[]` array. Replaces the static slot
//     lattice with package-quota-driven editorial selection. Each pick
//     carries a quota_bucket (sales_images / dusk_images / aerial_images),
//     a free-form role_label invented by the model, a rationale, and an
//     editorial_score (the model's confidence in its own pick).
//   - NEW top-level `editorial_coverage_warnings[]` so the model can
//     self-flag rooms a typical AU listing would expect but the round
//     doesn't have a viable candidate for. Surfaced to operators as
//     warning chips in the swimlane.
//   - User prompt: NEW EDITORIAL DIRECTIVE block injected when the round's
//     package has classifiable products. Carries the per-bucket quota
//     resolved from packages.products[].quantity + the global editorial
//     policy text (shortlisting_engine_policy.policy.editorial_principles
//     and tie_breaks).
//   - slot_decisions[] + position_decisions[] are STILL emitted in the
//     same response — kept for back-compat through the migration window.
//     The persistence layer prefers editorial_picks when present.
export const STAGE4_PROMPT_VERSION = 'v1.6';
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
  // Mig 451 (2026-05-02): new orthogonal axes that decompose composition_type.
  // composition_type stays as a backwards-compat alias.
  vantage_position?: string | null;
  composition_geometry?: string | null;
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
  // W11.8 — per-group physical-room instance id (UUID) populated by
  // detect_instances. NULL when the round has not had detect_instances run
  // yet (legacy rounds, partial replays).
  space_instance_id?: string | null;
}

/**
 * W11.8 — round-level instance summary entry. One per detected instance.
 * Injected into the Stage 4 user prompt before the gallery_positions block so
 * the model can reason about which instances exist before assigning images
 * to positions.
 */
export interface SpaceInstanceSummary {
  id: string;
  space_type: string;
  instance_index: number;
  display_label: string;
  member_group_count: number;
  cluster_confidence: number;
  distinctive_features: string[];
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

    // ─── Position decisions (mig 444 — constraint-based engine) ──────────
    // Mig 444: the new primary output. Each entry corresponds to one resolved
    // gallery_position (constraint tuple) injected into the user prompt. The
    // model picks the strongest image whose Stage 1 attributes satisfy the
    // position's constraints (NULL constraint axis = "any value acceptable")
    // and emits a winner + alternatives + rationale tied to the constraint
    // match.
    //
    // No closed enum on `phase` — state-count discipline (description-only).
    // The persistence layer will reject any phase value not in
    // {mandatory, conditional, optional} with a warning.
    position_decisions: {
      type: 'array',
      description:
        'One entry per resolved gallery_position. Fill in the order the ' +
        'positions appear in the prompt. For each position: pick the image ' +
        'that best satisfies the position\'s constraint tuple (NULL axes are ' +
        'wildcards — any value matches). Phase semantics: mandatory MUST be ' +
        'filled when at least one image satisfies the constraints; ' +
        'conditional is filled only when an image clearly satisfies them; ' +
        'optional is filled only when there is a strong, clear match. When ' +
        'phase=mandatory and no image satisfies AND ai_backfill_on_gap=true, ' +
        'pick the closest image and explain the gap in the rationale; when ' +
        'ai_backfill_on_gap=false, OMIT the entry entirely so the operator ' +
        'sees a coverage gap event instead of a forced backfill.',
      items: {
        type: 'object',
        properties: {
          position_index: {
            type: 'integer',
            description:
              'The integer shown in square brackets at the start of each ' +
              'line in the GALLERY POSITIONS prompt block (e.g. for line ' +
              '`[3] mandatory :: …`, emit position_index=3). Echo the value ' +
              'verbatim — do NOT renumber to 0-based. The persistence layer ' +
              'keys decisions to positions by this exact integer.',
          },
          phase: {
            type: 'string',
            description:
              'Echo the position\'s phase: one of "mandatory", "conditional", "optional".',
          },
          position_constraints: {
            type: 'object',
            description:
              'Echo the position\'s constraint tuple back so we can confirm ' +
              'the model parsed the position correctly. Mirrors the prompt input. ' +
              'Mig 451: room_type + composition_type axes were retired; ' +
              'vantage_position + composition_geometry axes were added.',
            properties: {
              space_type: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              zone_focus: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              shot_scale: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              perspective_compression: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              vantage_position: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              composition_geometry: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              lens_class: { type: 'string', nullable: true, description: 'NULL = wildcard' },
              image_type: { type: 'string', nullable: true, description: 'NULL = wildcard' },
            },
          },
          winner: {
            type: 'object',
            properties: {
              stem: { type: 'string' },
              rationale: {
                type: 'string',
                description:
                  '2-4 sentences citing (a) which constraint axes the winner ' +
                  'satisfies vs leaves wildcard, AND (b) the visual evidence ' +
                  'beating the alternatives. Refer to other stems by name.',
              },
              constraint_match_score: {
                type: 'number',
                description:
                  '0-10 — how well the winner satisfies the position\'s ' +
                  'constraint tuple. 10 = every non-null axis matches; 5 = ' +
                  'about half of the non-null axes match; 0 = no axes match ' +
                  '(only used in ai_backfill scenarios).',
              },
              slot_fit_score: {
                type: 'number',
                description:
                  'W11.6.15 — 0-10 — how strongly this image fits the ' +
                  'position\'s compositional intent independent of per-image ' +
                  'quality. Preserved from the legacy slot model so dual-emit ' +
                  'parity stays intact during the cutover window.',
              },
              space_instance_id: {
                type: 'string',
                nullable: true,
                description:
                  'W11.8 — UUID of the shortlisting_space_instances row this ' +
                  'winner belongs to. Echo the value from the candidate ' +
                  'group\'s space_instance_id in the Stage 1 enrichment JSON. ' +
                  'NULL when the round has no instance clustering data (legacy ' +
                  'rounds) OR when the candidate group\'s space_type is in the ' +
                  'no-disambiguation list (exterior_facade, floorplan, etc.).',
              },
            },
            required: ['stem', 'rationale', 'constraint_match_score', 'slot_fit_score'],
          },
          alternatives: {
            type: 'array',
            description: 'Up to 2 backup picks with constraint_match_score each.',
            items: {
              type: 'object',
              properties: {
                stem: { type: 'string' },
                rationale: { type: 'string' },
                constraint_match_score: { type: 'number' },
              },
              required: ['stem', 'rationale', 'constraint_match_score'],
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
        required: ['position_index', 'phase', 'winner'],
      },
    },

    // ─── Proposed position templates (mig 444) ──────────────────────────
    // proposed_position_templates[]: REMOVED in mig 465 to free state-count
    // budget for editorial_picks[].  The auto-promotion surface was a niche
    // discovery feature; it can come back as a separate, smaller schema
    // call once we drop the legacy slot_decisions[] in the post-cutover
    // follow-up.  Persistence layer tolerates its absence (the helper
    // returns 0 when the array is missing).

    // ─── Editorial picks (mig 465 — package-quota-driven engine) ─────────
    // Schema is INTENTIONALLY MINIMAL — Gemini's response-schema state-count
    // limit forces us to keep this lean. role_label is free-form text (no
    // enum) so the model is the authority on naming. Coverage warnings ride
    // in `coverage_notes` (existing string field) rather than a structured
    // array, again to stay under the state-count budget.
    editorial_picks: {
      type: 'array',
      description:
        'Editorial shortlist keyed to package quota buckets. Fill EXACTLY ' +
        'the per-bucket counts in the EDITORIAL DIRECTIVE. quota_bucket ' +
        'must be one of: "sales_images", "dusk_images", "aerial_images" ' +
        '(matching the directive). role_label is free-form snake_case ' +
        'invented by you — be specific (e.g. "kitchen_hero", ' +
        '"exterior_dusk_facade", "master_bedroom_wide"). When the round ' +
        'lacks viable candidates for a quota, come in UNDER and write a ' +
        'sentence in `coverage_notes` explaining why — do NOT pad with ' +
        'weak picks. Use the directive\'s editorial principles + ' +
        'tie-breaks when ranking candidates.',
      items: {
        type: 'object',
        properties: {
          quota_bucket: { type: 'string' },
          stem: { type: 'string' },
          role_label: { type: 'string' },
          rationale: { type: 'string' },
          editorial_score: { type: 'number' },
        },
        required: ['quota_bucket', 'stem', 'role_label', 'rationale', 'editorial_score'],
      },
    },

    // ─── Slot decisions (LEGACY — dual emission for one cycle) ───────────
    // QC-iter2-W3 F-D-006: previous examples (`master_bedroom`,
    // `alfresco/outdoor_hero`) were NOT in the canonical slot_id enum. The
    // model parroted these and then tripped Gemini's enum constraint or
    // collapsed onto bad aliases. Use canonical Phase-1 ids only.
    //
    // Mig 444: position_decisions[] is the new primary surface. slot_decisions
    // is RETAINED for one deploy cycle so the swimlane + audit queries don't
    // break during R3 validation. The follow-up will drop slot_decisions
    // entirely once position_decisions has been verified end-to-end.
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
            // W11.7.x: closed `enum` (60 CANONICAL_SLOT_IDS) caused Gemini to
            // 400 Stage 4 with "schema produces a constraint that has too
            // many states for serving" — the cumulative state count of
            // Stage 4's much-larger schema (master_listing's 17 string
            // fields, slot_decisions array with nested objects, etc.) put
            // it over Gemini's serving threshold even though Stage 1 with
            // the same enum still fits. Drop the closed enum and teach the
            // canonical list via description; normaliseSlotId() in the
            // persistence layer already collapses drift / aliases and drops
            // unrecognised ids with a warning, so the structural guarantee
            // is preserved at write-time even when the schema-time guard
            // is loosened. Same pattern landed earlier for
            // photographer_techniques on the Stage 1 side.
            description:
              'Slot identifier (canonical lowercase snake_case). Use ONE OF ' +
              `the following ${CANONICAL_SLOT_IDS.length} canonical slot_ids ` +
              '— anything else will be dropped with a warning at persist ' +
              `time: ${CANONICAL_SLOT_IDS.join(', ')}. Use \`ai_recommended\` ` +
              'for Phase 3 free recommendations not tied to a specific slot.',
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
    // Mig 444: position_decisions is the new primary surface but is required
    // ONLY when the round resolved to non-zero gallery_positions. Keep it
    // OPTIONAL at the schema level so legacy rounds + rounds with no resolved
    // positions still pass. The persistence layer reads `position_decisions`
    // when present and falls back to slot_decisions otherwise.
    // 'position_decisions',  -- intentionally not required (see comment)
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
    '  1. Mig 465: When the user prompt carries an EDITORIAL DIRECTIVE block,',
    '     populate `editorial_picks[]` with EXACTLY the per-bucket counts the',
    '     directive requests (e.g. 25 sales_images + 4 dusk_images). Each pick',
    '     names a quota_bucket, the chosen stem, a free-form role_label (you',
    '     invent the label — be precise), a rationale, an editorial_score, and',
    '     optional principles_applied. Self-flag shortfalls via',
    '     `editorial_coverage_warnings[]` rather than padding with weak picks.',
    '  2. Mig 444 (legacy): Fill the round\'s GALLERY POSITIONS — each position',
    '     is a constraint tuple (partial, NULL = wildcard). Match images to',
    '     positions by satisfying as many constraint axes as possible. Phase',
    '     governs how hard you try (mandatory/conditional/optional). Emit one',
    '     entry per position into `position_decisions[]`. KEPT FOR BACK-COMPAT',
    '     during the editorial-engine cutover.',
    '  3. Also emit the legacy `slot_decisions[]` array for one deploy cycle —',
    '     keep the slot_id-based output flowing while operators validate the',
    '     editorial-engine output.',
    "  4. Draft a complete publication-ready master listing in the property's",
    '     tier voice.',
    '  5. Sequence the marketing gallery (ordered stems, narrative arc).',
    '  6. Group near-duplicates so production knows where to cull.',
    "  7. Call out missing shots the photographer didn't capture.",
    '  8. Where your visual cross-comparison shows Stage 1 was wrong on any',
    '     per-image field, emit a stage_4_overrides[] row rather than silently',
    '     changing the answer. The override entries are first-class training',
    '     data for the engine and operator review surface.',
    '',
    'POSITION-MATCHING DISCIPLINE (mig 444)',
    '- A position with constraint X=null means "X is wildcard, any value is',
    '  acceptable". Do not penalise images for the wildcard axis.',
    '- A position with constraint X=value means "winner SHOULD have X=value".',
    '  When no image satisfies, lower the constraint_match_score honestly —',
    '  do NOT fabricate a match. The score tells the operator how loose the',
    '  fill was.',
    '',
    'INSTANCE-CYCLING DISCIPLINE (W11.8 — mig 453+454)',
    '- The SPACE INSTANCES block (when present) lists which physically-',
    '  distinct rooms exist per space_type. Each Stage 1 entry carries a',
    '  space_instance_id pointing at one of those instances.',
    '- When multiple positions share the same constraint tuple (e.g. two',
    '  bedroom positions, two living-room positions), prefer DIFFERENT',
    '  space_instance_ids before duplicating from the same instance. The',
    '  goal: a gallery that shows ALL the rooms, not 3 angles of the same',
    '  one.',
    '- Echo the chosen image\'s space_instance_id into the winner.space_',
    '  instance_id field. NULL is fine when the candidate has no instance.',
    '- A position rendered with `uniq` flag (instance_unique_constraint=true)',
    '  must have a winner from an instance not used by any other position',
    '  with the same constraint tuple. If the round has fewer instances than',
    '  positions, leave the surplus positions empty (or ai_backfill if the',
    '  position allows).',
    '- Phase = mandatory: fill if ANY image plausibly satisfies the tuple,',
    '  even at constraint_match_score 4-5. The position is required for the',
    '  package; only omit when the round genuinely has zero candidates AND',
    '  ai_backfill_on_gap=false.',
    '- Phase = conditional: fill ONLY when an image clearly satisfies the',
    '  constraints (constraint_match_score >= 6). When no image does, OMIT',
    '  the position decision.',
    '- Phase = optional: fill ONLY when there is a strong, clear match',
    '  (constraint_match_score >= 7). Otherwise omit.',
    '',
    'DISCIPLINE',
    "- Never invent factual figures. If a number isn't in property_facts, omit",
    '  it from listing copy.',
    '- Never describe what is not in the frame. If a feature is implied but',
    '  unseen, say "implied" or omit.',
    '- Voice anchor rubric is law — if it says "no exclamation marks" or "no',
    '  stunning", do not slip those in.',
    '- Apply the Sydney typology primer when naming style_archetype + period.',
    "- Legacy slot_decisions[]: also emit the existing slot-by-slot picks for",
    "  the round's slot lattice, same as before mig 444. The persistence layer",
    "  treats slot_decisions and position_decisions as parallel surfaces during",
    "  the cutover window — both must be present.",
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
  /**
   * Mig 444: pre-rendered gallery_positions block (output of
   * renderGalleryPositionsBlock). Empty string when the round resolved to
   * zero positions; in that case Stage 4 falls back to the legacy slot
   * lattice and emits no position_decisions[]. Production callers always
   * compute this even when empty so the prompt structure is consistent.
   */
  galleryPositionsBlockText?: string;
  voiceBlockText: string;
  selfCritiqueBlockText: string;
  propertyFacts: PropertyFacts;
  stage1Merged: Stage1MergedEntry[];
  imageStemsInOrder: string[];
  totalImages: number;
  /**
   * W11.8 — round-level shortlisting_space_instances summary. Empty array when
   * detect_instances has not run for this round (legacy rounds), in which
   * case the instance-aware sections of the prompt are omitted (the model
   * will simply not emit space_instance_id values).
   */
  spaceInstances?: SpaceInstanceSummary[];
  /**
   * Mig 465 — pre-rendered EDITORIAL DIRECTIVE block.  Empty string when
   * the round's package has no shortlistable products (e.g. a drone-only
   * package), in which case Stage 4 falls back to the legacy slot lattice
   * exclusively.  Production callers always pass this even when empty so
   * the prompt structure is consistent.
   */
  editorialDirectiveBlockText?: string;
}

/**
 * Mig 465 — render the EDITORIAL DIRECTIVE block injected into the Stage 4
 * user prompt.  Combines per-bucket quotas (resolved from packages.products)
 * with the global editorial policy (from shortlisting_engine_policy) into
 * a single self-contained section the model treats as its primary
 * shortlist directive.
 */
export interface EditorialDirectiveOpts {
  /** Per-bucket quota counts to deliver, e.g. { sales_images: 25, dusk_images: 4 }. */
  quotas: Record<string, number>;
  /** Pre-rendered quota line for the prompt header (e.g. "25 sales_images + 4 dusk_images"). */
  quotaLine: string;
  /** Free-form editorial principles markdown (from policy.editorial_principles). */
  editorialPrinciples: string;
  /** Free-form tie-break rules markdown (from policy.tie_breaks). */
  tieBreaks: string;
  /** Quality floor (0-10) — picks with editorial_score below this are surfaced as warnings. */
  qualityFloor: number;
  /** Common AU residential rooms (from policy.common_residential_rooms). */
  commonResidentialRooms: string[];
  /** Preferred dusk subject types (from policy.dusk_subjects). */
  duskSubjects: string[];
  /** Source of the quotas — useful context for the model when the package
   *  was unrecognised and we fell back to the ceiling. */
  quotaSource: 'package_products' | 'fallback_ceiling';
  /** Non-shortlisting deliverables on the package (drone, floorplan, video).
   *  Surfaced as context only — the engine does NOT fill these. */
  nonShortlistingProducts?: Array<{ product_name: string; quantity: number }>;
  /** Unrecognised products on the package (typo / new product type that
   *  PRODUCT_TO_BUCKET doesn't know about yet).  Surfaced for ops awareness. */
  unknownProducts?: Array<{ product_name: string; quantity: number }>;
}

export function renderEditorialDirective(opts: EditorialDirectiveOpts): string {
  const lines: string[] = [];
  lines.push('── EDITORIAL DIRECTIVE (mig 465 — package-driven) ──');
  lines.push('');
  lines.push(
    `THIS ROUND\'S DELIVERABLE QUOTA (from the project\'s package): ${opts.quotaLine}.`,
  );
  if (opts.quotaSource === 'fallback_ceiling') {
    lines.push(
      '  (NOTE: package products were unrecognised — quota fell back to the round ceiling.)',
    );
  }
  if (opts.nonShortlistingProducts && opts.nonShortlistingProducts.length > 0) {
    const nonShorts = opts.nonShortlistingProducts
      .map((p) => `${p.quantity} ${p.product_name}`)
      .join(', ');
    lines.push(
      `  Non-shortlisting deliverables on this package (handled by other ` +
        `pipelines, do NOT include in editorial_picks): ${nonShorts}.`,
    );
  }
  if (opts.unknownProducts && opts.unknownProducts.length > 0) {
    const unk = opts.unknownProducts
      .map((p) => `${p.quantity} ${p.product_name}`)
      .join(', ');
    lines.push(
      `  Unrecognised products on this package (skipped): ${unk}. ` +
        `Treat as a config gap, not a shortlist instruction.`,
    );
  }
  lines.push('');
  lines.push('YOUR TASK');
  lines.push(
    '  Populate `editorial_picks[]` with EXACTLY the per-bucket counts above. ' +
      'Each pick assigns one composition_group from the candidate pool below ' +
      'to a quota bucket, with a free-form role_label, a rationale, and a ' +
      'self-reported editorial_score (0-10). When you cannot fill a quota, ' +
      'come in UNDER and write a sentence in `coverage_notes` (existing ' +
      'string field at the top level of your response) explaining the ' +
      'shortfall — do NOT pad with weak picks. The slot_decisions[] and ' +
      'position_decisions[] arrays are LEGACY surfaces for back-compat; fill ' +
      'them per their existing instructions, but `editorial_picks[]` is the ' +
      'primary output.',
  );
  lines.push('');
  lines.push('EDITORIAL PRINCIPLES (from FlexStudios global policy)');
  lines.push(opts.editorialPrinciples);
  lines.push('');
  lines.push('TIE-BREAK RULES');
  lines.push(opts.tieBreaks);
  lines.push('');
  lines.push(
    `QUALITY FLOOR — editorial_score < ${opts.qualityFloor.toFixed(1)} ` +
      'should never appear in editorial_picks unless the round genuinely has ' +
      'no better candidate AND the quota mandates a fill (mandatory hero ' +
      'rooms only). When forced to dip below the floor, also emit a ' +
      '`weak_candidate_pool` coverage warning.',
  );
  lines.push('');
  if (opts.commonResidentialRooms.length > 0) {
    lines.push(
      'COMMON AU RESIDENTIAL ROOMS — typical buyer expectation. If a candidate ' +
        'exists for any of these and you OMIT it from editorial_picks, emit a ' +
        '`common_room_omitted` warning explaining why:',
    );
    lines.push(`  ${opts.commonResidentialRooms.join(', ')}`);
    lines.push('');
  }
  if (opts.duskSubjects.length > 0) {
    lines.push(
      'DUSK SUBJECT GUIDANCE — when filling the dusk_images bucket, prefer ' +
        'images whose subject is in this set. Dusk interiors require explicit ' +
        'editorial justification:',
    );
    lines.push(`  ${opts.duskSubjects.join(', ')}`);
    lines.push('');
  }
  lines.push(
    'OUTPUT FIELDS (recap): editorial_picks[].quota_bucket, .stem, ' +
      '.role_label, .rationale, .editorial_score. Self-reported shortfalls ' +
      'go in `coverage_notes` (top-level string field).',
  );
  return lines.join('\n');
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
  // W11.8 — surface space_instance_id so the model can group candidates per
  // position by instance and prefer cycling across instances when multiple
  // positions share a constraint tuple.
  const compactStage1 = opts.stage1Merged.map((e) => ({
    stem: e.stem,
    room_type: e.room_type ?? null,
    space_type: e.space_type ?? null,
    zone_focus: e.zone_focus ?? null,
    space_zone_count: e.space_zone_count ?? null,
    composition_type: e.composition_type ?? null,
    // Mig 451 (2026-05-02): orthogonal axes that decompose composition_type.
    vantage_position: e.vantage_position ?? null,
    composition_geometry: e.composition_geometry ?? null,
    vantage: e.vantage_point ?? null,
    space_instance_id: e.space_instance_id ?? null,
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

  // Mig 444: gallery_positions block (constraint tuples). Sits BEFORE the
  // legacy slotEnumerationBlock so the model reads positions as the primary
  // task surface. When empty (round has zero resolved positions), the slot
  // lattice + legacy slot_decisions[] is the only output path.
  const positionsSection = opts.galleryPositionsBlockText && opts.galleryPositionsBlockText.length > 0
    ? [opts.galleryPositionsBlockText, '']
    : [];

  // W11.8: round-level space_instances summary. Sits BEFORE positions so the
  // model reads the instance lattice (which physical rooms exist per
  // space_type) before assigning images to positions.
  const instanceSection = (opts.spaceInstances && opts.spaceInstances.length > 0)
    ? [renderSpaceInstancesBlock(opts.spaceInstances), '']
    : [];

  // Mig 465: EDITORIAL DIRECTIVE — sits AT THE TOP of the prompt body so the
  // model treats it as the primary task framing.  Empty string when the
  // round's package has no shortlistable products (drone-only, floorplan-
  // only, etc.) — in that case Stage 4 falls back to slot_decisions /
  // position_decisions exclusively and editorial_picks[] is left empty.
  const editorialSection = opts.editorialDirectiveBlockText && opts.editorialDirectiveBlockText.length > 0
    ? [opts.editorialDirectiveBlockText, '']
    : [];

  return [
    opts.sourceContextBlockText,
    '',
    ...editorialSection,
    ...photographerTechniquesSection,
    opts.voiceBlockText,
    '',
    '── PROPERTY FACTS (authoritative; do NOT invent) ──',
    factLines.join('\n'),
    '',
    ...instanceSection,
    ...positionsSection,
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
    'Mig 444: emit BOTH `position_decisions[]` (one per resolved gallery_position',
    'above; omitted only when the round resolved to zero positions) AND the',
    'legacy `slot_decisions[]`. The dual emission is intentional — the engine',
    'is in a one-cycle cutover window.',
    'W11.8: when a candidate group has a non-null space_instance_id in the',
    'Stage 1 enrichment JSON, ECHO that id into the position_decisions[].winner',
    '.space_instance_id field. NULL is acceptable for groups whose space_type',
    'does not require disambiguation (exterior_facade, floorplan, etc.) or for',
    'legacy rounds with no instance clustering data.',
  ].join('\n');
}

/**
 * W11.8 — render the round-level space_instances summary as a numbered list
 * grouped by space_type. Stage 4 reads this BEFORE position assignment so it
 * can prefer cycling across instances when multiple positions share a
 * constraint tuple, and respect instance_unique_constraint=true.
 */
export function renderSpaceInstancesBlock(
  instances: SpaceInstanceSummary[],
): string {
  if (instances.length === 0) return '';
  const bySpaceType = new Map<string, SpaceInstanceSummary[]>();
  for (const i of instances) {
    const arr = bySpaceType.get(i.space_type) ?? [];
    arr.push(i);
    bySpaceType.set(i.space_type, arr);
  }
  const lines: string[] = [];
  lines.push('── SPACE INSTANCES (W11.8 — physically-distinct rooms in the round) ──');
  lines.push('Each space_type may have one OR MORE detected instances. Two kitchens');
  lines.push('in a duplex → 2 instances; one master bedroom → 1 instance. The');
  lines.push('space_instance_id values appear in the Stage 1 enrichment JSON below.');
  lines.push('');
  lines.push('POSITION-FILLING DISCIPLINE — INSTANCE CYCLING');
  lines.push('1. List candidate composition_groups per position from the prompt.');
  lines.push('2. Group them by space_instance_id (using the Stage 1 enrichment).');
  lines.push('3. Fill positions in instance-cycling order: when multiple positions');
  lines.push('   share the same constraint tuple (same room, same shot_scale, etc.),');
  lines.push('   prefer DIFFERENT space_instance_ids before duplicating from the');
  lines.push('   same instance.');
  lines.push('4. If a position has instance_unique_constraint=true (rendered above');
  lines.push('   as a uniq flag): the winner MUST come from an instance not used by');
  lines.push('   any other position with the same constraint tuple in the recipe.');
  lines.push('   If no available instance, leave the position empty (unless');
  lines.push('   ai_backfill_on_gap=true).');
  lines.push('');
  for (const [spaceType, group] of bySpaceType.entries()) {
    group.sort((a, b) => a.instance_index - b.instance_index);
    lines.push(`── ${spaceType} (${group.length} instance${group.length === 1 ? '' : 's'}) ──`);
    for (const inst of group) {
      const features = inst.distinctive_features.length > 0
        ? ` features=[${inst.distinctive_features.join(' | ')}]`
        : '';
      const conf = `conf=${inst.cluster_confidence.toFixed(2)}`;
      lines.push(
        `  [${inst.instance_index}] id=${inst.id} label="${inst.display_label}" ` +
        `members=${inst.member_group_count} ${conf}${features}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

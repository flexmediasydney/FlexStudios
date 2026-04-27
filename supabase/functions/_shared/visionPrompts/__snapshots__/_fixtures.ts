/**
 * Frozen test fixtures for the W7.6 prompt-block snapshot regression gate.
 *
 * These fixtures are intentionally stable: snapshot tests assert that the
 * modular `assemble()`-based prompt builder produces output byte-identical to
 * the pre-refactor monolith. Changing these fixtures would invalidate the
 * snapshots — do not edit unless you are intentionally regenerating the
 * regression baseline.
 */

import type { StreamBAnchors } from '../../streamBInjector.ts';
import type {
  Pass2ClassificationRow,
  Pass2PromptOptions,
  Pass2SlotDefinition,
} from '../../pass2Prompt.ts';

/** Fixed Stream B anchors (spec-defaults wording, version stamped). */
export const FIXTURE_ANCHORS: StreamBAnchors = {
  tierS:
    'TIER S — STANDARD REAL ESTATE (Score: 5 on our scale)\n' +
    'Mandatory: vertical lines straight, windows show recoverable exterior detail, ' +
    'no visible clutter, camera at correct height (counter-top for kitchen, ' +
    'chest height for bedrooms), coverage complete.\n' +
    'A score of 5 means: competent, professional, acceptable for REA/Domain.',
  tierP:
    'TIER P — PREMIUM PRESTIGE (Score: 8 on our scale)\n' +
    'Mandatory (in addition to Tier S): minimum 3 depth layers, foreground anchoring ' +
    'element required, indoor-outdoor connection visible where applicable, material ' +
    'texture visible (stone veining, timber grain, tile grout), HDR blend invisible, ' +
    'set-level colour grade consistent.\n' +
    'A score of 8 means: would appear in premium agent brochure for $2M+ property.',
  tierA:
    'TIER A — ARCHITECTURAL EDITORIAL (Score: 9.5+ on our scale)\n' +
    'The picture tells the story of the building. Materials are the subject. ' +
    'Light reveals architecture. Human/lifestyle elements add narrative. ' +
    'Coverage is tertiary — one extraordinary image outscores five adequate ones.\n' +
    'A score of 9.5 means: publication-grade, Architectural Digest / dezeen standard.',
  version: 1,
};

/** Fixed slot definition list — 8 representative slots across phases 1 & 2. */
export const FIXTURE_SLOT_DEFINITIONS: Pass2SlotDefinition[] = [
  {
    slot_id: 'hero',
    display_name: 'Hero Image',
    phase: 1,
    eligible_room_types: ['exterior_front', 'interior_open_plan'],
    max_images: 1,
    min_images: 1,
    notes: 'Lead image of the listing',
  },
  {
    slot_id: 'kitchen_main',
    display_name: 'Kitchen',
    phase: 1,
    eligible_room_types: ['kitchen_main'],
    max_images: 1,
    min_images: 1,
    notes: null,
  },
  {
    slot_id: 'master_bedroom_hero',
    display_name: 'Master Bedroom',
    phase: 1,
    eligible_room_types: ['master_bedroom'],
    max_images: 1,
    min_images: 1,
    notes: null,
  },
  {
    slot_id: 'exterior_front',
    display_name: 'Exterior Front',
    phase: 1,
    eligible_room_types: ['exterior_front'],
    max_images: 1,
    min_images: 1,
    notes: null,
  },
  {
    slot_id: 'living_room',
    display_name: 'Living Room',
    phase: 2,
    eligible_room_types: ['living_room', 'living_secondary'],
    max_images: 2,
    min_images: 0,
    notes: 'Up to two living spaces',
  },
  {
    slot_id: 'ensuite_hero',
    display_name: 'Ensuite Hero',
    phase: 2,
    eligible_room_types: ['ensuite_primary'],
    max_images: 2,
    min_images: 0,
    notes: 'shower-side + vanity-side allowed',
  },
  {
    slot_id: 'bathroom_main',
    display_name: 'Main Bathroom',
    phase: 2,
    eligible_room_types: ['bathroom'],
    max_images: 1,
    min_images: 0,
    notes: null,
  },
  {
    slot_id: 'alfresco_hero',
    display_name: 'Alfresco',
    phase: 2,
    eligible_room_types: ['alfresco'],
    max_images: 1,
    min_images: 0,
    notes: null,
  },
];

/** Fixed Pass 1 classifications — 5 representative rows. */
export const FIXTURE_CLASSIFICATIONS: Pass2ClassificationRow[] = [
  {
    stem: 'shoot_001_001',
    group_id: 'g-1',
    group_index: 1,
    room_type: 'exterior_front',
    composition_type: 'hero_wide',
    vantage_point: 'exterior_looking_in',
    technical_score: 9,
    lighting_score: 8.5,
    composition_score: 9,
    aesthetic_score: 9.2,
    combined_score: 8.9,
    is_styled: true,
    indoor_outdoor_visible: false,
    is_drone: false,
    is_exterior: true,
    eligible_for_exterior_rear: false,
    clutter_severity: 'none',
    flag_for_retouching: false,
    analysis:
      'Wide hero of the front facade, golden-hour light, three depth layers visible.',
  },
  {
    stem: 'shoot_001_002',
    group_id: 'g-2',
    group_index: 2,
    room_type: 'kitchen_main',
    composition_type: 'corner_two_point',
    vantage_point: 'neutral',
    technical_score: 8.5,
    lighting_score: 8,
    composition_score: 8,
    aesthetic_score: 7.5,
    combined_score: 8.0,
    is_styled: true,
    indoor_outdoor_visible: true,
    is_drone: false,
    is_exterior: false,
    eligible_for_exterior_rear: false,
    clutter_severity: 'minor_photoshoppable',
    flag_for_retouching: true,
    analysis:
      'Kitchen corner two-point — single visible cord by the toaster requires retouching.',
  },
  {
    stem: 'shoot_001_003',
    group_id: 'g-3',
    group_index: 3,
    room_type: 'alfresco',
    composition_type: 'hero_wide',
    vantage_point: 'exterior_looking_in',
    technical_score: 8,
    lighting_score: 7.5,
    composition_score: 8,
    aesthetic_score: 8.2,
    combined_score: 7.9,
    is_styled: false,
    indoor_outdoor_visible: true,
    is_drone: false,
    is_exterior: true,
    eligible_for_exterior_rear: true,
    clutter_severity: 'none',
    flag_for_retouching: false,
    analysis:
      'Alfresco from garden looking back toward pavilion — eligible for exterior_rear.',
  },
  {
    stem: 'shoot_001_004',
    group_id: 'g-4',
    group_index: 4,
    room_type: 'master_bedroom',
    composition_type: 'corner_two_point',
    vantage_point: 'neutral',
    technical_score: 7.5,
    lighting_score: 7,
    composition_score: 7.5,
    aesthetic_score: 7.8,
    combined_score: 7.5,
    is_styled: true,
    indoor_outdoor_visible: false,
    is_drone: false,
    is_exterior: false,
    eligible_for_exterior_rear: false,
    clutter_severity: 'none',
    flag_for_retouching: false,
    analysis: 'Master bedroom corner shot, styled bed, balanced light.',
  },
  {
    stem: 'shoot_001_005',
    group_id: 'g-5',
    group_index: 5,
    room_type: 'drone_oblique',
    composition_type: 'drone_oblique_contextual',
    vantage_point: 'neutral',
    technical_score: 8,
    lighting_score: 8,
    composition_score: 7,
    aesthetic_score: 7,
    combined_score: 7.5,
    is_styled: false,
    indoor_outdoor_visible: false,
    is_drone: true,
    is_exterior: true,
    eligible_for_exterior_rear: false,
    clutter_severity: 'none',
    flag_for_retouching: false,
    analysis: 'Aerial oblique showing contextual neighbourhood.',
  },
];

/** Fixed Pass 2 builder options. */
export const FIXTURE_PASS2_OPTS: Pass2PromptOptions = {
  propertyAddress: '12 Sample Street, Mosman NSW 2088',
  packageType: 'Premium Package',
  packageDisplayName: 'Premium Package',
  packageCeiling: 38,
  pricingTier: 'premium',
  engineRoles: ['photo_day_shortlist', 'photo_dusk_shortlist'],
  slotDefinitions: FIXTURE_SLOT_DEFINITIONS,
  streamBAnchors: FIXTURE_ANCHORS,
  classifications: FIXTURE_CLASSIFICATIONS,
};

/**
 * spaceZoneTaxonomy.ts — Wave 11.6.13.
 *
 * Two new orthogonal taxonomies that supersede the conflated `room_type`:
 *
 *   SPACE_TAXONOMY      — the architectural enclosure (4 walls)
 *   ZONE_FOCUS_TAXONOMY — the compositional subject of the shot
 *
 * In studios + open-plan apartments ONE space contains MANY zones. The new
 * separation lets the engine reason about both correctly. The block is
 * appended to the Pass 1 system prompt alongside the legacy roomTypeTaxonomy
 * block — Stage 1 emits ALL THREE fields (room_type as compatibility alias,
 * space_type + zone_focus as the new authoritative pair).
 *
 * Spec: Wave 11.6.13 build brief.
 *
 * Versioning: cache-invalidating change to the prompt body bumps the version.
 * Persisted in `composition_classifications.prompt_block_versions`.
 */

export const SPACE_ZONE_TAXONOMY_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface SpaceZoneTaxonomyBlockOpts {
  // empty — no inputs today; future iterations may scope by property type
}

const SPACE_TAXONOMY =
  `master_bedroom | bedroom_secondary | bedroom_third | living_dining_combined | ` +
  `living_room_dedicated | dining_room_dedicated | kitchen_dining_living_combined | ` +
  `kitchen_dedicated | studio_open_plan | bathroom | ensuite | powder_room | ` +
  `entry_foyer | hallway | study | media_room | rumpus | laundry | mudroom | garage | ` +
  `alfresco_undercover | alfresco_open | balcony | terrace | exterior_facade | ` +
  `exterior_rear | exterior_side | pool_area | garden | streetscape | ` +
  `aerial_oblique | aerial_nadir`;

const ZONE_FOCUS_TAXONOMY =
  `bed_focal | wardrobe_built_in | dining_table | kitchen_island | ` +
  `kitchen_appliance_wall | kitchen_pantry | lounge_seating | fireplace_focal | ` +
  `study_desk | tv_media_wall | bath_focal | shower_focal | vanity_detail | ` +
  `toilet_visible | window_view | door_threshold | stair_focal | feature_wall | ` +
  `ceiling_detail | floor_detail | material_proof | landscape_overview | ` +
  `full_facade | pool_focal | outdoor_dining | outdoor_kitchen | bbq_zone | ` +
  `drying_zone | parking_zone`;

export function spaceZoneTaxonomyBlock(_opts?: SpaceZoneTaxonomyBlockOpts): string {
  return [
    'SPACE / ZONE SEPARATION (W11.6.13):',
    '',
    'Two ORTHOGONAL axes you must always emit alongside the legacy room_type:',
    '',
    '  space_type — the ARCHITECTURAL ENCLOSURE (the 4 walls). Pick from:',
    `    ${SPACE_TAXONOMY}.`,
    '',
    '  zone_focus — the COMPOSITIONAL SUBJECT of the shot (what the photographer',
    '    is actually showing). Pick from:',
    `    ${ZONE_FOCUS_TAXONOMY}.`,
    '',
    '  space_zone_count — integer hint:',
    '    1   = single-purpose enclosed room (dedicated bedroom, dedicated bathroom)',
    '    2-4 = multi-zone open plan (living/dining combined = 2; kitchen+dining+living = 3)',
    '    5+  = studio-style (kitchen + bed + lounge + bathroom in one envelope)',
    '',
    'Why both axes? In studios + open-plan apartments ONE space contains MANY',
    'zones. A shot of the dining table inside a combined living/dining envelope',
    'is space_type=living_dining_combined, zone_focus=dining_table — distinct',
    'from a shot of a dedicated dining room (space_type=dining_room_dedicated,',
    'zone_focus=dining_table). The engine uses both to drive slot eligibility',
    'and clean training data.',
    '',
    'Even single-zone shots benefit from emitting zone_focus — e.g. a master',
    'bedroom shot is space_type=master_bedroom, zone_focus=bed_focal vs',
    'wardrobe_built_in vs window_view depending on what the frame is showing.',
  ].join('\n');
}

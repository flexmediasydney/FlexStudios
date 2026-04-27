/**
 * roomTypeTaxonomy.ts — Wave 7 P1-10 (W7.6) block.
 *
 * The 40 canonical room_type values + the spec-L18 living_secondary disambiguation
 * note. Pass 1 must emit exactly one of these strings.
 *
 * Byte-stable lift from `pass1Prompt.ts` ROOM_TYPE_TAXONOMY constant + adjacent
 * "Note on living_secondary" paragraph.
 */

export const ROOM_TYPE_TAXONOMY_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface RoomTypeTaxonomyBlockOpts {
  // empty — taxonomy block has no inputs today
}

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

export function roomTypeTaxonomyBlock(_opts?: RoomTypeTaxonomyBlockOpts): string {
  return [
    'ROOM TYPE TAXONOMY (use exactly these values):',
    ROOM_TYPE_TAXONOMY,
    '',
    'Note on living_secondary (spec L18): Use for upstairs lounges, sitting rooms, rumpus rooms, and secondary living zones on different floors from the main open-plan area. These are NOT near-duplicates of living_room — they are physically distinct rooms that happen to share a function. Misclassifying an upstairs lounge as living_room causes it to be culled as a near-duplicate downstream — use living_secondary instead.',
  ].join('\n');
}

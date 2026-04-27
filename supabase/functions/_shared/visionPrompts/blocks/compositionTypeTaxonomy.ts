/**
 * compositionTypeTaxonomy.ts — Wave 7 P1-10 (W7.6) block.
 *
 * The 11 canonical composition_type values. Pass 1 must emit exactly one of these.
 *
 * Byte-stable lift from `pass1Prompt.ts` COMPOSITION_TYPE_TAXONOMY constant.
 */

export const COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface CompositionTypeTaxonomyBlockOpts {
  // empty — taxonomy block has no inputs today
}

const COMPOSITION_TYPE_TAXONOMY =
  `hero_wide | corner_two_point | detail_closeup | corridor_leading | ` +
  `straight_on | overhead | upward_void | threshold_transition | ` +
  `drone_nadir | drone_oblique_contextual | architectural_abstract`;

export function compositionTypeTaxonomyBlock(
  _opts?: CompositionTypeTaxonomyBlockOpts,
): string {
  return [
    'COMPOSITION TYPE TAXONOMY (use exactly these values):',
    COMPOSITION_TYPE_TAXONOMY,
  ].join('\n');
}

/**
 * bedroomSplit.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Bedroom selection rules (spec §6). master_bedroom_hero picks by HIGHEST
 * COMBINED score; bedroom_secondary picks by HIGHEST AESTHETIC score (NOT
 * combined). Two different selection criteria.
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix BEDROOM SELECTION RULES.
 */

export const BEDROOM_SPLIT_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface BedroomSplitBlockOpts {
  // empty — rule block has no inputs today
}

export function bedroomSplitBlock(_opts?: BedroomSplitBlockOpts): string {
  return [
    'BEDROOM SELECTION RULES:',
    '  master_bedroom_hero: pick the bedroom with the HIGHEST COMBINED score (avg of T+L+C+A).',
    '  bedroom_secondary:   pick by HIGHEST AESTHETIC score — NOT combined, NOT size — aesthetic only.',
    '  All else equal, styled (is_styled=T) beats unstyled (is_styled=F).',
  ].join('\n');
}

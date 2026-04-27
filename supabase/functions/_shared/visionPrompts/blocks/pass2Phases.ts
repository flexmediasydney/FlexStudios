/**
 * pass2Phases.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Three-phase architecture explainer + no-hallucination contract for Pass 2.
 * Phase 1 = mandatory always-fill, Phase 2 = conditional fills, Phase 3 = AI
 * free recommendations bounded by package ceiling.
 *
 * Byte-stable lift from `pass2Prompt.ts` SYSTEM_PROMPT (paragraphs 3 + 4).
 */

export const PASS2_PHASES_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface Pass2PhasesBlockOpts {
  // empty — explainer block has no inputs today
}

export function pass2PhasesBlock(_opts?: Pass2PhasesBlockOpts): string {
  return [
    'Your output is a coverage-checked, three-phase shortlist with top-3 alternatives per slot, near-duplicate culling within room clusters only, and a coverage notes paragraph. The Stream B scoring anchors define the score scale you are interpreting; do not re-score, just use the existing scores to make selection decisions.',
    '',
    'You do not hallucinate slot fills. If no candidate exists for a mandatory slot, you mark it unfilled — never substitute an unrelated image.',
  ].join('\n');
}

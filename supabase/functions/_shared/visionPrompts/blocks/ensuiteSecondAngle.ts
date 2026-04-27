/**
 * ensuiteSecondAngle.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Ensuite primary 2-image rule (spec L19). The ensuite_hero slot may include
 * up to 2 images IF angle delta > 30° (shower-side + vanity-side complementary
 * angles communicating different features of the same room).
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix BATHROOM / ENSUITE RULES.
 */

export const ENSUITE_SECOND_ANGLE_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface EnsuiteSecondAngleBlockOpts {
  // empty — rule block has no inputs today
}

export function ensuiteSecondAngleBlock(
  _opts?: EnsuiteSecondAngleBlockOpts,
): string {
  return [
    'BATHROOM / ENSUITE RULES:',
    '  ensuite_hero may include up to 2 images IF the two compositions show genuinely distinct angles (vantage difference, primary feature difference, or angle delta > 30°). A shower-side angle and a vanity-side angle communicate different features of the same room and are complementary — both count.',
    '  bathroom_main is a separate slot for a bathroom distinct from any ensuite.',
  ].join('\n');
}

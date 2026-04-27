/**
 * nearDuplicateCulling.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Within-room near-duplicate culling rule (spec L7). Two compositions are
 * duplicates ONLY if same room_type AND angle delta < 15° AND key element
 * overlap > 80%. Different rooms with the same label (e.g. living_room ground
 * vs living_secondary upstairs) are NOT duplicates.
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix NEAR-DUPLICATE CULLING RULES.
 */

export const NEAR_DUPLICATE_CULLING_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface NearDuplicateCullingBlockOpts {
  // empty — rule block has no inputs today
}

export function nearDuplicateCullingBlock(
  _opts?: NearDuplicateCullingBlockOpts,
): string {
  return [
    'NEAR-DUPLICATE CULLING RULES (within-room only — spec L7):',
    'Two compositions are near-duplicates ONLY IF ALL THREE are true:',
    '  1. Same physical room (same room_type label).',
    '  2. Same approximate camera position (angle delta < 15°).',
    '  3. Key element overlap > 80%.',
    'Different rooms with the same label are NOT duplicates. In particular:',
    '  - living_room (ground floor) and living_secondary (upstairs lounge) are DIFFERENT rooms — never cull as duplicates.',
    '  - ensuite_primary shower-side and ensuite_primary vanity-side are DIFFERENT angles when delta > 30° — keep both.',
    '  - Two exterior_front shots from substantially different positions are not duplicates.',
  ].join('\n');
}

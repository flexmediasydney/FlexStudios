/**
 * vantagePoint.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Defines the three vantage_point values + the spec-L6 alfresco/exterior_rear
 * disambiguation rule that downstream Pass 2 selection logic depends on.
 *
 * Byte-stable lift from `pass1Prompt.ts` userPrefix (the VANTAGE POINT section).
 */

export const VANTAGE_POINT_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface VantagePointBlockOpts {
  // empty — definition block has no inputs today
}

export function vantagePointBlock(_opts?: VantagePointBlockOpts): string {
  return [
    'VANTAGE POINT (critical for alfresco/exterior_rear disambiguation):',
    'interior_looking_out: camera is inside the structure looking outward through doors/windows.',
    'exterior_looking_in: camera is outside the structure looking toward the building.',
    'neutral: neither (e.g. straight-on facade, flat exterior, internal view with no outward orientation).',
    '',
    'IMPORTANT: alfresco + exterior_looking_in means the composition is also eligible for the exterior_rear slot. The downstream selection logic uses this combination to disambiguate "alfresco from inside the pavilion looking out" (an alfresco hero) from "alfresco from the garden looking back at the structure" (a rear exterior). Set vantage_point honestly so this distinction is preserved.',
  ].join('\n');
}

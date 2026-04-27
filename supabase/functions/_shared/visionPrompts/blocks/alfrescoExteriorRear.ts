/**
 * alfrescoExteriorRear.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Pass 2 eligibility rule (spec L6): a composition with room_type=alfresco AND
 * vantage_point=exterior_looking_in is eligible for the exterior_rear slot
 * (NOT just alfresco_hero). Pass 1 pre-computes this on the
 * eligible_for_exterior_rear column; the classification line surfaces "eligXR".
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix ALFRESCO + EXTERIOR_REAR
 * ELIGIBILITY section.
 */

export const ALFRESCO_EXTERIOR_REAR_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface AlfrescoExteriorRearBlockOpts {
  // empty — rule block has no inputs today
}

export function alfrescoExteriorRearBlock(
  _opts?: AlfrescoExteriorRearBlockOpts,
): string {
  return [
    'ALFRESCO + EXTERIOR_REAR ELIGIBILITY (spec L6):',
    '  When room_type=alfresco AND vantage_point=exterior_looking_in (camera outside the structure looking back at the building), the composition is eligible for the exterior_rear slot, NOT just alfresco_hero. The classification line shows "eligXR" for these. Use them for exterior_rear when no purpose-shot exterior_rear candidate exists.',
  ].join('\n');
}

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  ALFRESCO_EXTERIOR_REAR_BLOCK_VERSION,
  alfrescoExteriorRearBlock,
} from './alfrescoExteriorRear.ts';

Deno.test('alfrescoExteriorRearBlock: includes alfresco eligibility rule + eligXR badge', () => {
  const txt = alfrescoExteriorRearBlock();
  assertStringIncludes(txt, 'alfresco');
  assertStringIncludes(txt, 'exterior_looking_in');
  assertStringIncludes(txt, 'exterior_rear');
  assertStringIncludes(txt, 'eligXR');
});

Deno.test('alfrescoExteriorRearBlock: version constant is the v1.0 baseline', () => {
  assertEquals(ALFRESCO_EXTERIOR_REAR_BLOCK_VERSION, 'v1.0');
});

/**
 * pass1OutputSchema.ts — Wave 7 P1-10 (W7.6) block.
 *
 * The 22-field JSON output schema the Pass 1 model must emit. Wave 11 will
 * supersede this with the universal vision response schema; today's block
 * preserves the legacy 22-field shape verbatim.
 *
 * Byte-stable lift from `pass1Prompt.ts` userPrefix (lines 106-128).
 */

export const PASS1_OUTPUT_SCHEMA_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface Pass1OutputSchemaBlockOpts {
  // empty today — Wave 11 may add `{ source: 'raw' | 'finals' | 'external' }`
}

export function pass1OutputSchemaBlock(_opts?: Pass1OutputSchemaBlockOpts): string {
  return [
    'Return ONLY valid JSON, no other text, no Markdown fences:',
    '{',
    '  "analysis": "Full descriptive paragraph from Step 1. Minimum 3 sentences.",',
    '  "room_type": "see taxonomy below",',
    '  "room_type_confidence": 0.95,',
    '  "composition_type": "see taxonomy below",',
    '  "vantage_point": "interior_looking_out | exterior_looking_in | neutral",',
    '  "time_of_day": "day | golden_hour | dusk_twilight | night",',
    '  "is_drone": false,',
    '  "is_exterior": false,',
    '  "is_detail_shot": false,',
    '  "zones_visible": ["zone1", "zone2"],',
    '  "key_elements": ["element1", "element2"],',
    '  "is_styled": true,',
    '  "indoor_outdoor_visible": false,',
    '  "clutter_severity": "none | minor_photoshoppable | moderate_retouch | major_reject",',
    '  "clutter_detail": null,',
    '  "flag_for_retouching": false,',
    '  "technical_score": 7,',
    '  "lighting_score": 7,',
    '  "composition_score": 7,',
    '  "aesthetic_score": 7',
    '}',
  ].join('\n');
}

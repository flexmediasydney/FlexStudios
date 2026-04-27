/**
 * pass2OutputSchema.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Pass 2 INSTRUCTIONS + winner-with-slot_alternatives JSON output schema +
 * trailing "respond with the JSON object only" reminder.
 *
 * Byte-stable lift from `pass2Prompt.ts` userPrefix INSTRUCTIONS section + JSON
 * schema + Output requirement closer.
 */

export const PASS2_OUTPUT_SCHEMA_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface Pass2OutputSchemaBlockOpts {
  // empty today — Wave 11 may add `{ source: 'raw' | 'finals' | 'external' }`
}

export function pass2OutputSchemaBlock(
  _opts?: Pass2OutputSchemaBlockOpts,
): string {
  return [
    'INSTRUCTIONS:',
    '1. Fill every Phase 1 mandatory slot first. If no candidate exists for a mandatory slot, list it in unfilled_slots — DO NOT pick an unrelated image.',
    '2. Fill Phase 2 conditional slots ONLY for room types confirmed in the classifications above.',
    '3. Fill Phase 3 free recommendations up to the ceiling, ranked by genuine value-add. Each recommendation needs a one-sentence justification of what unique value it adds.',
    '4. For every slot you fill, identify the top 3 candidates (winner = slot_assignments, ranks 2 + 3 = slot_alternatives). The winner must NOT also appear in slot_alternatives for the same slot.',
    '5. Identify near-duplicates (per the within-room rules above) and list their stems in rejected_near_duplicates. A stem CANNOT appear in both shortlist and rejected_near_duplicates — shortlist takes precedence.',
    '6. Write a coverage_notes paragraph (3-6 sentences) summarising shoot quality, any gaps, and notable strengths/weaknesses. This appears in the human review UI.',
    '',
    'Return ONLY valid JSON, no Markdown fences, no commentary, no prose before or after:',
    '{',
    '  "shortlist": ["stem1", "stem2", ...],   // every stem chosen across all 3 phases',
    '  "slot_assignments": {',
    '    "<slot_id>": "stem"                    // single-image slot',
    '    "<slot_id>": ["stem", "stem"]          // multi-image slot (e.g. ensuite_hero with 2 angles)',
    '  },',
    '  "slot_alternatives": {',
    '    "<slot_id>": ["rank2_stem", "rank3_stem"]   // next 2 best candidates per slot',
    '  },',
    '  "phase3_recommendations": [',
    '    { "file": "stem", "rank": 1, "justification": "what unique value this adds" }',
    '  ],',
    '  "unfilled_slots": ["<slot_id>", ...],          // slots with no suitable candidate',
    '  "rejected_near_duplicates": ["stem", ...],      // culled per within-room rules above',
    '  "coverage_notes": "Full paragraph summarising shoot quality and gaps."',
    '}',
    '',
    'Output requirement: respond with the JSON object only. Use the exact stems shown in the classification lines above — do not invent filenames. Stems are case-sensitive.',
  ].join('\n');
}

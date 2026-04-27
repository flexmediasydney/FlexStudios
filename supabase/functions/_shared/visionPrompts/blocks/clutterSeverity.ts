/**
 * clutterSeverity.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Graduated clutter levels (none / minor_photoshoppable / moderate_retouch /
 * major_reject) + the flag_for_retouching derivation rule. Closes with the
 * Pass 1 output requirement reminder ("respond with the JSON object only").
 *
 * Byte-stable lift from `pass1Prompt.ts` userPrefix CLUTTER SEVERITY section
 * + the trailing Output requirement line.
 */

export const CLUTTER_SEVERITY_BLOCK_VERSION = 'v1.0';

// deno-lint-ignore no-empty-interface
export interface ClutterSeverityBlockOpts {
  // empty — rule block has no inputs today
}

export function clutterSeverityBlock(_opts?: ClutterSeverityBlockOpts): string {
  return [
    'CLUTTER SEVERITY (spec L10) — graduated, NOT binary:',
    '- "none": no clutter, scene is clean.',
    '- "minor_photoshoppable": small distractions like council bins on exterior, single visible cord, small personal item — flag for retouching but do NOT reject. Strong compositions with minor flagged distractions are still shortlist-eligible.',
    '- "moderate_retouch": multiple distractions, meaningful retouch effort required. Flag and deduct.',
    '- "major_reject": catastrophic clutter — primary subject completely obscured, scene unrecoverable.',
    '',
    'Set flag_for_retouching=true whenever clutter_severity is minor_photoshoppable or moderate_retouch. Set it to false only when clutter_severity is "none" or "major_reject".',
    '',
    'Output requirement: respond with the JSON object only. No prose before or after. No Markdown fences. No commentary.',
  ].join('\n');
}

/**
 * streamBAnchors.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Rehome of `streamBInjector.buildScoringReferenceBlock`. Renders the Stream B
 * tier-anchor reference (Tier S=5 / Tier P=8 / Tier A=9.5+) as a prompt-
 * injectable block. Without these anchors Sonnet collapses every classification
 * into the safe 7-9 band — there is no reference for what a 3 looks like, so
 * the model never goes there.
 *
 * `streamBInjector.ts` retains the original `buildScoringReferenceBlock` export
 * as a delegating shim for backward-compat with any external integrations that
 * may still import it; new code should consume `streamBAnchorsBlock` directly.
 */

import type { StreamBAnchors } from '../../streamBInjector.ts';

export const STREAM_B_ANCHORS_BLOCK_VERSION = 'v1.0';

export interface StreamBAnchorsBlockOpts {
  anchors: StreamBAnchors;
}

export function streamBAnchorsBlock(opts: StreamBAnchorsBlockOpts): string {
  const { anchors } = opts;
  return [
    'STREAM B SCORING ANCHORS (Australian professional photography standards):',
    '',
    anchors.tierS,
    '',
    anchors.tierP,
    '',
    anchors.tierA,
    '',
    'Score distribution guidance:',
    '- Score 1–3: Technical failure or major compositional fault.',
    '- Score 4–5: Below Tier P minimum — adequate at best.',
    '- Score 6–7: Competent Tier S / approaching Tier P.',
    '- Score 8–9: Strong Tier P — premium shortlist quality.',
    '- Score 9.5+: Tier A — exceptional, publication-grade.',
    '',
    'Without the above anchors, scores cluster 7–9 (grade inflation). Use the ',
    'anchors. A score of 5 is the FLOOR for "competent professional real estate" ',
    '— anything less means the image fails Tier S.',
  ].join('\n');
}

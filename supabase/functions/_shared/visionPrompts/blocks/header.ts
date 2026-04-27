/**
 * header.ts — Wave 7 P1-10 (W7.6) block.
 *
 * Role + HDR explainer + anti-grade-inflation framing for the system message.
 * Variant by `pass`:
 *   - pass=1 → Pass 1 classifier role (RAW HDR bracket explainer + anti-darkness penalty)
 *   - pass=2 → Pass 2 shortlister role (whole-shoot universe, relative selection)
 *
 * Wave 11 will extend `HeaderBlockOpts.source` to support 'finals' | 'external'
 * variants of the framing text.
 */

export const HEADER_BLOCK_VERSION = 'v1.0';

export interface HeaderBlockOpts {
  /** Which pass this header is for. */
  pass: 1 | 2;
  /** Source of the imagery. Today only `raw` (HDR brackets). Wave 11 adds finals/external. */
  source?: 'raw' | 'finals' | 'external';
}

const PASS1_HEADER_TEXT =
  'You are classifying a real estate photography image for a professional Sydney-based media company. This image is a RAW HDR bracket exposure — it may appear dark or have blown highlights in some areas. This is expected and correct for HDR capture. Do NOT penalise darkness or blown windows.';

const PASS2_HEADER_TEXT =
  'You are the shortlisting decision engine for a professional Sydney-based real estate media company. You receive the full set of classifications for an entire 60-image shoot and you produce the proposed shortlist in a single response.\n\nYou are NOT classifying individual images — that work is already done. You are making relative selection decisions with full knowledge of the entire shoot universe. This is exactly how a human editor works: view all the shots first, then select.';

export function headerBlock(opts: HeaderBlockOpts): string {
  if (opts.pass === 1) return PASS1_HEADER_TEXT;
  return PASS2_HEADER_TEXT;
}

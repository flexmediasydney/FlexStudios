/**
 * tierWeightingContext.ts — Wave 8 (W7.6 composable block).
 *
 * Spec: docs/design-specs/W8-tier-configs.md §4 (Pass 2: tier_config informs
 * the prompt) + R10 (opt-in via engine_settings.pass2_tier_weighting_context_enabled).
 *
 * Renders an opt-in context block for the Pass 2 prompt that surfaces the
 * tier's dimension priorities. The model uses this to phrase acceptance/
 * rejection reasoning when scores are close to the Tier anchor — knowing
 * "this round weights aesthetic at 0.35 vs technical 0.20" helps the model
 * pick the right tie-breaker between two Tier-P-anchor compositions.
 *
 * IMPORTANT: this block is OPT-IN, gated by an engine_settings flag. The
 * caller (shortlisting-pass2) reads `engine_settings.pass2_tier_weighting_context_enabled`
 * (default TRUE) and decides whether to include this block in the prompt.
 * When disabled, the block is omitted entirely (not just empty) so the
 * blockVersions map for that round records the absence.
 *
 * Block-version provenance: BUMP this version constant when the text changes.
 * Bumping a tier_config weight value does NOT bump this block's version —
 * only changes to this block's wording bump it (the weights are runtime
 * parameters injected into the rendered text).
 */

export const TIER_WEIGHTING_CONTEXT_BLOCK_VERSION = 'v1.0';

export interface TierWeightingContextBlockOpts {
  /** Tier code from shortlisting_tiers.tier_code (S, P, A). */
  tierCode: string;
  /** Active tier_config version number from shortlisting_tier_configs.version. */
  tierConfigVersion: number;
  /** Score anchor from shortlisting_tiers.score_anchor (5 / 8 / 9.5). */
  scoreAnchor: number;
  /** Dimension weights map from the active tier_config. */
  dimensionWeights: {
    technical: number;
    lighting: number;
    composition: number;
    aesthetic: number;
  };
}

export function tierWeightingContextBlock(opts: TierWeightingContextBlockOpts): string {
  const { tierCode, tierConfigVersion, scoreAnchor, dimensionWeights } = opts;
  return [
    'TIER WEIGHTING CONTEXT',
    `This round runs under Tier ${tierCode} version ${tierConfigVersion}.`,
    'The dimension priorities for this tier are:',
    `  technical:    ${dimensionWeights.technical.toFixed(2)}`,
    `  lighting:     ${dimensionWeights.lighting.toFixed(2)}`,
    `  composition:  ${dimensionWeights.composition.toFixed(2)}`,
    `  aesthetic:    ${dimensionWeights.aesthetic.toFixed(2)}`,
    `When two compositions are scored close to the Tier ${tierCode} anchor of`,
    `${scoreAnchor}, prefer the one whose strengths align with the higher-weighted`,
    'dimensions for this tier.',
  ].join('\n');
}

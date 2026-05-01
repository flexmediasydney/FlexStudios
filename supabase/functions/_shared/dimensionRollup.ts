/**
 * dimensionRollup.ts — Wave 11.7.17 universal-schema aggregate-score helper.
 *
 * Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §6
 *
 * ─── Purpose ─────────────────────────────────────────────────────────────────
 *
 * The v2 universal schema emits 26 per-signal scores (22 from v1 + 4 new
 * lighting signals — Q2 binding). The 4 backwards-compat aggregate axis
 * scores (technical_score, lighting_score, composition_score,
 * aesthetic_score) + combined_score are now COMPUTED VIEWS over the signal
 * scores, not authoritative model output. This helper does that computation.
 *
 * Q2 binding rationale: lighting now has 4 dedicated signals (light_quality,
 * light_directionality, color_temperature_appropriateness,
 * light_falloff_quality). The lighting aggregate is computed FROM those 4,
 * not from technical exposure_balance or color_cast.
 *
 * Per-source dimorphism: signals with `null` value (e.g. RAW exposure_balance,
 * floorplan composition_*) are SKIPPED from the dimension's weighted mean —
 * they don't penalise the aggregate, they're just out of scope.
 *
 * ─── Tier-config integration (W11.6.18 plumbed) ──────────────────────────────
 *
 * `tier_config_signal_weights` is a flat `{ signal_key: weight }` map, the
 * same shape used by `selectCombinedScore` in `scoreRollup.ts`. When provided,
 * each signal contributes `score × weight` to its dimension's mean. When
 * absent or empty, signals contribute equally (mean of present signals).
 *
 * `combined_score` is the weighted sum of the 4 dimension aggregates using
 * tier-config dimension_weights when available, else the seed v1 weights
 * from `scoreRollup.ts:DEFAULT_DIMENSION_WEIGHTS`
 * (technical=0.25, lighting=0.30, composition=0.25, aesthetic=0.20).
 *
 * ─── Pure / deterministic ────────────────────────────────────────────────────
 *
 * No DB calls, no network, no Date.now(). Same testability contract as
 * `scoreRollup.ts`. Idempotent: same input → same output.
 */

import {
  SIGNAL_TO_DIMENSION,
  type UniversalSignalKey,
} from './visionPrompts/blocks/universalVisionResponseSchemaV2.ts';
import {
  DEFAULT_DIMENSION_WEIGHTS,
  type DimensionWeights,
} from './scoreRollup.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Per-signal score map. Values are 0-10 numeric, or null when the signal
 * doesn't apply to the source (e.g. RAW exposure_balance is null because
 * brackets are pre-merge; floorplan composition_geometry is null because
 * architectural drawings have no aesthetic frame).
 *
 * Accepts the loose `Record<string, number | null | undefined>` shape so the
 * helper is friendly to legacy callers that emit a subset of the 26 keys —
 * unrecognised keys (or `undefined` values) are simply skipped.
 */
export type SignalScores = Record<string, number | null | undefined>;

export interface AggregateScoresResult {
  /** Per-signal weighted mean over signals mapped to dimension='technical'.
   *  Null when no technical signals are present. */
  technical: number | null;
  /** Per-signal weighted mean over signals mapped to dimension='lighting'.
   *  Q2 binding: computed FROM the 4 new lighting signals (light_quality,
   *  light_directionality, color_temperature_appropriateness,
   *  light_falloff_quality), NOT from technical exposure_balance/color_cast. */
  lighting: number | null;
  composition: number | null;
  aesthetic: number | null;
  /** Tier-weighted blend of the 4 dimension aggregates, or null when all
   *  4 dimensions are null. Uses tier_config dimension_weights when provided,
   *  else DEFAULT_DIMENSION_WEIGHTS from scoreRollup.ts. */
  combined: number | null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the 4 dimension aggregates + combined_score from a signal_scores
 * map and an optional tier_config signal_weights record.
 *
 * Behaviour:
 *   - For each of the 4 dimensions (technical/lighting/composition/aesthetic):
 *     - Filter to signals mapped to that dimension via SIGNAL_TO_DIMENSION.
 *     - Drop signals whose value is null/undefined/non-finite.
 *     - When tier_config signal_weights provided + at least 1 weighted signal
 *       has a value: compute weighted mean (sum(score × weight) / sum(weight)).
 *     - Else: compute simple mean of the present signal values.
 *     - When no signals are present for the dimension: return null.
 *   - combined_score: weighted sum of present dimension aggregates using
 *     tier_config dimension_weights (default: technical=0.25, lighting=0.30,
 *     composition=0.25, aesthetic=0.20). Skips null dimensions entirely
 *     (renormalises over the present ones).
 *   - All numeric outputs rounded to 2 decimal places.
 *
 * Inputs:
 *   - signal_scores: 26-key (or any subset) record of 0-10 numeric or null.
 *   - tier_config_signal_weights: optional `{ signal_key: weight }` map.
 *   - tier_config_dimension_weights: optional 4-key dimension weights record.
 *
 * Output: AggregateScoresResult with all 5 numeric (or null) fields.
 */
export function computeAggregateScores(
  signal_scores: SignalScores,
  tier_config_signal_weights?: Record<string, number> | null,
  tier_config_dimension_weights?: Partial<DimensionWeights> | null,
): AggregateScoresResult {
  const technical = computeDimensionScore(
    signal_scores, 'technical', tier_config_signal_weights,
  );
  const lighting = computeDimensionScore(
    signal_scores, 'lighting', tier_config_signal_weights,
  );
  const composition = computeDimensionScore(
    signal_scores, 'composition', tier_config_signal_weights,
  );
  const aesthetic = computeDimensionScore(
    signal_scores, 'aesthetic', tier_config_signal_weights,
  );

  const combined = computeCombinedFromDimensions(
    { technical, lighting, composition, aesthetic },
    tier_config_dimension_weights,
  );

  return { technical, lighting, composition, aesthetic, combined };
}

/**
 * Compute one dimension's aggregate from the signal_scores map.
 * Exported for unit tests + ad-hoc tier-config debugging in the admin UI.
 */
export function computeDimensionScore(
  signal_scores: SignalScores,
  dimension: 'technical' | 'lighting' | 'composition' | 'aesthetic',
  tier_config_signal_weights?: Record<string, number> | null,
): number | null {
  // Build the list of signal keys mapped to this dimension.
  const dimSignals: UniversalSignalKey[] = [];
  for (const [key, dim] of Object.entries(SIGNAL_TO_DIMENSION)) {
    if (dim === dimension) {
      dimSignals.push(key as UniversalSignalKey);
    }
  }

  // Filter to signals with present numeric values.
  const present: Array<{ key: UniversalSignalKey; value: number; weight: number }> = [];
  const sigW = tier_config_signal_weights;
  const hasWeights = sigW && typeof sigW === 'object' && Object.keys(sigW).length > 0;

  for (const key of dimSignals) {
    const v = signal_scores?.[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    let weight = 1; // unweighted default → simple mean
    if (hasWeights) {
      const w = Number(sigW[key]);
      // When tier_config has signal_weights but doesn't list THIS key,
      // contribute weight=0 (effectively excluded from the weighted mean).
      // Falls back to weight=1 when the entire tier_config_signal_weights
      // is absent (the unweighted simple-mean path).
      weight = Number.isFinite(w) && w > 0 ? w : 0;
    }
    if (weight === 0 && hasWeights) continue;
    present.push({ key, value: v, weight });
  }

  if (present.length === 0) return null;

  let weightedSum = 0;
  let weightTotal = 0;
  for (const { value, weight } of present) {
    weightedSum += value * weight;
    weightTotal += weight;
  }
  if (weightTotal === 0) return null;
  return round2(weightedSum / weightTotal);
}

/**
 * Compute combined_score from the 4 dimension aggregates + dimension_weights.
 *
 * Behaviour:
 *   - Skip null dimensions entirely (renormalise over the present ones).
 *   - Weights default to DEFAULT_DIMENSION_WEIGHTS when not provided.
 *   - When all 4 dimensions are null, return null.
 */
export function computeCombinedFromDimensions(
  dimensions: {
    technical: number | null;
    lighting: number | null;
    composition: number | null;
    aesthetic: number | null;
  },
  tier_config_dimension_weights?: Partial<DimensionWeights> | null,
): number | null {
  const w = tier_config_dimension_weights ?? {};
  const wTech = pickWeight(w, 'technical');
  const wLight = pickWeight(w, 'lighting');
  const wComp = pickWeight(w, 'composition');
  const wAes = pickWeight(w, 'aesthetic');

  let weightedSum = 0;
  let weightTotal = 0;
  if (dimensions.technical != null && Number.isFinite(dimensions.technical)) {
    weightedSum += dimensions.technical * wTech;
    weightTotal += wTech;
  }
  if (dimensions.lighting != null && Number.isFinite(dimensions.lighting)) {
    weightedSum += dimensions.lighting * wLight;
    weightTotal += wLight;
  }
  if (dimensions.composition != null && Number.isFinite(dimensions.composition)) {
    weightedSum += dimensions.composition * wComp;
    weightTotal += wComp;
  }
  if (dimensions.aesthetic != null && Number.isFinite(dimensions.aesthetic)) {
    weightedSum += dimensions.aesthetic * wAes;
    weightTotal += wAes;
  }

  if (weightTotal === 0) return null;
  return round2(weightedSum / weightTotal);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function pickWeight(
  w: Record<string, unknown>,
  key: keyof DimensionWeights,
): number {
  const raw = w?.[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_DIMENSION_WEIGHTS[key];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

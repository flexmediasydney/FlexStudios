/**
 * scoreRollup.ts — pure helper for the Wave 8 weighted combined-score formula.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §4 (Pass 1 + Pass 2 integration).
 *
 * Today's combined_score (pre-Wave 8) is a uniform mean of the 4 dimension
 * scores: (technical + lighting + composition + aesthetic) / 4.
 *
 * Wave 8 replaces it with a tier-aware weighted rollup driven by the active
 * `shortlisting_tier_configs.dimension_weights` JSON. The v1 seed sets
 *   technical=0.25, lighting=0.30, composition=0.25, aesthetic=0.20
 * (lighting-biased per L9 lesson). Sum is 1.0 by construction (the save
 * handler in `update-tier-config` validates within 0.001 tolerance).
 *
 * Forward-compat shape (post-W11):
 *   combined_score = sum(per_signal_scores[k] * signal_weights[k])
 *                    / sum(signal_weights values)
 * Today (pre-W11), Pass 1 emits 4 dim aggregates only — the rollup uses
 * dimension_weights and ignores signal_weights at the rollup step. The
 * signal_weights ride along in the config as forward-compat scaffolding;
 * computeWeightedScore() ignores them; computeWeightedSignalScore() exists
 * for the W11 path but isn't wired into Pass 1 yet.
 *
 * KEEP THIS PURE: no DB calls, no network, no Date.now().
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DimensionScores {
  technical: number;
  lighting: number;
  composition: number;
  aesthetic: number;
}

export interface DimensionWeights {
  technical: number;
  lighting: number;
  composition: number;
  aesthetic: number;
}

/** Default dimension weights — used as fallback when a tier_config is missing
 *  one of the four keys. Identical to the v1 seed in mig 344. */
export const DEFAULT_DIMENSION_WEIGHTS: DimensionWeights = {
  technical: 0.25,
  lighting: 0.30,
  composition: 0.25,
  aesthetic: 0.20,
};

/** Balanced weights — produces a uniform mean of the four dimensions.
 *  Used by the regression-equivalence test to assert that 0.25/0.25/0.25/0.25
 *  weighted rollup equals (technical + lighting + composition + aesthetic) / 4. */
export const BALANCED_DIMENSION_WEIGHTS: DimensionWeights = {
  technical: 0.25,
  lighting: 0.25,
  composition: 0.25,
  aesthetic: 0.25,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the weighted combined score from the 4 dimension scores + a
 * dimension_weights record (read from the active tier_config).
 *
 * Behaviour:
 *   - Each dimension contributes `score × weight`; the sum is returned.
 *   - When a weight key is missing from the input record, the
 *     DEFAULT_DIMENSION_WEIGHTS value is used as fallback (defensive against
 *     malformed configs).
 *   - The result is rounded to 2 decimal places (matches the existing
 *     pre-W8 Pass 1 rounding: `Math.round(combined * 100) / 100`).
 *   - When weights sum to !== 1.0, the function does NOT renormalise — the
 *     spec defines weights summing to exactly 1.0 as the contract, and the
 *     save handler in `update-tier-config` validates within 0.001 tolerance.
 *     Renormalising silently here would mask config bugs.
 *
 * Returns a plain number (the combined score, 0-10 range).
 */
export function computeWeightedScore(
  scores: DimensionScores,
  dimensionWeights: Partial<DimensionWeights> | Record<string, number> | null | undefined,
): number {
  const w = dimensionWeights ?? {};
  const wTech = numericWeight(w, 'technical');
  const wLight = numericWeight(w, 'lighting');
  const wComp = numericWeight(w, 'composition');
  const wAes = numericWeight(w, 'aesthetic');

  const sum =
    scores.technical * wTech +
    scores.lighting * wLight +
    scores.composition * wComp +
    scores.aesthetic * wAes;

  // Match Pass 1's existing rounding behaviour for byte-stability with the
  // existing combined_score column rendering.
  return Math.round(sum * 100) / 100;
}

/**
 * Per-dimension breakdown — useful for the admin UI's "what each dim
 * contributed" tooltip and for the audit JSON `tier_config` block.
 *
 * Returned shape:
 *   { technical: 0.25 * tech_score, lighting: 0.30 * light_score, ... }
 *
 * Sum of the values equals the combined_score (modulo rounding at the leaf
 * level — caller can sum + round as needed).
 */
export function computeWeightedDimensionContributions(
  scores: DimensionScores,
  dimensionWeights: Partial<DimensionWeights> | Record<string, number> | null | undefined,
): DimensionScores {
  const w = dimensionWeights ?? {};
  return {
    technical: round2(scores.technical * numericWeight(w, 'technical')),
    lighting: round2(scores.lighting * numericWeight(w, 'lighting')),
    composition: round2(scores.composition * numericWeight(w, 'composition')),
    aesthetic: round2(scores.aesthetic * numericWeight(w, 'aesthetic')),
  };
}

/**
 * Validate that a dimension_weights record meets the contract:
 *   - All four required keys (technical/lighting/composition/aesthetic) are present
 *   - All values are finite numbers in the range [0, 1]
 *   - Values sum to 1.0 within the given tolerance (default 0.001)
 *
 * Used by `update-tier-config` save handler before INSERT. Returns a
 * structured result; caller maps to a 400 with the error message.
 */
export interface ValidateDimensionWeightsResult {
  valid: boolean;
  error: string | null;
  /** The numeric sum, useful for error UX. */
  sum: number;
}

export function validateDimensionWeights(
  weights: Partial<DimensionWeights> | Record<string, number> | null | undefined,
  tolerance: number = 0.001,
): ValidateDimensionWeightsResult {
  if (!weights || typeof weights !== 'object') {
    return { valid: false, error: 'dimension_weights must be an object', sum: 0 };
  }
  const REQUIRED_KEYS: Array<keyof DimensionWeights> = [
    'technical',
    'lighting',
    'composition',
    'aesthetic',
  ];
  const w = weights as Record<string, unknown>;
  const missing = REQUIRED_KEYS.filter((k) => !(k in w));
  if (missing.length > 0) {
    return {
      valid: false,
      error: `dimension_weights missing required keys: ${missing.join(', ')}`,
      sum: 0,
    };
  }

  let sum = 0;
  for (const k of REQUIRED_KEYS) {
    const v = w[k];
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) {
      return {
        valid: false,
        error: `dimension_weights.${k} is not a finite number (got ${JSON.stringify(v)})`,
        sum: 0,
      };
    }
    if (n < 0 || n > 1) {
      return {
        valid: false,
        error: `dimension_weights.${k} out of range [0, 1] (got ${n})`,
        sum: 0,
      };
    }
    sum += n;
  }

  if (Math.abs(sum - 1) > tolerance) {
    return {
      valid: false,
      error: `dimension_weights values must sum to 1.0 (got ${round2(sum)})`,
      sum,
    };
  }
  return { valid: true, error: null, sum };
}

/**
 * Forward-compat helper for W11 per-signal scoring. Computes a weighted score
 * from per-signal scores + signal_weights config. Not used in Pass 1 today
 * (Pass 1 emits 4 dim aggregates), but lives here so W11 can adopt it without
 * touching the engine.
 *
 * Behaviour:
 *   - Iterates all keys present in `signalWeights`.
 *   - For each key, score = perSignalScores[key] (default 0 if missing).
 *   - Weighted sum / sum_of_weights → returns the rolled-up score.
 *   - Returns NaN if signal_weights is empty (caller should fall back to
 *     dimension_weights rollup).
 */
export function computeWeightedSignalScore(
  perSignalScores: Record<string, number>,
  signalWeights: Record<string, number>,
): number {
  if (!signalWeights || typeof signalWeights !== 'object') return NaN;
  const keys = Object.keys(signalWeights);
  if (keys.length === 0) return NaN;

  let weightedSum = 0;
  let weightTotal = 0;
  for (const k of keys) {
    const w = Number(signalWeights[k]);
    if (!Number.isFinite(w) || w <= 0) continue;
    const s = Number(perSignalScores?.[k] ?? 0);
    if (!Number.isFinite(s)) continue;
    weightedSum += s * w;
    weightTotal += w;
  }
  if (weightTotal === 0) return NaN;
  return round2(weightedSum / weightTotal);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function numericWeight(
  weights: Record<string, unknown>,
  key: keyof DimensionWeights,
): number {
  const raw = weights?.[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n)) return n;
  return DEFAULT_DIMENSION_WEIGHTS[key];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

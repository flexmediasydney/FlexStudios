/**
 * normaliseSignalScores.ts — Wave 11.2 helper.
 *
 * Pure, dependency-free coercion of the model's `signal_scores` payload into
 * the JSONB shape persisted on `composition_classifications.signal_scores`.
 *
 * Behaviour contract:
 *   - sigScoresRaw is an object → map every key, coerce values to number-or-null.
 *   - sigScoresRaw is null / undefined / a non-object → return null and emit a
 *     warning string. Old engine_modes pre-W11.2 didn't emit signal_scores;
 *     persist must NOT fail on legacy traffic.
 *   - sigScoresRaw is an array → treated as missing (arrays aren't valid
 *     signal_scores shape; warn + null).
 *   - String numeric values ("8.5") are coerced to numbers (matches the
 *     `num()` helper used throughout persistOneClassification).
 *   - Non-numeric values land as null (e.g. {"exposure_balance": "high"} →
 *     {"exposure_balance": null}); the W8 formula falls back to the aggregate
 *     axis score for null entries.
 *
 * Single-source-of-truth: the 22 canonical keys live in
 * stage1ResponseSchema.ts (STAGE1_SIGNAL_KEYS). The model is REQUIRED to emit
 * all 22 (schema-enforced via responseSchema.required[]), but we don't gate
 * persistence on completeness — partial payloads (e.g. failover from a
 * legacy vendor that doesn't honour the new keys) still get persisted with
 * the keys they did emit.
 */

function coerceNumber(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface NormaliseSignalScoresResult {
  /** JSONB-ready object, or null when input was missing/malformed. */
  signalScores: Record<string, number | null> | null;
  /** Warning string when input was missing/malformed; null otherwise. */
  warning: string | null;
}

export function normaliseSignalScores(
  raw: unknown,
  context: { groupId: string; stem: string },
): NormaliseSignalScoresResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      signalScores: null,
      warning:
        `signal_scores missing for ${context.groupId} (stem=${context.stem}); ` +
        'persisting as null. W11.2 expects 22 keys.',
    };
  }
  const obj = raw as Record<string, unknown>;
  const mapped: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(obj)) {
    mapped[k] = coerceNumber(v);
  }
  return { signalScores: mapped, warning: null };
}

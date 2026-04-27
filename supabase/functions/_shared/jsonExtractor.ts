/**
 * jsonExtractor.ts — pure JSON-from-LLM-output extraction logic.
 *
 * Shared utility consolidating the multi-fence + brace-finding pattern that
 * the four pass-function parsers all duplicate today. Captures hard-won fixes
 * from bursts 6 L2 / 7 M5 / 9 O1 / 14 W2.
 *
 * The function returns a parsed object on success, or { ok: false, error }
 * on failure. Shape validation (required fields, type coercion, score
 * clamping) remains in each pass-specific parser — this only handles the
 * common "find the JSON object inside the model's response" step.
 *
 * Migration path: the four inline parsers (pass0, pass1, pass2, benchmark)
 * each duplicate this logic. After Wave 7, those will switch to:
 *
 *   const r = extractJsonBlock(text);
 *   if (!r.ok) return { ok: false, error: r.error };
 *   const parsed = r.value as Record<string, unknown>;
 *   // ... pass-specific validation
 */

export type ExtractResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Extract a top-level JSON object from arbitrary LLM text output.
 *
 * Handles:
 *   - Multi-fence outputs (one fence wraps prose, another wraps JSON) —
 *     picks the fence whose contents include `{`. (burst 6 L2 / 7 M5 / 9 O1 / 14 W2)
 *   - Single-fence outputs.
 *   - Bare-text outputs (no fences).
 *   - Whitespace-padded inputs.
 *
 * Does NOT handle:
 *   - Multiple JSON objects in one response (returns the outermost {…} pair).
 *   - JSON arrays at the top level (returns ok=false).
 *   - Concatenated JSON (e.g. JSONL) — returns the first object only via
 *     first/last brace, which means a multi-object response gets corrupted.
 *     Pass-specific parsers should validate the parsed shape afterwards.
 */
export function extractJsonBlock(text: string): ExtractResult {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: 'empty response' };
  }
  let body = text.trim();
  if (body.length === 0) {
    return { ok: false, error: 'empty response' };
  }

  // Multi-fence: find ALL ```...``` blocks and prefer the one containing `{`.
  // Falls back to the first fence if none contain `{` (legacy single-fence
  // behaviour). This is the key fix from bursts 6 L2 / 7 M5 / 9 O1 / 14 W2 —
  // when the model emits two fences (analysis prose + JSON output), the
  // older `match()` non-greedy regex picked the FIRST fence (analysis text)
  // and the brace-finder failed to locate JSON.
  const fenceMatches = Array.from(body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  if (fenceMatches.length > 0) {
    const jsonFence = fenceMatches.find((m) => m[1].includes('{'));
    body = (jsonFence ?? fenceMatches[0])[1].trim();
  }

  const braceStart = body.indexOf('{');
  const braceEnd = body.lastIndexOf('}');
  if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
    return { ok: false, error: 'no JSON object found' };
  }

  try {
    const value = JSON.parse(body.slice(braceStart, braceEnd + 1));
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Lenient boolean coercion (burst 6 L1).
 *
 * Sonnet/Haiku occasionally emit booleans as strings ("true"/"yes"/"y"/"1")
 * or numbers (0/1) instead of canonical JSON booleans. The strict v===true
 * check silently corrupts these to false — this helper accepts the common
 * variants. Used by every pass that consumes boolean fields from model output.
 */
export function lenientBool(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === 'y' || s === '1';
  }
  if (typeof v === 'number') return v === 1;
  return false;
}

/**
 * Clamp a numeric score to [0, 10] with a fallback for non-finite input.
 * Used by Pass 1's per-dimension scores. Sonnet occasionally emits scores
 * as strings ("9.5") which Number() handles; emits scores >10 which we clamp;
 * emits negative scores which we clamp to 0.
 */
export function clampScore(v: unknown, fallback: number): number {
  // Note: Number(null) === 0 (not NaN), so we have to short-circuit null first.
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, n));
}

/**
 * Clamp a confidence value to [0, 1] with 0 fallback for non-finite input.
 * Used by Pass 1's room_type_confidence.
 */
export function clampConfidence(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

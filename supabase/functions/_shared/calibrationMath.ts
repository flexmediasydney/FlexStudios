/**
 * Wave 14 — calibration math helpers.
 *
 * Pure functions that compute the W14 metrics. Imported by:
 *   - shortlisting-calibration-runner (the edge fn that produces runs)
 *   - calibrationMath.test.ts          (the unit tests)
 *
 * Spec: docs/design-specs/W14-structured-calibration.md
 *
 * NO Supabase / Deno / network deps. Pure math + types so the helpers run in
 * `deno test` without any external setup.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ScoreAxis = 'technical' | 'lighting' | 'composition' | 'aesthetic';

export const SCORE_AXES: readonly ScoreAxis[] = ['technical', 'lighting', 'composition', 'aesthetic'];

export interface ImageScores {
  technical: number;
  lighting: number;
  composition: number;
  aesthetic: number;
}

/**
 * One image present in BOTH the prior and current run. Caller already joined
 * by stem (or composition_group_id) so prior/now refer to the same image.
 */
export interface PairedImageScore {
  stem: string;
  prior: ImageScores;
  now: ImageScores;
}

export type ClutterSeverity =
  | 'none'
  | 'minor_photoshoppable'
  | 'moderate_retouch'
  | 'major_reject';

export const CLUTTER_RANK: Record<ClutterSeverity, number> = {
  none: 0,
  minor_photoshoppable: 1,
  moderate_retouch: 2,
  major_reject: 3,
};

export interface PairedClutter {
  stem: string;
  prior: ClutterSeverity | null;
  now: ClutterSeverity | null;
}

export interface SlotDecision {
  slot_id: string;
  winning_stem: string | null; // null if no winner (slot empty)
}

export type PropertyTier = 'premium' | 'standard' | 'approachable';

/** Per-tier word_count + reading_grade_level acceptance bands (W11.7.7 spec). */
export const TIER_BANDS: Record<
  PropertyTier,
  { word_count: [number, number]; reading_grade_level: [number, number] }
> = {
  premium:      { word_count: [700, 1000], reading_grade_level: [9.0, 11.0] },
  standard:     { word_count: [500, 750],  reading_grade_level: [8.5, 10.5] },
  approachable: { word_count: [350, 500],  reading_grade_level: [8.0, 10.0] },
};

// ─── Score consistency ──────────────────────────────────────────────────────

export interface ScoreDeltaDistribution {
  median: ImageScores;
  p95: ImageScores;
  max: ImageScores;
  /** Per-axis maximum across ALL images (the worst single shift). */
  max_axis_max: number;
  /** Drift events (any axis > 0.5 delta on a single image). */
  drift_events: Array<{
    stem: string;
    axis: ScoreAxis;
    prior: number;
    now: number;
    delta: number;
  }>;
}

/**
 * Compute per-axis delta distribution across paired images. The "max" axis
 * statistics describe the worst-case shift on each axis; drift events are the
 * concrete (stem, axis) pairs that exceeded the 0.5 threshold. Returns a
 * zero-distribution for empty input (caller decides whether to surface it).
 */
export function computeScoreConsistency(
  pairs: PairedImageScore[],
  driftThreshold = 0.5,
): ScoreDeltaDistribution {
  if (pairs.length === 0) {
    const z: ImageScores = { technical: 0, lighting: 0, composition: 0, aesthetic: 0 };
    return { median: z, p95: z, max: z, max_axis_max: 0, drift_events: [] };
  }

  // Per-axis sorted delta arrays
  const deltasByAxis: Record<ScoreAxis, number[]> = {
    technical: [],
    lighting: [],
    composition: [],
    aesthetic: [],
  };
  const drift_events: ScoreDeltaDistribution['drift_events'] = [];

  for (const pair of pairs) {
    for (const axis of SCORE_AXES) {
      const prior = Number(pair.prior[axis] ?? 0);
      const now = Number(pair.now[axis] ?? 0);
      const delta = Math.abs(now - prior);
      deltasByAxis[axis].push(delta);
      if (delta > driftThreshold) {
        drift_events.push({ stem: pair.stem, axis, prior, now, delta: round2(delta) });
      }
    }
  }

  for (const axis of SCORE_AXES) {
    deltasByAxis[axis].sort((a, b) => a - b);
  }

  const median = mapAxes((axis) => round2(percentile(deltasByAxis[axis], 0.50)));
  const p95 = mapAxes((axis) => round2(percentile(deltasByAxis[axis], 0.95)));
  const max = mapAxes((axis) => round2(maxOf(deltasByAxis[axis])));
  const max_axis_max = Math.max(max.technical, max.lighting, max.composition, max.aesthetic);

  return { median, p95, max, max_axis_max, drift_events };
}

function mapAxes(fn: (axis: ScoreAxis) => number): ImageScores {
  return {
    technical: fn('technical'),
    lighting: fn('lighting'),
    composition: fn('composition'),
    aesthetic: fn('aesthetic'),
  };
}

/** Return the value at percentile p in a sorted ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function maxOf(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => Math.max(a, b), -Infinity);
}

/**
 * Stable median of a numeric array (NaN/null filtered out). Returns null on
 * empty so the caller can surface "—" rather than 0 in the dashboard.
 */
export function medianOrNull(values: Array<number | null | undefined>): number | null {
  const clean = values
    .filter((v): v is number => v != null && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

// ─── Slot agreement ─────────────────────────────────────────────────────────

export interface SlotAgreementResult {
  /** Fraction of slots where prior and now picked the same stem. NULL when no
   *  shared slots existed (denominator zero). */
  agreement_pct: number | null;
  matched: number;
  total: number;
  per_slot: Array<{
    slot_id: string;
    prior_stem: string | null;
    now_stem: string | null;
    agreed: boolean;
  }>;
}

/**
 * Compare slot decisions between prior and current runs. Slots present in
 * BOTH lists are compared; slots in only one are excluded from the
 * denominator (they're a different signal — coverage drift, not slot drift).
 */
export function computeSlotAgreement(
  prior: SlotDecision[],
  now: SlotDecision[],
): SlotAgreementResult {
  const priorMap = new Map<string, string | null>();
  for (const d of prior) priorMap.set(d.slot_id, d.winning_stem);
  const nowMap = new Map<string, string | null>();
  for (const d of now) nowMap.set(d.slot_id, d.winning_stem);

  const sharedSlots = [...priorMap.keys()].filter((slot) => nowMap.has(slot));
  const per_slot: SlotAgreementResult['per_slot'] = [];
  let matched = 0;
  for (const slot of sharedSlots) {
    const p = priorMap.get(slot) ?? null;
    const n = nowMap.get(slot) ?? null;
    const agreed = p === n;
    if (agreed) matched++;
    per_slot.push({ slot_id: slot, prior_stem: p, now_stem: n, agreed });
  }
  if (sharedSlots.length === 0) {
    return { agreement_pct: null, matched: 0, total: 0, per_slot: [] };
  }
  return {
    agreement_pct: round4(matched / sharedSlots.length),
    matched,
    total: sharedSlots.length,
    per_slot,
  };
}

// ─── Regression detection ──────────────────────────────────────────────────

export interface RegressionResult {
  regressions: Array<{
    stem: string;
    prior_severity: ClutterSeverity | null;
    now_severity: ClutterSeverity | null;
    rank_jump: number;
  }>;
  count: number;
  pct: number; // count / total_compositions
}

/**
 * Detect clutter_severity ESCALATIONS between runs (e.g. minor → moderate).
 * Improvements (moderate → none) are NOT regressions. Null prior is treated
 * as "unknown" and skipped — only paired transitions count.
 */
export function detectRegressions(
  pairs: PairedClutter[],
  totalCompositions: number,
): RegressionResult {
  const regressions: RegressionResult['regressions'] = [];
  for (const p of pairs) {
    if (p.prior == null || p.now == null) continue;
    const priorRank = CLUTTER_RANK[p.prior];
    const nowRank = CLUTTER_RANK[p.now];
    if (nowRank > priorRank) {
      regressions.push({
        stem: p.stem,
        prior_severity: p.prior,
        now_severity: p.now,
        rank_jump: nowRank - priorRank,
      });
    }
  }
  const total = totalCompositions > 0 ? totalCompositions : pairs.length;
  return {
    regressions,
    count: regressions.length,
    pct: total > 0 ? round4(regressions.length / total) : 0,
  };
}

// ─── Master listing band ────────────────────────────────────────────────────

/**
 * Return TRUE iff word_count is within the per-tier acceptance band.
 * Reading-grade-level is informational here; the band is defined on
 * word_count for the in-band/out-of-band signal.
 */
export function masterListingInBand(
  tier: PropertyTier,
  wordCount: number | null | undefined,
): boolean {
  if (wordCount == null || !Number.isFinite(wordCount)) return false;
  const band = TIER_BANDS[tier];
  if (!band) return false;
  return wordCount >= band.word_count[0] && wordCount <= band.word_count[1];
}

// ─── Acceptance pass/fail ───────────────────────────────────────────────────

export interface AcceptanceInput {
  median_score_delta: number | null;
  median_slot_agreement: number | null;
  median_override_rate: number | null;
  median_regression_pct: number | null;
  master_listing_oob_rate: number | null;
}

export interface AcceptanceResult {
  pass: boolean;
  failed_criteria: string[];
}

/**
 * Evaluate the 5 acceptance criteria. NULL inputs are treated as "criterion
 * not evaluable" — they DON'T count as a failure (the dashboard surfaces them
 * separately). This keeps partial-data runs from flapping pass/fail.
 */
export function evaluateAcceptance(input: AcceptanceInput): AcceptanceResult {
  const failed: string[] = [];

  if (input.median_score_delta != null && input.median_score_delta >= 0.3) {
    failed.push('median_score_delta');
  }
  if (input.median_slot_agreement != null && input.median_slot_agreement < 0.80) {
    failed.push('median_slot_agreement');
  }
  if (
    input.median_override_rate != null &&
    (input.median_override_rate < 0.02 || input.median_override_rate > 0.08)
  ) {
    failed.push('median_override_rate');
  }
  if (input.median_regression_pct != null && input.median_regression_pct >= 0.02) {
    failed.push('median_regression_pct');
  }
  if (input.master_listing_oob_rate != null && input.master_listing_oob_rate > 0.10) {
    failed.push('master_listing_oob_rate');
  }

  return { pass: failed.length === 0, failed_criteria: failed };
}

// ─── Stratified sampler ─────────────────────────────────────────────────────

export interface CandidateProject {
  project_id: string;
  property_tier: PropertyTier;
  /** Prior-run stage_4_override count, used to split well/challenging within tier. */
  prior_override_count: number;
}

export interface SampleStrategy {
  /** Target counts per tier; must sum to <= n. */
  premium: number;
  standard: number;
  approachable: number;
}

/**
 * Default strata reflecting FlexMedia's market mix.
 * 17 + 25 + 8 = 50.
 */
export const DEFAULT_STRATA: SampleStrategy = {
  premium: 17,
  standard: 25,
  approachable: 8,
};

/**
 * Deterministic stratified sampler. Same `seed` + `candidates` → same output.
 * Within each tier, half the slice is "well-photographed" (prior_override_count
 * <= 2) and half is "challenging" (>= 4). Mid-band (3) projects are tie-broken
 * deterministically into the well bucket (lower override count = better shoot).
 *
 * Uses md5-like hashing via mulberry32 PRNG seeded from
 * `seed XOR fnv1a(project_id)` for stable per-project ordering across calls.
 */
export function stratifiedSample(
  candidates: CandidateProject[],
  strata: SampleStrategy,
  seed: number,
  cap = 50,
): string[] {
  const tiers: PropertyTier[] = ['premium', 'standard', 'approachable'];
  const bucketed: Record<PropertyTier, { well: CandidateProject[]; challenging: CandidateProject[] }> = {
    premium: { well: [], challenging: [] },
    standard: { well: [], challenging: [] },
    approachable: { well: [], challenging: [] },
  };
  for (const c of candidates) {
    const tierBucket = bucketed[c.property_tier];
    if (!tierBucket) continue;
    if (c.prior_override_count >= 4) tierBucket.challenging.push(c);
    else tierBucket.well.push(c);
  }

  const picked: string[] = [];
  for (const tier of tiers) {
    const target = strata[tier];
    if (target <= 0) continue;
    const half = Math.floor(target / 2);
    const wellTarget = target - half; // ceil — well gets the extra when odd
    const challengingTarget = half;

    const fromWell = pickByHash(bucketed[tier].well, seed, wellTarget);
    const fromChallenging = pickByHash(bucketed[tier].challenging, seed ^ 0x5a5a5a5a, challengingTarget);
    let combined = [...fromWell, ...fromChallenging];

    // Top up if one bucket was short — pull remaining from the other bucket.
    const shortfall = target - combined.length;
    if (shortfall > 0) {
      const fallback = bucketed[tier].well
        .concat(bucketed[tier].challenging)
        .filter((c) => !combined.find((p) => p === c.project_id));
      const extras = pickByHash(fallback, seed ^ 0x12345678, shortfall);
      combined = [...combined, ...extras];
    }

    picked.push(...combined);
  }

  return picked.slice(0, cap);
}

function pickByHash(rows: CandidateProject[], seed: number, n: number): string[] {
  if (n <= 0 || rows.length === 0) return [];
  // Stable, deterministic ordering: hash(project_id, seed)
  const ranked = rows
    .map((r) => ({ id: r.project_id, h: hashStringWithSeed(r.project_id, seed) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, n);
  return ranked.map((r) => r.id);
}

/** FNV-1a 32-bit + seed mix. Pure, deterministic, no Web Crypto required. */
export function hashStringWithSeed(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ─── Voice anchor stability ─────────────────────────────────────────────────

/**
 * Compute per-tier tone-anchor stability: 1 - distinct_anchors / total_rounds.
 * Higher = the model self-reports a more consistent voice. NULL on empty.
 */
export function voiceAnchorStability(
  rounds: Array<{ tier: PropertyTier; tone_anchor: string | null }>,
): { overall: number | null; per_tier: Record<PropertyTier, number | null> } {
  const tiers: PropertyTier[] = ['premium', 'standard', 'approachable'];
  const per_tier: Record<PropertyTier, number | null> = {
    premium: null,
    standard: null,
    approachable: null,
  };

  let overallNum = 0;
  let overallDenom = 0;

  for (const tier of tiers) {
    const slice = rounds.filter((r) => r.tier === tier);
    if (slice.length === 0) continue;
    const distinctAnchors = new Set(
      slice
        .map((r) => (r.tone_anchor ?? '').toLowerCase().trim())
        .filter((s) => s.length > 0),
    );
    if (distinctAnchors.size === 0) continue;
    // 1 distinct across N rounds = max stability (1 - 1/N → close to 1 for large N).
    // For N=1 we return 1.0 (one round, one anchor — perfectly self-consistent).
    const stability =
      slice.length === 1 ? 1 : Math.max(0, 1 - distinctAnchors.size / slice.length);
    per_tier[tier] = round4(stability);
    overallNum += stability * slice.length;
    overallDenom += slice.length;
  }

  return {
    overall: overallDenom > 0 ? round4(overallNum / overallDenom) : null,
    per_tier,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

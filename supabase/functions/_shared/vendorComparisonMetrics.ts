/**
 * vendorComparisonMetrics.ts — Wave 11.8 comparison metrics + markdown report.
 *
 * Pure functions (no I/O) consumed by `vendor-retroactive-compare` after each
 * (vendor, model) configuration completes its sweep. Computes pairwise
 * agreement metrics and renders a side-by-side markdown report.
 *
 * Per W11-8 spec Section 5 + 6:
 *   - computeAgreementMatrix     — per-slot winner agreement (returns null for v1
 *                                  unified-only mode; W11.7 will populate slot data)
 *   - computeScoreDelta          — Pearson correlation + mean abs delta on combined_score
 *                                  derived from 4 per-image scores
 *   - computeObjectOverlap       — Jaccard on key_elements arrays (today's substrate;
 *                                  W12 swaps to observed_objects canonical keys)
 *   - computeRoomTypeAgreement   — fraction of compositions where both vendors
 *                                  classified to the same room_type
 *   - generateMarkdownReport     — full multi-section report (summary, score
 *                                  distribution, disagreements, object overlap,
 *                                  room-type agreement, cost, editorial recommendation)
 *
 * Combined-score derivation: today's Pass 1 schema doesn't carry combined_score
 * directly — it's computed downstream in scoreRollup.ts from the 4 dimension
 * scores. We replicate that mean here using equal weights (0.25 each) so the
 * comparison is independent of round-specific tier_config (the harness compares
 * vendor outputs at fixed weights to isolate vendor-quality differences from
 * tier-config differences).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CompositionResult {
  group_id: string;
  stem: string;
  output: Record<string, unknown>;
}

export interface VendorRunSummary {
  label: string;
  vendor: 'anthropic' | 'google';
  model: string;
  total_cost_usd: number;
  total_elapsed_ms: number;
  composition_count: number;
  failure_count: number;
  results: CompositionResult[];
}

export interface SlotDecisionAgreement {
  /** Per-slot winner agreement rate (0-1). Null when slot data unavailable (v1 unified-only). */
  agreement_rate: number | null;
  slots: Array<{ slot_id: string; primary_winner: string | null; shadow_winner: string | null; agreed: boolean }>;
}

export interface ScoreDelta {
  /** Mean |primary_combined - shadow_combined|. Null when no overlapping compositions. */
  mean_abs_delta: number | null;
  /** Pearson correlation across overlapping compositions. Null when n<2 or zero variance. */
  correlation: number | null;
  /** Per-vendor distribution stats for the report (min/mean/max/stddev). */
  primary_distribution: ScoreDistribution;
  shadow_distribution: ScoreDistribution;
  /** Number of compositions both vendors emitted a score for. */
  overlap_count: number;
}

export interface ScoreDistribution {
  min: number | null;
  mean: number | null;
  max: number | null;
  stddev: number | null;
  count: number;
}

export interface ObjectOverlap {
  /** Average Jaccard score across overlapping compositions (0-1). */
  jaccard: number | null;
  /** Per-composition Jaccard scores (for the disagreement section). */
  per_composition: Array<{ stem: string; jaccard: number; primary_only: string[]; shadow_only: string[] }>;
}

export interface RoomTypeAgreement {
  agreement_rate: number | null;
  total: number;
  matches: number;
  disagreements: Array<{ stem: string; primary_room_type: string; shadow_room_type: string }>;
}

export interface ComparisonInputs {
  primary: VendorRunSummary;
  shadow: VendorRunSummary;
  agreement: SlotDecisionAgreement;
  score: ScoreDelta;
  obj: ObjectOverlap;
  room: RoomTypeAgreement;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

function arr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Mean of the 4 per-image dimension scores. Returns null if any dimension
 * score is missing or non-numeric — strict because the comparison is only
 * meaningful when both vendors emit all 4.
 */
function combinedScore(out: Record<string, unknown>): number | null {
  const t = num(out.technical_score);
  const l = num(out.lighting_score);
  const c = num(out.composition_score);
  const a = num(out.aesthetic_score);
  if (t === null || l === null || c === null || a === null) return null;
  return (t + l + c + a) / 4;
}

function distribution(values: number[]): ScoreDistribution {
  if (values.length === 0) {
    return { min: null, mean: null, max: null, stddev: null, count: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  let variance = 0;
  for (const v of values) variance += (v - mean) ** 2;
  variance /= values.length;
  return {
    min,
    mean,
    max,
    stddev: Math.sqrt(variance),
    count: values.length,
  };
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return null;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

function indexByGroupId(rows: CompositionResult[]): Map<string, CompositionResult> {
  const out = new Map<string, CompositionResult>();
  for (const r of rows) out.set(r.group_id, r);
  return out;
}

// ─── Slot-decision agreement ─────────────────────────────────────────────────

/**
 * For v1 (unified-only mode), neither vendor emits slot decisions — the
 * comparison schema is per-image classification. We return null here;
 * generateMarkdownReport renders this as "n/a (slot decisions not available
 * in unified comparison mode)".
 *
 * When the W11.7 unified call ships and adds slot_decisions to the response,
 * this function will compare per-slot winners by stem.
 */
export function computeAgreementMatrix(
  _primary: CompositionResult[],
  _shadow: CompositionResult[],
): SlotDecisionAgreement {
  return { agreement_rate: null, slots: [] };
}

// ─── Score delta ─────────────────────────────────────────────────────────────

export function computeScoreDelta(
  primary: CompositionResult[],
  shadow: CompositionResult[],
): ScoreDelta {
  const pIdx = indexByGroupId(primary);
  const sIdx = indexByGroupId(shadow);

  const xs: number[] = [];
  const ys: number[] = [];
  let absSum = 0;
  for (const [gid, p] of pIdx.entries()) {
    const s = sIdx.get(gid);
    if (!s) continue;
    const px = combinedScore(p.output);
    const sx = combinedScore(s.output);
    if (px === null || sx === null) continue;
    xs.push(px);
    ys.push(sx);
    absSum += Math.abs(px - sx);
  }
  const overlap_count = xs.length;
  const mean_abs_delta = overlap_count === 0 ? null : absSum / overlap_count;
  const correlation = pearson(xs, ys);
  const primary_distribution = distribution(
    Array.from(pIdx.values()).map((r) => combinedScore(r.output)).filter((v): v is number => v !== null),
  );
  const shadow_distribution = distribution(
    Array.from(sIdx.values()).map((r) => combinedScore(r.output)).filter((v): v is number => v !== null),
  );
  return { mean_abs_delta, correlation, primary_distribution, shadow_distribution, overlap_count };
}

// ─── Object overlap ──────────────────────────────────────────────────────────

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map((x) => x.toLowerCase()));
  const setB = new Set(b.map((x) => x.toLowerCase()));
  const inter = new Set<string>();
  for (const x of setA) if (setB.has(x)) inter.add(x);
  const union = new Set<string>([...setA, ...setB]);
  if (union.size === 0) return 1;
  return inter.size / union.size;
}

export function computeObjectOverlap(
  primary: CompositionResult[],
  shadow: CompositionResult[],
): ObjectOverlap {
  const pIdx = indexByGroupId(primary);
  const sIdx = indexByGroupId(shadow);

  const per_composition: ObjectOverlap['per_composition'] = [];
  let sum = 0;
  let n = 0;
  for (const [gid, p] of pIdx.entries()) {
    const s = sIdx.get(gid);
    if (!s) continue;
    const pa = arr(p.output.key_elements);
    const sa = arr(s.output.key_elements);
    const j = jaccard(pa, sa);
    sum += j;
    n += 1;
    const setA = new Set(pa.map((x) => x.toLowerCase()));
    const setB = new Set(sa.map((x) => x.toLowerCase()));
    const primary_only = pa.filter((x) => !setB.has(x.toLowerCase()));
    const shadow_only = sa.filter((x) => !setA.has(x.toLowerCase()));
    per_composition.push({ stem: p.stem, jaccard: j, primary_only, shadow_only });
  }
  return { jaccard: n === 0 ? null : sum / n, per_composition };
}

// ─── Room-type agreement ─────────────────────────────────────────────────────

export function computeRoomTypeAgreement(
  primary: CompositionResult[],
  shadow: CompositionResult[],
): RoomTypeAgreement {
  const pIdx = indexByGroupId(primary);
  const sIdx = indexByGroupId(shadow);

  let total = 0;
  let matches = 0;
  const disagreements: RoomTypeAgreement['disagreements'] = [];
  for (const [gid, p] of pIdx.entries()) {
    const s = sIdx.get(gid);
    if (!s) continue;
    const pr = str(p.output.room_type);
    const sr = str(s.output.room_type);
    if (pr === null || sr === null) continue;
    total += 1;
    if (pr === sr) matches += 1;
    else disagreements.push({ stem: p.stem, primary_room_type: pr, shadow_room_type: sr });
  }
  const agreement_rate = total === 0 ? null : matches / total;
  return { agreement_rate, total, matches, disagreements };
}

// ─── Markdown report ─────────────────────────────────────────────────────────

function fmtNumOrDash(v: number | null, digits = 3): string {
  return v === null ? '—' : v.toFixed(digits);
}

function fmtPctOrDash(v: number | null, digits = 1): string {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

function fmtCost(v: number): string {
  return `$${v.toFixed(4)}`;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Build the per-vendor distribution row used in the score-distribution table.
 */
function distRow(label: string, vendor: string, model: string, d: ScoreDistribution): string {
  return `| ${label} (${vendor}/${model}) | ${fmtNumOrDash(d.min, 2)} | ${fmtNumOrDash(d.mean, 2)} | ${fmtNumOrDash(d.max, 2)} | ${fmtNumOrDash(d.stddev, 2)} | ${d.count} |`;
}

/**
 * Editorial recommendation (auto-generated from the comparison data).
 * Heuristics per spec Section 6 step 8:
 *   - Strong correlation (>0.85) + strong room-type agreement (>0.85)
 *     → "vendors agree; default vendor unchanged"
 *   - Strong correlation but score compression delta high
 *     → "shadow vendor uses wider score range — consider as unified default"
 *   - Object overlap < 0.5
 *     → "fundamental disagreement on observed objects; manual review required"
 */
function recommendation(c: ComparisonInputs): string {
  const corr = c.score.correlation;
  const room = c.room.agreement_rate;
  const obj = c.obj.jaccard;
  const lines: string[] = [];

  if (corr === null && room === null && obj === null) {
    return '_Insufficient overlapping compositions to make a recommendation. Re-run with more samples._';
  }

  if (corr !== null) {
    if (corr > 0.85) {
      lines.push(`- Combined-score correlation **${corr.toFixed(3)}** (strong agreement on relative ranking).`);
    } else if (corr > 0.5) {
      lines.push(`- Combined-score correlation **${corr.toFixed(3)}** (moderate agreement; vendors rank compositions differently in the middle of the distribution).`);
    } else {
      lines.push(`- Combined-score correlation **${corr.toFixed(3)}** (weak agreement; vendors fundamentally disagree on what "good" looks like — manual editorial review required before any vendor switch).`);
    }
  }
  if (room !== null) {
    if (room > 0.85) lines.push(`- Room-type agreement **${(room * 100).toFixed(1)}%** (taxonomies match).`);
    else if (room > 0.5) lines.push(`- Room-type agreement **${(room * 100).toFixed(1)}%** (one vendor occasionally mislabels boundary cases — investigate disagreements below).`);
    else lines.push(`- Room-type agreement **${(room * 100).toFixed(1)}%** (taxonomies diverge substantially — schema mapping required before vendor switch).`);
  }
  if (obj !== null) {
    if (obj > 0.7) lines.push(`- Object/key-element overlap **${(obj * 100).toFixed(1)}%** (strong agreement on what's in the frame).`);
    else if (obj > 0.4) lines.push(`- Object/key-element overlap **${(obj * 100).toFixed(1)}%** (moderate agreement; vendors notice different things).`);
    else lines.push(`- Object/key-element overlap **${(obj * 100).toFixed(1)}%** (low agreement — observed-objects layer is vendor-specific, not portable).`);
  }

  // Score-compression diagnosis.
  const pStd = c.score.primary_distribution.stddev;
  const sStd = c.score.shadow_distribution.stddev;
  if (pStd !== null && sStd !== null) {
    if (sStd > pStd * 1.5) {
      lines.push(
        `- Shadow vendor uses a **${((sStd / pStd - 1) * 100).toFixed(0)}% wider** score range than primary — addresses the P1-22 compression issue if this holds.`,
      );
    } else if (pStd > sStd * 1.5) {
      lines.push(
        `- Primary vendor uses a **${((pStd / sStd - 1) * 100).toFixed(0)}% wider** score range than shadow — keep primary as the unified-call default.`,
      );
    }
  }

  // Cost note.
  const cheaper = c.shadow.total_cost_usd < c.primary.total_cost_usd ? 'shadow' : 'primary';
  const ratio =
    c.primary.total_cost_usd > 0
      ? c.shadow.total_cost_usd / c.primary.total_cost_usd
      : null;
  if (ratio !== null && ratio !== 1) {
    if (cheaper === 'shadow') {
      lines.push(
        `- Cost: shadow is **${(ratio * 100).toFixed(0)}%** of primary's cost (${(1 / Math.max(ratio, 0.0001)).toFixed(2)}× cheaper).`,
      );
    } else {
      lines.push(
        `- Cost: shadow is **${(ratio * 100).toFixed(0)}%** of primary's cost (${ratio.toFixed(2)}× more expensive).`,
      );
    }
  }

  return lines.length > 0 ? lines.join('\n') : '_No clear signal — neutral recommendation._';
}

export function generateMarkdownReport(
  round_id: string,
  comparisons: ComparisonInputs[],
): string {
  const lines: string[] = [];
  const generated = new Date().toISOString();

  lines.push(`# Vendor Comparison Report`);
  lines.push('');
  lines.push(`- **Round ID**: \`${round_id}\``);
  lines.push(`- **Generated**: ${generated}`);
  lines.push(`- **Comparisons**: ${comparisons.length} pair(s)`);
  lines.push('');

  if (comparisons.length === 0) {
    lines.push('_No comparisons provided._');
    return lines.join('\n');
  }

  for (let i = 0; i < comparisons.length; i++) {
    const c = comparisons[i];
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${i + 1}. ${c.primary.label} vs ${c.shadow.label}`);
    lines.push('');

    // 1. Summary
    lines.push(`### Summary`);
    lines.push('');
    lines.push(`| Metric | ${c.primary.label} | ${c.shadow.label} |`);
    lines.push(`|---|---|---|`);
    lines.push(`| Vendor / model | ${c.primary.vendor} / ${c.primary.model} | ${c.shadow.vendor} / ${c.shadow.model} |`);
    lines.push(`| Compositions ran | ${c.primary.composition_count} | ${c.shadow.composition_count} |`);
    lines.push(`| Failures | ${c.primary.failure_count} | ${c.shadow.failure_count} |`);
    lines.push(`| Total cost | ${fmtCost(c.primary.total_cost_usd)} | ${fmtCost(c.shadow.total_cost_usd)} |`);
    lines.push(`| Total elapsed | ${fmtElapsed(c.primary.total_elapsed_ms)} | ${fmtElapsed(c.shadow.total_elapsed_ms)} |`);
    lines.push('');

    // 2. Slot decision agreement (v1: n/a)
    lines.push(`### Slot Decision Agreement Matrix`);
    lines.push('');
    if (c.agreement.agreement_rate === null) {
      lines.push(`_Slot decisions not available in unified comparison mode (v1). Will be populated when W11.7 unified call ships._`);
    } else {
      lines.push(`Per-slot agreement rate: **${(c.agreement.agreement_rate * 100).toFixed(1)}%**`);
      lines.push('');
      if (c.agreement.slots.length > 0) {
        lines.push(`| Slot | ${c.primary.label} winner | ${c.shadow.label} winner | Agreed |`);
        lines.push(`|---|---|---|---|`);
        for (const s of c.agreement.slots) {
          lines.push(`| ${s.slot_id} | ${s.primary_winner ?? '—'} | ${s.shadow_winner ?? '—'} | ${s.agreed ? 'yes' : 'no'} |`);
        }
      }
    }
    lines.push('');

    // 3. Score distribution
    lines.push(`### Score Distribution (combined_score = mean of 4 dimension scores)`);
    lines.push('');
    lines.push(`| Vendor | min | mean | max | stddev | n |`);
    lines.push(`|---|---|---|---|---|---|`);
    lines.push(distRow(c.primary.label, c.primary.vendor, c.primary.model, c.score.primary_distribution));
    lines.push(distRow(c.shadow.label, c.shadow.vendor, c.shadow.model, c.score.shadow_distribution));
    lines.push('');
    lines.push(`- Mean absolute delta on overlapping compositions: **${fmtNumOrDash(c.score.mean_abs_delta, 3)}**`);
    lines.push(`- Pearson correlation: **${fmtNumOrDash(c.score.correlation, 3)}** (over ${c.score.overlap_count} compositions)`);
    lines.push('');

    // 4. Per-composition disagreements (room-type)
    lines.push(`### Room-Type Agreement`);
    lines.push('');
    lines.push(`- Agreement rate: **${fmtPctOrDash(c.room.agreement_rate)}** (${c.room.matches}/${c.room.total})`);
    lines.push('');
    if (c.room.disagreements.length > 0) {
      lines.push(`#### Disagreements`);
      lines.push('');
      lines.push(`| Stem | ${c.primary.label} room_type | ${c.shadow.label} room_type |`);
      lines.push(`|---|---|---|`);
      for (const d of c.room.disagreements) {
        lines.push(`| \`${d.stem}\` | ${d.primary_room_type} | ${d.shadow_room_type} |`);
      }
      lines.push('');
    }

    // 5. Object overlap
    lines.push(`### Object Detection Overlap (Jaccard on key_elements)`);
    lines.push('');
    lines.push(`- Average Jaccard: **${fmtPctOrDash(c.obj.jaccard)}**`);
    lines.push('');
    if (c.obj.per_composition.length > 0) {
      // Show only the top 10 lowest-Jaccard rows to keep the report readable.
      const sorted = [...c.obj.per_composition].sort((a, b) => a.jaccard - b.jaccard).slice(0, 10);
      lines.push(`#### Top 10 lowest-overlap compositions`);
      lines.push('');
      lines.push(`| Stem | Jaccard | ${c.primary.label} only | ${c.shadow.label} only |`);
      lines.push(`|---|---|---|---|`);
      for (const r of sorted) {
        const a = r.primary_only.length === 0 ? '—' : r.primary_only.slice(0, 6).join(', ');
        const b = r.shadow_only.length === 0 ? '—' : r.shadow_only.slice(0, 6).join(', ');
        lines.push(`| \`${r.stem}\` | ${(r.jaccard * 100).toFixed(0)}% | ${a} | ${b} |`);
      }
      lines.push('');
    }

    // 6. Cost
    lines.push(`### Cost Comparison`);
    lines.push('');
    lines.push(`| Vendor | Total USD | Per composition |`);
    lines.push(`|---|---|---|`);
    const pPer =
      c.primary.composition_count > 0 ? c.primary.total_cost_usd / c.primary.composition_count : 0;
    const sPer =
      c.shadow.composition_count > 0 ? c.shadow.total_cost_usd / c.shadow.composition_count : 0;
    lines.push(`| ${c.primary.label} | ${fmtCost(c.primary.total_cost_usd)} | ${fmtCost(pPer)} |`);
    lines.push(`| ${c.shadow.label} | ${fmtCost(c.shadow.total_cost_usd)} | ${fmtCost(sPer)} |`);
    lines.push('');

    // 7. Editorial recommendation
    lines.push(`### Editorial Recommendation`);
    lines.push('');
    lines.push(recommendation(c));
    lines.push('');
  }

  return lines.join('\n');
}

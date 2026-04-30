/**
 * vendorComparisonMetrics.ts — Wave 11.8 helpers (stub).
 *
 * Placeholder module shipped in commit 5/7 so the retroactive comparison edge
 * fn compiles cleanly. The real implementation lands in commit 6/7 with
 * agreement matrix + score delta + object overlap + room-type agreement +
 * markdown report generator.
 *
 * Replaced wholesale in commit 6.
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
  /** Per-slot winner agreement rate (0-1). */
  agreement_rate: number | null;
  /** Per-slot details for the report. */
  slots: Array<{ slot_id: string; primary_winner: string | null; shadow_winner: string | null; agreed: boolean }>;
}

export interface ScoreDelta {
  mean_abs_delta: number | null;
  correlation: number | null;
}

export interface ObjectOverlap {
  jaccard: number | null;
}

export interface RoomTypeAgreement {
  agreement_rate: number | null;
  total: number;
  matches: number;
}

export interface ComparisonInputs {
  primary: VendorRunSummary;
  shadow: VendorRunSummary;
  agreement: SlotDecisionAgreement;
  score: ScoreDelta;
  obj: ObjectOverlap;
  room: RoomTypeAgreement;
}

// ─── Stubs (real impl in commit 6/7) ─────────────────────────────────────────

export function computeAgreementMatrix(
  _primary: CompositionResult[],
  _shadow: CompositionResult[],
): SlotDecisionAgreement {
  return { agreement_rate: null, slots: [] };
}

export function computeScoreDelta(
  _primary: CompositionResult[],
  _shadow: CompositionResult[],
): ScoreDelta {
  return { mean_abs_delta: null, correlation: null };
}

export function computeObjectOverlap(
  _primary: CompositionResult[],
  _shadow: CompositionResult[],
): ObjectOverlap {
  return { jaccard: null };
}

export function computeRoomTypeAgreement(
  _primary: CompositionResult[],
  _shadow: CompositionResult[],
): RoomTypeAgreement {
  return { agreement_rate: null, total: 0, matches: 0 };
}

export function generateMarkdownReport(
  round_id: string,
  _comparisons: ComparisonInputs[],
): string {
  return `# Vendor Comparison — round ${round_id}\n\n(Stub — real report ships in W11.8 commit 6/7.)\n`;
}

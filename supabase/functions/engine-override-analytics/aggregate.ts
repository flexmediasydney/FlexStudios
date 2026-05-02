/**
 * engine-override-analytics — pure aggregation helpers (W11.6.10).
 *
 * Extracted from index.ts so we can unit-test the per-section aggregation
 * logic in isolation. No DB calls in this file.
 *
 * Each helper takes already-fetched rows and returns the shape the dashboard
 * expects. Callers pass the raw arrays out of Supabase queries.
 */

// ─── Generic helpers ────────────────────────────────────────────────────────

export function startOfDay(date: string | Date): string {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export function startOfWeek(date: string | Date): string {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

// ─── Section A — cohort grid (room_type × tier × engine_role) ─────────────

export interface CohortInputRound {
  round_id: string;
  property_tier: string | null;
  engine_mode: string | null;
}

export interface CohortInputClassification {
  round_id: string;
  group_id: string;
  room_type: string | null;
}

export interface CohortInputOverride {
  round_id: string;
  ai_proposed_group_id: string | null;
  human_action: string | null;
}

export interface CohortCell {
  room_type: string;
  property_tier: string;
  engine_role: string;
  total_proposals: number;
  total_overrides: number;
  rate: number;
  /** Round IDs feeding this cell — used for drill-through */
  round_ids: string[];
}

/**
 * Build the override-rate cohort grid. For each (room_type × tier × engine_role)
 * cell, count the AI proposals (composition_classifications joined to round)
 * and divide by overrides (shortlisting_overrides where action != 'confirm').
 *
 * mig 439: engine_role is always 'shape_d'. The legacy two-pass engine is
 * retired and no production rounds carry engine_mode='two_pass'; the
 * `engine_role` axis is preserved on the output shape for downstream UI
 * compatibility but is constant.
 */
export function buildCohortGrid(
  rounds: CohortInputRound[],
  classifications: CohortInputClassification[],
  overrides: CohortInputOverride[],
): CohortCell[] {
  const roundById = new Map<string, CohortInputRound>();
  for (const r of rounds) roundById.set(r.round_id, r);

  // Map group_id → room_type for override lookup
  const groupRoom = new Map<string, string>();
  for (const c of classifications) {
    if (c.group_id && c.room_type) groupRoom.set(c.group_id, c.room_type);
  }

  // Cell key: room_type|tier|engine_role
  const cells = new Map<string, CohortCell>();

  // Initialise totals from classifications (every classification row = 1 proposal).
  for (const c of classifications) {
    const round = roundById.get(c.round_id);
    if (!round) continue;
    const room_type = c.room_type || 'unknown';
    const property_tier = round.property_tier || 'unspecified';
    // mig 439: hardcoded — Shape D is the only engine.
    const engine_role = 'shape_d';
    const key = `${room_type}|${property_tier}|${engine_role}`;
    if (!cells.has(key)) {
      cells.set(key, {
        room_type,
        property_tier,
        engine_role,
        total_proposals: 0,
        total_overrides: 0,
        rate: 0,
        round_ids: [],
      });
    }
    const cell = cells.get(key)!;
    cell.total_proposals += 1;
    if (!cell.round_ids.includes(c.round_id)) cell.round_ids.push(c.round_id);
  }

  // Count overrides per cell. Map override → group → room_type, then look up
  // round to derive cell coordinates.
  for (const o of overrides) {
    if (o.human_action === 'confirm' || o.human_action === null) continue; // confirms aren't overrides
    const round = roundById.get(o.round_id);
    if (!round) continue;
    const room_type = (o.ai_proposed_group_id && groupRoom.get(o.ai_proposed_group_id)) || 'unknown';
    const property_tier = round.property_tier || 'unspecified';
    // mig 439: hardcoded — Shape D is the only engine.
    const engine_role = 'shape_d';
    const key = `${room_type}|${property_tier}|${engine_role}`;
    if (!cells.has(key)) {
      cells.set(key, {
        room_type,
        property_tier,
        engine_role,
        total_proposals: 0,
        total_overrides: 0,
        rate: 0,
        round_ids: [],
      });
    }
    cells.get(key)!.total_overrides += 1;
  }

  // Compute rate.
  for (const cell of cells.values()) {
    cell.rate = cell.total_proposals > 0 ? cell.total_overrides / cell.total_proposals : 0;
  }

  return Array.from(cells.values()).sort((a, b) => b.rate - a.rate);
}

// ─── Section B — override-rate timeline ───────────────────────────────────

export interface TimelineInputOverride {
  round_id: string;
  created_at: string;
  human_action: string | null;
}
export interface TimelineInputClassification {
  round_id: string;
  classified_at: string | null;
}
export interface TimelineInputStage4 {
  round_id: string;
  created_at: string;
}

export interface TimelinePoint {
  date: string;
  stage1_corrections: number;
  stage4_visual_overrides: number;
  total_proposals: number;
  override_rate: number;
}

/**
 * Build a 30-day daily timeline:
 *  - stage1_corrections = count of shortlisting_overrides where action != 'confirm'
 *  - stage4_visual_overrides = count of stage4 override rows on that day
 *  - total_proposals = composition_classifications classified that day
 *  - override_rate = (stage1+stage4) / total_proposals
 */
export function buildOverrideTimeline(
  overrides: TimelineInputOverride[],
  stage4Overrides: TimelineInputStage4[],
  classifications: TimelineInputClassification[],
  daysBack: number,
): TimelinePoint[] {
  const today = startOfDay(new Date());
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
  const cutoffKey = startOfDay(cutoff);

  const points = new Map<string, TimelinePoint>();
  // Pre-seed all days in window so we have continuous lines.
  const cur = new Date(cutoff);
  while (startOfDay(cur) <= today) {
    const k = startOfDay(cur);
    points.set(k, {
      date: k,
      stage1_corrections: 0,
      stage4_visual_overrides: 0,
      total_proposals: 0,
      override_rate: 0,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  for (const o of overrides) {
    if (o.human_action === 'confirm' || !o.created_at) continue;
    const k = startOfDay(o.created_at);
    if (k < cutoffKey) continue;
    const p = points.get(k);
    if (p) p.stage1_corrections += 1;
  }

  for (const s of stage4Overrides) {
    if (!s.created_at) continue;
    const k = startOfDay(s.created_at);
    if (k < cutoffKey) continue;
    const p = points.get(k);
    if (p) p.stage4_visual_overrides += 1;
  }

  for (const c of classifications) {
    if (!c.classified_at) continue;
    const k = startOfDay(c.classified_at);
    if (k < cutoffKey) continue;
    const p = points.get(k);
    if (p) p.total_proposals += 1;
  }

  for (const p of points.values()) {
    const totalOverrides = p.stage1_corrections + p.stage4_visual_overrides;
    p.override_rate = p.total_proposals > 0 ? totalOverrides / p.total_proposals : 0;
  }

  return Array.from(points.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Section C — tier config activation events ──────────────────────────────

export interface TierConfigEvent {
  activated_at: string;
  tier_id: string;
  version: number;
  notes: string | null;
}

export function buildTierConfigEvents(
  tierConfigs: Array<{
    activated_at: string | null;
    tier_id: string;
    version: number;
    notes: string | null;
    is_active?: boolean;
  }>,
  daysBack: number,
): TierConfigEvent[] {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - daysBack);
  return tierConfigs
    .filter((c) => c.activated_at && new Date(c.activated_at) >= cutoff)
    .map((c) => ({
      activated_at: c.activated_at!,
      tier_id: c.tier_id,
      version: c.version,
      notes: c.notes,
    }))
    .sort((a, b) => a.activated_at.localeCompare(b.activated_at));
}

// ─── Section D — top problem rounds ─────────────────────────────────────────

export interface ProblemRoundInput {
  round_id: string;
  project_id: string;
  property_tier: string | null;
  package_type: string | null;
  property_address?: string | null;
  project_title?: string | null;
}

export interface ProblemRound {
  round_id: string;
  project_id: string;
  project_title: string;
  property_address: string;
  package: string;
  tier: string;
  override_rate: number;
  total_proposals: number;
  total_overrides: number;
  common_signals: string[];
}

export function buildProblemRounds(
  rounds: ProblemRoundInput[],
  overrides: Array<{ round_id: string; human_action: string | null; primary_signal_overridden: string | null }>,
  classifications: Array<{ round_id: string }>,
  stage4Overrides: Array<{ round_id: string }>,
  topN: number = 10,
): ProblemRound[] {
  const proposalsByRound = new Map<string, number>();
  for (const c of classifications) {
    proposalsByRound.set(c.round_id, (proposalsByRound.get(c.round_id) || 0) + 1);
  }
  const overridesByRound = new Map<string, number>();
  const signalsByRound = new Map<string, Map<string, number>>();
  for (const o of overrides) {
    if (o.human_action === 'confirm') continue;
    overridesByRound.set(o.round_id, (overridesByRound.get(o.round_id) || 0) + 1);
    if (o.primary_signal_overridden) {
      if (!signalsByRound.has(o.round_id)) signalsByRound.set(o.round_id, new Map());
      const m = signalsByRound.get(o.round_id)!;
      m.set(o.primary_signal_overridden, (m.get(o.primary_signal_overridden) || 0) + 1);
    }
  }
  for (const s of stage4Overrides) {
    overridesByRound.set(s.round_id, (overridesByRound.get(s.round_id) || 0) + 1);
  }

  const rows: ProblemRound[] = rounds.map((r) => {
    const total = proposalsByRound.get(r.round_id) || 0;
    const total_overrides = overridesByRound.get(r.round_id) || 0;
    const signals = Array.from((signalsByRound.get(r.round_id) || new Map<string, number>()).entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([sig, n]) => `${sig} (${n})`);
    return {
      round_id: r.round_id,
      project_id: r.project_id,
      project_title: r.project_title || '',
      property_address: r.property_address || '',
      package: r.package_type || 'unspecified',
      tier: r.property_tier || 'unspecified',
      override_rate: total > 0 ? total_overrides / total : 0,
      total_proposals: total,
      total_overrides,
      common_signals: signals,
    };
  });

  return rows
    .filter((r) => r.total_proposals >= 3) // minimum sample size
    .sort((a, b) => b.override_rate - a.override_rate)
    .slice(0, topN);
}

// ─── Section E — reclassification log ───────────────────────────────────────

export interface ReclassRow {
  ai_room_type: string | null;
  human_room_type: string | null;
  override_source: string | null;
}

export interface ReclassPattern {
  ai_value: string;
  human_value: string;
  count: number;
  override_source: string;
}

export function buildReclassPatterns(rows: ReclassRow[]): ReclassPattern[] {
  const counts = new Map<string, ReclassPattern>();
  for (const r of rows) {
    if (!r.ai_room_type || !r.human_room_type || r.ai_room_type === r.human_room_type) continue;
    const source = r.override_source || 'unknown';
    const key = `${r.ai_room_type}→${r.human_room_type}|${source}`;
    if (!counts.has(key)) {
      counts.set(key, {
        ai_value: r.ai_room_type,
        human_value: r.human_room_type,
        count: 0,
        override_source: source,
      });
    }
    counts.get(key)!.count += 1;
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}

// ─── Section F — Stage 4 self-corrections ───────────────────────────────────

export interface Stage4Row {
  field: string | null;
  stage_1_value: string | null;
  stage_4_value: string | null;
  review_status: string | null;
  created_at: string;
}

export interface Stage4Pattern {
  field: string;
  stage1_value: string;
  stage4_value: string;
  count: number;
  approved: number;
  pending: number;
  rejected: number;
  operator_confirm_rate: number;
}

export interface Stage4Trend {
  week: string;
  count: number;
}

export function buildStage4Patterns(rows: Stage4Row[]): Stage4Pattern[] {
  const out = new Map<string, Stage4Pattern>();
  for (const r of rows) {
    const field = r.field || 'unknown';
    const s1 = r.stage_1_value || 'null';
    const s4 = r.stage_4_value || 'null';
    if (s1 === s4) continue; // not a correction
    const key = `${field}|${s1}|${s4}`;
    if (!out.has(key)) {
      out.set(key, {
        field,
        stage1_value: s1,
        stage4_value: s4,
        count: 0,
        approved: 0,
        pending: 0,
        rejected: 0,
        operator_confirm_rate: 0,
      });
    }
    const p = out.get(key)!;
    p.count += 1;
    if (r.review_status === 'approved') p.approved += 1;
    else if (r.review_status === 'rejected') p.rejected += 1;
    else if (r.review_status === 'pending_review') p.pending += 1;
  }
  for (const p of out.values()) {
    const decided = p.approved + p.rejected;
    p.operator_confirm_rate = decided > 0 ? p.approved / decided : 0;
  }
  return Array.from(out.values()).sort((a, b) => b.count - a.count);
}

export function buildStage4Trend(rows: Stage4Row[]): Stage4Trend[] {
  const byWeek = new Map<string, number>();
  for (const r of rows) {
    if (!r.created_at) continue;
    const k = startOfWeek(r.created_at);
    byWeek.set(k, (byWeek.get(k) || 0) + 1);
  }
  return Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, count]) => ({ week, count }));
}

// ─── Section G — voice tier distribution ─────────────────────────────────────

export interface VoiceTierInput {
  property_tier: string | null;
  voice_anchor_used: string | null;
}

export interface VoiceTierDistribution {
  by_tier: Record<string, number>;
  by_anchor: Record<string, number>;
  total: number;
  tier_share: Record<string, number>;
  anchor_share: Record<string, number>;
}

export function buildVoiceTierDistribution(rows: VoiceTierInput[]): VoiceTierDistribution {
  const by_tier: Record<string, number> = {};
  const by_anchor: Record<string, number> = {};
  for (const r of rows) {
    const t = r.property_tier || 'unspecified';
    by_tier[t] = (by_tier[t] || 0) + 1;
    const a = r.voice_anchor_used || 'unspecified';
    by_anchor[a] = (by_anchor[a] || 0) + 1;
  }
  const total = rows.length;
  const tier_share: Record<string, number> = {};
  for (const [k, v] of Object.entries(by_tier)) tier_share[k] = total > 0 ? v / total : 0;
  const anchor_share: Record<string, number> = {};
  for (const [k, v] of Object.entries(by_anchor)) anchor_share[k] = total > 0 ? v / total : 0;
  return { by_tier, by_anchor, total, tier_share, anchor_share };
}

// ─── Section H — canonical registry coverage ────────────────────────────────

export interface RegistryCounts {
  pending: number;
  promoted: number;
  rejected: number;
  deferred: number;
  total_canonical: number;
  total_observations: number;
  resolved_observations: number;
  resolved_pct: number;
}

export interface CandidateRow {
  status: string;
}

export function buildRegistryCounts(
  candidates: CandidateRow[],
  totalCanonical: number,
  totalObservations: number,
  resolvedObservations: number,
): RegistryCounts {
  let pending = 0;
  let promoted = 0;
  let rejected = 0;
  let deferred = 0;
  for (const c of candidates) {
    if (c.status === 'pending') pending += 1;
    else if (c.status === 'approved') promoted += 1;
    else if (c.status === 'rejected') rejected += 1;
    else if (c.status === 'deferred' || c.status === 'auto_archived') deferred += 1;
  }
  return {
    pending,
    promoted,
    rejected,
    deferred,
    total_canonical: totalCanonical,
    total_observations: totalObservations,
    resolved_observations: resolvedObservations,
    resolved_pct: totalObservations > 0 ? resolvedObservations / totalObservations : 0,
  };
}

export interface TopCandidateRow {
  proposed_canonical_label: string;
  proposed_display_name: string | null;
  observed_count: number;
  status: string;
}

export interface TopUnresolvedLabel {
  label: string;
  display_name: string;
  count: number;
}

export function buildTopUnresolvedLabels(rows: TopCandidateRow[], limit = 10): TopUnresolvedLabel[] {
  return rows
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (b.observed_count || 0) - (a.observed_count || 0))
    .slice(0, limit)
    .map((r) => ({
      label: r.proposed_canonical_label,
      display_name: r.proposed_display_name || r.proposed_canonical_label,
      count: r.observed_count || 0,
    }));
}

// ─── Section I — cost-per-stage attribution ────────────────────────────────

export interface CostInputRow {
  round_id: string;
  engine_mode: string | null;
  stage1_total_cost_usd: number | string | null;
  stage4_total_cost_usd: number | string | null;
  total_cost_usd: number | string | null;
  created_at: string;
}

export interface CostStackedPoint {
  date: string;
  stage1_usd: number;
  stage4_usd: number;
  total_usd: number;
  round_count: number;
}

export interface CostSummary {
  stage1_total: number;
  stage4_total: number;
  total: number;
  per_round_p50: number;
  per_round_p95: number;
  per_round_p99: number;
  shape_d_total: number;
  shape_d_count: number;
  total_round_count: number;
  per_round_avg: number;
}

function num(x: number | string | null | undefined): number {
  if (x == null) return 0;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}

export function buildCostStacked(rows: CostInputRow[]): CostStackedPoint[] {
  const byDay = new Map<string, CostStackedPoint>();
  for (const r of rows) {
    if (!r.created_at) continue;
    const k = startOfDay(r.created_at);
    if (!byDay.has(k)) {
      byDay.set(k, { date: k, stage1_usd: 0, stage4_usd: 0, total_usd: 0, round_count: 0 });
    }
    const p = byDay.get(k)!;
    p.stage1_usd += num(r.stage1_total_cost_usd);
    p.stage4_usd += num(r.stage4_total_cost_usd);
    p.total_usd += num(r.total_cost_usd);
    p.round_count += 1;
  }
  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function buildCostSummary(rows: CostInputRow[]): CostSummary {
  const totals = rows.map((r) => num(r.total_cost_usd)).filter((n) => n > 0).sort((a, b) => a - b);
  let stage1_total = 0;
  let stage4_total = 0;
  let total = 0;
  let shape_d_total = 0;
  let shape_d_count = 0;
  for (const r of rows) {
    stage1_total += num(r.stage1_total_cost_usd);
    stage4_total += num(r.stage4_total_cost_usd);
    total += num(r.total_cost_usd);
    if ((r.engine_mode || '').startsWith('shape_d')) {
      shape_d_total += num(r.total_cost_usd);
      shape_d_count += 1;
    }
  }
  return {
    stage1_total,
    stage4_total,
    total,
    per_round_p50: quantile(totals, 0.5),
    per_round_p95: quantile(totals, 0.95),
    per_round_p99: quantile(totals, 0.99),
    shape_d_total,
    shape_d_count,
    total_round_count: rows.length,
    per_round_avg: rows.length > 0 ? total / rows.length : 0,
  };
}

// ─── Header KPIs ─────────────────────────────────────────────────────────────

export interface KpiInput {
  total_overrides: number;
  total_proposals: number;
  review_durations_seconds: number[];
}

export interface KpiSummary {
  total_overrides: number;
  override_rate: number;
  avg_review_duration_seconds: number;
  confirmed_with_review_pct: number;
}

export function buildKpiSummary(input: KpiInput): KpiSummary {
  const durations = input.review_durations_seconds.filter((n) => n > 0);
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const longReviews = durations.filter((n) => n > 30).length;
  const confirmed_with_review_pct = input.total_overrides > 0 ? longReviews / input.total_overrides : 0;
  return {
    total_overrides: input.total_overrides,
    override_rate: input.total_proposals > 0 ? input.total_overrides / input.total_proposals : 0,
    avg_review_duration_seconds: avg,
    confirmed_with_review_pct,
  };
}

// ─── Insufficient-data gate ───────────────────────────────────────────────

/**
 * Returns true if the section should render placeholder copy due to
 * insufficient history. Matches the spec's "render placeholder if N days
 * not yet covered" requirement for time-series widgets.
 */
export function hasInsufficientHistory(
  oldestSampleIso: string | null,
  requiredDaysBack: number,
): { insufficient: boolean; days_until_ready: number } {
  if (!oldestSampleIso) return { insufficient: true, days_until_ready: requiredDaysBack };
  const oldest = new Date(oldestSampleIso);
  const now = new Date();
  const ageDays = Math.floor((now.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays >= requiredDaysBack) return { insufficient: false, days_until_ready: 0 };
  return { insufficient: true, days_until_ready: requiredDaysBack - ageDays };
}

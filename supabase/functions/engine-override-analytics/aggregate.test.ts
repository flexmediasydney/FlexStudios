/**
 * engine-override-analytics — aggregate.ts tests (W11.6.10).
 *
 * Pure unit tests for the per-section aggregation helpers. No DB / network
 * calls. Mirrors the canonical-discovery-queue/parseEventId.test.ts pattern
 * (Deno std assert).
 *
 * Coverage:
 *   1. buildCohortGrid       — Section A heatmap math
 *   2. buildOverrideTimeline — Section B daily timeline
 *   3. buildProblemRounds    — Section D top-N
 *   4. buildReclassPatterns  — Section E grouping
 *   5. buildStage4Patterns   — Section F (stage1→stage4 buckets + confirm rate)
 *   6. buildVoiceTierDistribution — Section G shares
 *   7. buildRegistryCounts   — Section H counts + resolved %
 *   8. buildTopUnresolvedLabels — Section H top-10 pending
 *   9. buildCostStacked / buildCostSummary — Section I percentiles
 *  10. buildKpiSummary       — header KPIs
 *  11. quantile / startOfDay / hasInsufficientHistory — primitives
 */

import { assertEquals, assertAlmostEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  buildCohortGrid,
  buildOverrideTimeline,
  buildProblemRounds,
  buildReclassPatterns,
  buildStage4Patterns,
  buildStage4Trend,
  buildVoiceTierDistribution,
  buildRegistryCounts,
  buildTopUnresolvedLabels,
  buildCostStacked,
  buildCostSummary,
  buildKpiSummary,
  hasInsufficientHistory,
  quantile,
  startOfDay,
} from './aggregate.ts';

// ─── Primitives ──────────────────────────────────────────────────────────

Deno.test('quantile: empty array returns 0', () => {
  assertEquals(quantile([], 0.5), 0);
});

Deno.test('quantile: single value returns that value', () => {
  assertEquals(quantile([42], 0.5), 42);
});

Deno.test('quantile: median of 5 sorted values', () => {
  assertEquals(quantile([1, 2, 3, 4, 5], 0.5), 3);
});

Deno.test('quantile: p95 of 100 ascending values', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1);
  // Linear interpolation: pos = 99 * 0.95 = 94.05 → 95 + 0.05 * (96 - 95) = 95.05
  assertAlmostEquals(quantile(arr, 0.95), 95.05, 0.001);
});

Deno.test('startOfDay: returns YYYY-MM-DD at UTC', () => {
  assertEquals(startOfDay('2026-04-29T15:23:00Z'), '2026-04-29');
});

// ─── Section A — cohort grid ──────────────────────────────────────────────

Deno.test('buildCohortGrid: empty inputs yield empty grid', () => {
  const cells = buildCohortGrid([], [], []);
  assertEquals(cells.length, 0);
});

Deno.test('buildCohortGrid: counts proposals + overrides per cell', () => {
  // mig 439: engine_role is hardcoded 'shape_d'; engine_mode input is ignored
  // for the cohort axis.
  const rounds = [
    { round_id: 'r1', property_tier: 'standard', engine_mode: 'shape_d_full' },
    { round_id: 'r2', property_tier: 'premium', engine_mode: 'shape_d_full' },
  ];
  // 5 classifications: 4 in r1/master_bedroom, 1 in r2/kitchen
  const classifications = [
    { round_id: 'r1', group_id: 'g1', room_type: 'master_bedroom' },
    { round_id: 'r1', group_id: 'g2', room_type: 'master_bedroom' },
    { round_id: 'r1', group_id: 'g3', room_type: 'master_bedroom' },
    { round_id: 'r1', group_id: 'g4', room_type: 'master_bedroom' },
    { round_id: 'r2', group_id: 'g5', room_type: 'kitchen' },
  ];
  // 1 override on r1/g2 (rejected) → master_bedroom × standard × shape_d
  const overrides = [
    { round_id: 'r1', ai_proposed_group_id: 'g2', human_action: 'reject' },
  ];
  const cells = buildCohortGrid(rounds, classifications, overrides);
  // Find cell for master_bedroom × standard × shape_d
  const c = cells.find(
    (c) => c.room_type === 'master_bedroom' && c.property_tier === 'standard' && c.engine_role === 'shape_d',
  );
  assertEquals(c?.total_proposals, 4);
  assertEquals(c?.total_overrides, 1);
  assertAlmostEquals(c?.rate ?? 0, 0.25, 0.001);
});

Deno.test('buildCohortGrid: confirms are NOT counted as overrides', () => {
  const rounds = [{ round_id: 'r1', property_tier: 'standard', engine_mode: 'shape_d_full' }];
  const classifications = [
    { round_id: 'r1', group_id: 'g1', room_type: 'kitchen' },
    { round_id: 'r1', group_id: 'g2', room_type: 'kitchen' },
  ];
  const overrides = [
    { round_id: 'r1', ai_proposed_group_id: 'g1', human_action: 'confirm' },
    { round_id: 'r1', ai_proposed_group_id: 'g2', human_action: 'reject' },
  ];
  const cells = buildCohortGrid(rounds, classifications, overrides);
  const c = cells.find((c) => c.room_type === 'kitchen');
  assertEquals(c?.total_overrides, 1);
});

Deno.test('buildCohortGrid: 100 rounds yields plausible cell distribution', () => {
  // mig 439: engine_role hardcoded; only property_tier × room_type axes vary.
  const rounds = Array.from({ length: 100 }, (_, i) => ({
    round_id: `r${i}`,
    property_tier: i % 2 === 0 ? 'standard' : 'premium',
    engine_mode: 'shape_d_full',
  }));
  // Each round has 5 classifications across 2 room types
  const classifications: Array<{ round_id: string; group_id: string; room_type: string }> = [];
  for (const r of rounds) {
    for (let j = 0; j < 5; j++) {
      classifications.push({
        round_id: r.round_id,
        group_id: `${r.round_id}_g${j}`,
        room_type: j < 3 ? 'kitchen' : 'master_bedroom',
      });
    }
  }
  // 10% override rate uniformly
  const overrides = classifications
    .filter((_, i) => i % 10 === 0)
    .map((c) => ({ round_id: c.round_id, ai_proposed_group_id: c.group_id, human_action: 'reject' }));

  const cells = buildCohortGrid(rounds, classifications, overrides);
  const totalProposals = cells.reduce((s, c) => s + c.total_proposals, 0);
  const totalOverrides = cells.reduce((s, c) => s + c.total_overrides, 0);
  assertEquals(totalProposals, 500);
  assertEquals(totalOverrides, 50);
  assertAlmostEquals(totalOverrides / totalProposals, 0.1, 0.01);
  // mig 439: engine_role axis collapsed to a single value ('shape_d').
  // Cells: kitchen × {standard,premium} × shape_d = 2; same for
  // master_bedroom = 2. Total 4 cells.
  assertEquals(cells.length, 4);
});

// ─── Section B — timeline ──────────────────────────────────────────────────

Deno.test('buildOverrideTimeline: includes all days in window even with no data', () => {
  const points = buildOverrideTimeline([], [], [], 7);
  assertEquals(points.length >= 7, true);
  for (const p of points) {
    assertEquals(p.stage1_corrections, 0);
    assertEquals(p.stage4_visual_overrides, 0);
    assertEquals(p.override_rate, 0);
  }
});

Deno.test('buildOverrideTimeline: rate = (s1 + s4) / proposals', () => {
  const today = new Date();
  const todayStr = today.toISOString();
  const overrides = [
    { round_id: 'r1', created_at: todayStr, human_action: 'reject' },
    { round_id: 'r1', created_at: todayStr, human_action: 'reject' },
  ];
  const stage4 = [{ round_id: 'r1', created_at: todayStr }];
  // 10 classifications today → 3/10 = 30%
  const classifications = Array.from({ length: 10 }, () => ({ round_id: 'r1', classified_at: todayStr }));
  const points = buildOverrideTimeline(overrides, stage4, classifications, 7);
  const todayPt = points.find((p) => p.date === startOfDay(today));
  assertEquals(todayPt?.stage1_corrections, 2);
  assertEquals(todayPt?.stage4_visual_overrides, 1);
  assertEquals(todayPt?.total_proposals, 10);
  assertAlmostEquals(todayPt?.override_rate ?? 0, 0.3, 0.001);
});

// ─── Section D — top problem rounds ───────────────────────────────────────

Deno.test('buildProblemRounds: filters out small-sample rounds', () => {
  const rounds = [
    { round_id: 'r1', project_id: 'p1', property_tier: 'standard', package_type: 'Gold' },
    { round_id: 'r2', project_id: 'p2', property_tier: 'standard', package_type: 'Gold' },
  ];
  // r1 has 2 classifications, r2 has 10
  const classifications = [
    { round_id: 'r1' },
    { round_id: 'r1' },
    ...Array.from({ length: 10 }, () => ({ round_id: 'r2' })),
  ];
  const overrides = [
    { round_id: 'r1', human_action: 'reject', primary_signal_overridden: 'lighting' },
    { round_id: 'r2', human_action: 'reject', primary_signal_overridden: 'composition' },
  ];
  const out = buildProblemRounds(rounds, overrides, classifications, []);
  // r1 has only 2 proposals → filtered out by min sample size of 3
  assertEquals(out.length, 1);
  assertEquals(out[0].round_id, 'r2');
});

Deno.test('buildProblemRounds: ranks by override_rate desc', () => {
  const rounds = [
    { round_id: 'r1', project_id: 'p1', property_tier: 'standard', package_type: 'Gold' },
    { round_id: 'r2', project_id: 'p2', property_tier: 'standard', package_type: 'Gold' },
    { round_id: 'r3', project_id: 'p3', property_tier: 'standard', package_type: 'Gold' },
  ];
  // r1: 10 props, 5 overrides (50%); r2: 10 props, 1 override (10%); r3: 10 props, 8 overrides (80%)
  const classifications = [
    ...Array.from({ length: 10 }, () => ({ round_id: 'r1' })),
    ...Array.from({ length: 10 }, () => ({ round_id: 'r2' })),
    ...Array.from({ length: 10 }, () => ({ round_id: 'r3' })),
  ];
  const overrides = [
    ...Array.from({ length: 5 }, () => ({ round_id: 'r1', human_action: 'reject', primary_signal_overridden: null })),
    ...Array.from({ length: 1 }, () => ({ round_id: 'r2', human_action: 'reject', primary_signal_overridden: null })),
    ...Array.from({ length: 8 }, () => ({ round_id: 'r3', human_action: 'reject', primary_signal_overridden: null })),
  ];
  const out = buildProblemRounds(rounds, overrides, classifications, []);
  assertEquals(out[0].round_id, 'r3');
  assertEquals(out[1].round_id, 'r1');
  assertEquals(out[2].round_id, 'r2');
});

Deno.test('buildProblemRounds: includes stage4 overrides in count', () => {
  const rounds = [{ round_id: 'r1', project_id: 'p1', property_tier: 'standard', package_type: 'Gold' }];
  const classifications = Array.from({ length: 10 }, () => ({ round_id: 'r1' }));
  // 1 stage1 override + 2 stage4 → 3/10 = 30%
  const out = buildProblemRounds(
    rounds,
    [{ round_id: 'r1', human_action: 'reject', primary_signal_overridden: null }],
    classifications,
    [{ round_id: 'r1' }, { round_id: 'r1' }],
  );
  assertEquals(out[0].total_overrides, 3);
  assertAlmostEquals(out[0].override_rate, 0.3, 0.001);
});

// ─── Section E — reclassification patterns ───────────────────────────────

Deno.test('buildReclassPatterns: groups by (ai → human, source)', () => {
  const rows = [
    { ai_room_type: 'exterior_front', human_room_type: 'exterior_rear', override_source: 'stage1_correction' },
    { ai_room_type: 'exterior_front', human_room_type: 'exterior_rear', override_source: 'stage1_correction' },
    { ai_room_type: 'exterior_front', human_room_type: 'exterior_rear', override_source: 'stage4_visual_override' },
    { ai_room_type: 'kitchen', human_room_type: 'kitchen', override_source: 'stage4_visual_override' }, // same → ignored
  ];
  const patterns = buildReclassPatterns(rows);
  assertEquals(patterns.length, 2);
  assertEquals(patterns[0].count, 2);
  assertEquals(patterns[0].override_source, 'stage1_correction');
});

// ─── Section F — Stage 4 self-corrections ────────────────────────────────

Deno.test('buildStage4Patterns: confirm rate from approved/rejected', () => {
  const rows = [
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'approved', created_at: '2026-04-25T00:00:00Z' },
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'approved', created_at: '2026-04-25T00:00:00Z' },
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'rejected', created_at: '2026-04-25T00:00:00Z' },
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'pending_review', created_at: '2026-04-25T00:00:00Z' },
  ];
  const patterns = buildStage4Patterns(rows);
  assertEquals(patterns[0].count, 4);
  // 2/3 decided are approved → 0.667
  assertAlmostEquals(patterns[0].operator_confirm_rate, 2 / 3, 0.001);
});

Deno.test('buildStage4Patterns: filters out non-corrections (s1 == s4)', () => {
  const rows = [
    { field: 'room_type', stage_1_value: 'kitchen', stage_4_value: 'kitchen', review_status: 'approved', created_at: '2026-04-25' },
  ];
  const patterns = buildStage4Patterns(rows);
  assertEquals(patterns.length, 0);
});

Deno.test('buildStage4Trend: groups counts by week', () => {
  const rows = [
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'approved', created_at: '2026-04-25T00:00:00Z' },
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'approved', created_at: '2026-04-26T00:00:00Z' },
    { field: 'room_type', stage_1_value: 'A', stage_4_value: 'B', review_status: 'approved', created_at: '2026-05-01T00:00:00Z' },
  ];
  const trend = buildStage4Trend(rows);
  assertEquals(trend.length >= 1, true);
});

// ─── Section G — voice tier ───────────────────────────────────────────────

Deno.test('buildVoiceTierDistribution: counts and shares', () => {
  const rows = [
    { property_tier: 'premium', voice_anchor_used: 'tier_preset' },
    { property_tier: 'premium', voice_anchor_used: 'override' },
    { property_tier: 'standard', voice_anchor_used: 'tier_preset' },
  ];
  const dist = buildVoiceTierDistribution(rows);
  assertEquals(dist.total, 3);
  assertEquals(dist.by_tier.premium, 2);
  assertEquals(dist.by_tier.standard, 1);
  assertAlmostEquals(dist.tier_share.premium, 2 / 3, 0.001);
  assertEquals(dist.by_anchor.tier_preset, 2);
  assertEquals(dist.by_anchor.override, 1);
});

// ─── Section H — canonical registry ──────────────────────────────────────

Deno.test('buildRegistryCounts: maps DB statuses to UI counts', () => {
  const candidates = [
    { status: 'pending' },
    { status: 'pending' },
    { status: 'approved' },
    { status: 'rejected' },
    { status: 'auto_archived' }, // counts as deferred
  ];
  const c = buildRegistryCounts(candidates, 191, 594, 400);
  assertEquals(c.pending, 2);
  assertEquals(c.promoted, 1);
  assertEquals(c.rejected, 1);
  assertEquals(c.deferred, 1);
  assertEquals(c.total_canonical, 191);
  assertAlmostEquals(c.resolved_pct, 400 / 594, 0.001);
});

Deno.test('buildTopUnresolvedLabels: pending only, top-N by count', () => {
  const rows = [
    { proposed_canonical_label: 'a', proposed_display_name: 'A', observed_count: 50, status: 'pending' },
    { proposed_canonical_label: 'b', proposed_display_name: 'B', observed_count: 30, status: 'approved' }, // skipped
    { proposed_canonical_label: 'c', proposed_display_name: 'C', observed_count: 100, status: 'pending' },
  ];
  const top = buildTopUnresolvedLabels(rows, 5);
  assertEquals(top.length, 2);
  assertEquals(top[0].label, 'c');
  assertEquals(top[0].count, 100);
});

// ─── Section I — cost ──────────────────────────────────────────────────────

Deno.test('buildCostStacked: aggregates per day', () => {
  const rows = [
    {
      round_id: 'r1',
      engine_mode: 'shape_d_full',
      stage1_total_cost_usd: '1.00',
      stage4_total_cost_usd: '0.50',
      total_cost_usd: '1.50',
      created_at: '2026-04-29T10:00:00Z',
    },
    {
      round_id: 'r2',
      engine_mode: 'shape_d_full',
      stage1_total_cost_usd: '2.00',
      stage4_total_cost_usd: '1.00',
      total_cost_usd: '3.00',
      created_at: '2026-04-29T15:00:00Z',
    },
  ];
  const stacked = buildCostStacked(rows);
  assertEquals(stacked.length, 1);
  assertEquals(stacked[0].date, '2026-04-29');
  assertAlmostEquals(stacked[0].stage1_usd, 3.0, 0.001);
  assertAlmostEquals(stacked[0].stage4_usd, 1.5, 0.001);
  assertAlmostEquals(stacked[0].total_usd, 4.5, 0.001);
  assertEquals(stacked[0].round_count, 2);
});

Deno.test('buildCostSummary: percentile math', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    round_id: `r${i}`,
    engine_mode: 'shape_d_full',
    stage1_total_cost_usd: 1.0,
    stage4_total_cost_usd: 1.0,
    total_cost_usd: i + 1, // 1..100
    created_at: '2026-04-29T10:00:00Z',
  }));
  const sum = buildCostSummary(rows);
  assertAlmostEquals(sum.per_round_p50, 50.5, 0.5);
  assertAlmostEquals(sum.per_round_p95, 95.05, 0.1);
  assertAlmostEquals(sum.per_round_p99, 99.01, 0.1);
  assertEquals(sum.shape_d_count, 100);
  assertEquals(sum.total_round_count, 100);
});

Deno.test('buildCostSummary: empty rows returns zero summary', () => {
  const sum = buildCostSummary([]);
  assertEquals(sum.total, 0);
  assertEquals(sum.per_round_p50, 0);
  assertEquals(sum.total_round_count, 0);
});

// ─── KPI summary ──────────────────────────────────────────────────────────

Deno.test('buildKpiSummary: all four KPIs', () => {
  const k = buildKpiSummary({
    total_overrides: 10,
    total_proposals: 100,
    review_durations_seconds: [5, 15, 35, 60, 120],
  });
  assertEquals(k.total_overrides, 10);
  assertAlmostEquals(k.override_rate, 0.1, 0.001);
  assertAlmostEquals(k.avg_review_duration_seconds, (5 + 15 + 35 + 60 + 120) / 5, 0.001);
  // 3 reviews >30s (35, 60, 120) / 10 overrides
  assertAlmostEquals(k.confirmed_with_review_pct, 0.3, 0.001);
});

// ─── Insufficient-data gate ─────────────────────────────────────────────

Deno.test('hasInsufficientHistory: null sample returns insufficient with full days', () => {
  const r = hasInsufficientHistory(null, 30);
  assertEquals(r.insufficient, true);
  assertEquals(r.days_until_ready, 30);
});

Deno.test('hasInsufficientHistory: sufficient when oldest sample older than required', () => {
  const old = new Date();
  old.setDate(old.getDate() - 60);
  const r = hasInsufficientHistory(old.toISOString(), 30);
  assertEquals(r.insufficient, false);
  assertEquals(r.days_until_ready, 0);
});

Deno.test('hasInsufficientHistory: returns days remaining when not yet ready', () => {
  const old = new Date();
  old.setDate(old.getDate() - 5);
  const r = hasInsufficientHistory(old.toISOString(), 30);
  assertEquals(r.insufficient, true);
  assertEquals(r.days_until_ready, 25);
});

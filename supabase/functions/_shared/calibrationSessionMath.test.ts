/**
 * Wave 14 — calibration SESSION math unit tests.
 *
 * Run:
 *   deno test --no-check --allow-all supabase/functions/_shared/calibrationSessionMath.test.ts
 *
 * Tests cover:
 *   1. classifyAgreement: match vs disagree
 *   2. buildCalibrationDecisions: full row shape + ordering + provenance stamping
 *   3. pairSlotsForDiff: slot-anchored pairing + editor-only stems + AI no_eligible
 *   4. validateSubmittedDecisions: disagree rows require reasoning + signal_diff
 *   5. rankSignalsByMarketImpact: market_frequency × count ordering
 *   6. Hand-built fixture: end-to-end (build → validate → rank) on a 50-project-style fixture
 *
 * All synchronous, no network or DB access.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildCalibrationDecisions,
  classifyAgreement,
  pairSlotsForDiff,
  rankSignalsByMarketImpact,
  validateSubmittedDecisions,
  type CalibrationDiffInput,
  type DisagreementWithMarketFreq,
  type SlotPairing,
} from './calibrationSessionMath.ts';

// ─── Test 1: classifyAgreement ─────────────────────────────────────────────

Deno.test('classifyAgreement: identical decisions → match; different → disagree', () => {
  assertEquals(classifyAgreement('shortlisted', 'shortlisted'), 'match');
  assertEquals(classifyAgreement('rejected', 'rejected'), 'match');
  assertEquals(classifyAgreement('no_eligible', 'no_eligible'), 'match');
  assertEquals(classifyAgreement('unranked', 'unranked'), 'match');
  assertEquals(classifyAgreement('shortlisted', 'rejected'), 'disagree');
  assertEquals(classifyAgreement('rejected', 'shortlisted'), 'disagree');
  assertEquals(classifyAgreement('no_eligible', 'shortlisted'), 'disagree');
});

// ─── Test 2: buildCalibrationDecisions ─────────────────────────────────────

Deno.test('buildCalibrationDecisions: produces ordered rows with full provenance', () => {
  const input: CalibrationDiffInput = {
    calibration_session_id: 'sess-1',
    project_id: 'proj-1',
    round_id: 'round-1',
    engine_version: 'wave-8-v1',
    tier_config_version: 3,
    slots: [
      // Out of order on purpose — buildCalibrationDecisions should sort.
      {
        slot_id: 'kitchen_main',
        stem: 'IMG_017',
        ai_decision: 'shortlisted',
        editor_decision: 'rejected',
        ai_score: 8.4,
        ai_per_dim_scores: { technical: 8.5, lighting: 8.7, composition: 8.2, aesthetic: 8.0 },
        ai_analysis_excerpt: 'Strong frontal kitchen showing the island; clean composition.',
      },
      {
        slot_id: 'exterior_front_hero',
        stem: 'IMG_002',
        ai_decision: 'shortlisted',
        editor_decision: 'shortlisted',
        ai_score: 9.1,
      },
    ],
  };
  const rows = buildCalibrationDecisions(input);
  // Sorted by slot_id alphabetically: exterior_* then kitchen_*.
  assertEquals(rows.length, 2);
  assertEquals(rows[0].slot_id, 'exterior_front_hero');
  assertEquals(rows[1].slot_id, 'kitchen_main');
  // Row 0: match (both shortlisted). Row 1: disagree (ai shortlisted, editor rejected).
  assertEquals(rows[0].agreement, 'match');
  assertEquals(rows[1].agreement, 'disagree');
  // Provenance stamped on every row.
  assertEquals(rows[0].engine_version, 'wave-8-v1');
  assertEquals(rows[0].tier_config_version, 3);
  assertEquals(rows[1].engine_version, 'wave-8-v1');
  // Editor reasoning fields are null at AI-build time (filled in later by submit-decisions).
  assertEquals(rows[1].editor_reasoning, null);
  assertEquals(rows[1].primary_signal_diff, null);
  assertEquals(rows[1].reasoning_categories, null);
  // AI context preserved.
  assertEquals(rows[1].ai_score, 8.4);
  assertEquals(rows[1].ai_per_dim_scores?.aesthetic, 8.0);
  assertEquals(
    rows[1].ai_analysis_excerpt,
    'Strong frontal kitchen showing the island; clean composition.',
  );
});

// ─── Test 3: pairSlotsForDiff ──────────────────────────────────────────────

Deno.test('pairSlotsForDiff: slot-anchored pairing handles editor-only picks + no_eligible', () => {
  const pairings = pairSlotsForDiff({
    ai_slot_assignments: {
      exterior_front_hero: 'IMG_002',
      kitchen_main: 'IMG_017',
      master_bedroom_hero: 'IMG_034',
      // AI couldn't fill this slot (no eligible photo).
      balcony_terrace_hero: null,
    },
    ai_per_stem_context: {
      IMG_002: { ai_score: 9.1 },
      IMG_017: { ai_score: 8.4 },
      IMG_034: { ai_score: 7.8 },
    },
    // Editor agrees on exterior + bedroom; disagrees on kitchen (picks IMG_018);
    // also picks IMG_088 for balcony (a slot the AI flagged no_eligible).
    editor_picked_stems: ['IMG_002', 'IMG_018', 'IMG_034', 'IMG_088'],
    editor_slot_intent: {
      IMG_018: 'kitchen_main',
      IMG_088: 'balcony_terrace_hero',
    },
  });
  // 4 AI slot rows + 2 editor-only rows for IMG_018 (kitchen_main alt) and IMG_088 (balcony).
  assertEquals(pairings.length, 6);
  const bySlotStem = new Map<string, SlotPairing>();
  for (const p of pairings) bySlotStem.set(`${p.slot_id}::${p.stem ?? 'NULL'}`, p);
  // exterior matched on IMG_002.
  assertEquals(bySlotStem.get('exterior_front_hero::IMG_002')?.ai_decision, 'shortlisted');
  assertEquals(bySlotStem.get('exterior_front_hero::IMG_002')?.editor_decision, 'shortlisted');
  // kitchen_main: AI shortlisted IMG_017 but editor rejected (didn't pick it).
  assertEquals(bySlotStem.get('kitchen_main::IMG_017')?.ai_decision, 'shortlisted');
  assertEquals(bySlotStem.get('kitchen_main::IMG_017')?.editor_decision, 'rejected');
  // kitchen_main also has IMG_018 row (editor picked, AI didn't shortlist).
  assertEquals(bySlotStem.get('kitchen_main::IMG_018')?.ai_decision, 'rejected');
  assertEquals(bySlotStem.get('kitchen_main::IMG_018')?.editor_decision, 'shortlisted');
  // balcony: AI no_eligible, editor picked IMG_088 → second row for IMG_088.
  assertEquals(bySlotStem.get('balcony_terrace_hero::NULL')?.ai_decision, 'no_eligible');
  assertEquals(bySlotStem.get('balcony_terrace_hero::IMG_088')?.editor_decision, 'shortlisted');
  assertEquals(bySlotStem.get('balcony_terrace_hero::IMG_088')?.ai_decision, 'rejected');
});

// ─── Test 4: validateSubmittedDecisions ────────────────────────────────────

Deno.test('validateSubmittedDecisions: disagree rows must have reasoning + primary_signal_diff', () => {
  // Match rows pass without reasoning.
  const allMatch = validateSubmittedDecisions([
    { slot_id: 'exterior_front_hero', agreement: 'match', editor_reasoning: null, primary_signal_diff: null },
    { slot_id: 'kitchen_main', agreement: 'match', editor_reasoning: '', primary_signal_diff: '' },
  ]);
  assertEquals(allMatch.ok, true);
  assertEquals(allMatch.errors.length, 0);

  // Disagree row missing both fields → 2 errors.
  const empty = validateSubmittedDecisions([
    { slot_id: 'kitchen_main', agreement: 'disagree', editor_reasoning: '', primary_signal_diff: null },
  ]);
  assertEquals(empty.ok, false);
  assertEquals(empty.errors.length, 2);

  // Disagree row with both fields filled → ok.
  const filled = validateSubmittedDecisions([
    {
      slot_id: 'kitchen_main',
      agreement: 'disagree',
      editor_reasoning: 'AI under-weighted clutter',
      primary_signal_diff: 'aesthetic',
    },
  ]);
  assertEquals(filled.ok, true);

  // Disagree row with whitespace-only reasoning → fails.
  const whitespace = validateSubmittedDecisions([
    {
      slot_id: 'kitchen_main',
      agreement: 'disagree',
      editor_reasoning: '   ',
      primary_signal_diff: 'aesthetic',
    },
  ]);
  assertEquals(whitespace.ok, false);
});

// ─── Test 5: rankSignalsByMarketImpact ─────────────────────────────────────

Deno.test('rankSignalsByMarketImpact: market_frequency × count ranking; nulls last', () => {
  // Hand-built fixture mirroring the W14.5 join shape:
  //   - "kitchen_clutter" appears 5× and is highly market-frequent (200) → priority_score=1000
  //   - "window_blowout_area" appears 8× but lower market-frequency (40) → priority_score=320
  //   - "agent_preference" appears 3× with NULL market_frequency (non-canonical) → 0
  //   - "exterior_lifestyle_mood" appears 2× with high market_frequency (180) → 360
  const rows: DisagreementWithMarketFreq[] = [
    ...Array(5).fill(0).map((_, i) => ({
      decision_id: `dec-kc-${i}`,
      slot_id: 'kitchen_main',
      primary_signal_diff: 'kitchen_clutter',
      market_frequency: 200,
      canonical_display_name: 'kitchen_clutter',
      editor_reasoning: `clutter case ${i}`,
    })),
    ...Array(8).fill(0).map((_, i) => ({
      decision_id: `dec-wb-${i}`,
      slot_id: 'living_room_hero',
      primary_signal_diff: 'window_blowout_area',
      market_frequency: 40,
      canonical_display_name: 'window_blowout_area',
      editor_reasoning: `blowout case ${i}`,
    })),
    ...Array(3).fill(0).map((_, i) => ({
      decision_id: `dec-ap-${i}`,
      slot_id: 'kitchen_main',
      primary_signal_diff: 'agent_preference',
      market_frequency: null,
      canonical_display_name: null,
      editor_reasoning: `agent pref ${i}`,
    })),
    ...Array(2).fill(0).map((_, i) => ({
      decision_id: `dec-em-${i}`,
      slot_id: 'exterior_front_hero',
      primary_signal_diff: 'exterior_lifestyle_mood',
      market_frequency: 180,
      canonical_display_name: 'exterior_lifestyle_mood',
      editor_reasoning: `mood case ${i}`,
    })),
  ];
  const ranked = rankSignalsByMarketImpact(rows);
  assertEquals(ranked.length, 4);
  // kitchen_clutter at top: 200×5=1000
  assertEquals(ranked[0].primary_signal_diff, 'kitchen_clutter');
  assertEquals(ranked[0].priority_score, 1000);
  assertEquals(ranked[0].count, 5);
  // exterior_lifestyle_mood second: 180×2=360
  assertEquals(ranked[1].primary_signal_diff, 'exterior_lifestyle_mood');
  assertEquals(ranked[1].priority_score, 360);
  // window_blowout_area third: 40×8=320
  assertEquals(ranked[2].primary_signal_diff, 'window_blowout_area');
  assertEquals(ranked[2].priority_score, 320);
  // agent_preference last: NULL market_frequency → priority_score 0
  assertEquals(ranked[3].primary_signal_diff, 'agent_preference');
  assertEquals(ranked[3].priority_score, 0);
  assertEquals(ranked[3].market_frequency, null);
  // example_reasonings clipped to default 3.
  assertEquals(ranked[0].example_reasonings.length, 3);
  assertEquals(ranked[2].example_reasonings.length, 3);
});

// ─── Test 6: end-to-end pipeline ───────────────────────────────────────────

Deno.test('end-to-end: pair slots → build decisions → validate → rank by market_frequency', () => {
  // Synthetic 3-project mini-session, each project has 5 slots, ~30%
  // disagreement rate (mirrors expected production shape: ~250-500 rows
  // across a 50-project session).
  const sessionId = 'sess-e2e';
  const allRows: ReturnType<typeof buildCalibrationDecisions> = [];
  const projectSpecs = [
    { project_id: 'p1', round_id: 'r1' },
    { project_id: 'p2', round_id: 'r2' },
    { project_id: 'p3', round_id: 'r3' },
  ];
  for (const spec of projectSpecs) {
    const pairings = pairSlotsForDiff({
      ai_slot_assignments: {
        exterior_front_hero: 'IMG_001',
        kitchen_main: 'IMG_017',
        master_bedroom_hero: 'IMG_034',
        bathroom_main: 'IMG_046',
        living_room_hero: 'IMG_058',
      },
      ai_per_stem_context: {
        IMG_001: { ai_score: 9.0 },
        IMG_017: { ai_score: 8.2 },
        IMG_034: { ai_score: 7.5 },
        IMG_046: { ai_score: 8.0 },
        IMG_058: { ai_score: 8.1 },
      },
      // p1 disagrees on kitchen+bathroom; p2 disagrees on living room only;
      // p3 disagrees on kitchen only. ~30% disagreement.
      editor_picked_stems:
        spec.project_id === 'p1'
          ? ['IMG_001', 'IMG_018', 'IMG_034', 'IMG_047', 'IMG_058'] // kitchen+bath swapped
          : spec.project_id === 'p2'
            ? ['IMG_001', 'IMG_017', 'IMG_034', 'IMG_046', 'IMG_059'] // living room swapped
            : ['IMG_001', 'IMG_018', 'IMG_034', 'IMG_046', 'IMG_058'], // kitchen swapped
      editor_slot_intent: {
        IMG_018: 'kitchen_main',
        IMG_047: 'bathroom_main',
        IMG_059: 'living_room_hero',
      },
    });
    const decisions = buildCalibrationDecisions({
      calibration_session_id: sessionId,
      project_id: spec.project_id,
      round_id: spec.round_id,
      engine_version: 'wave-8-v1',
      tier_config_version: 3,
      slots: pairings,
    });
    allRows.push(...decisions);
  }
  // Sanity: 3 projects × ~5 AI slots + ~1-2 editor-only stems each ≈ 18-21 rows.
  assert(allRows.length >= 15, `expected at least 15 rows, got ${allRows.length}`);

  // Disagreements only:
  const disagreeRows = allRows.filter((r) => r.agreement === 'disagree');
  // p1: 4 disagreements (kitchen ai, kitchen editor, bathroom ai, bathroom editor)
  // p2: 2 disagreements (living ai, living editor)
  // p3: 2 disagreements (kitchen ai, kitchen editor)
  // Total: 8.
  assertEquals(disagreeRows.length, 8);

  // Stamp editor_reasoning + primary_signal_diff on disagrees so validation passes,
  // then run the rank step against a synthetic market_frequency join.
  const stamped: DisagreementWithMarketFreq[] = disagreeRows.map((r, i) => ({
    decision_id: `${r.calibration_session_id}-${r.project_id}-${r.slot_id}-${i}`,
    slot_id: r.slot_id,
    primary_signal_diff:
      r.slot_id === 'kitchen_main'
        ? 'kitchen_clutter'
        : r.slot_id === 'bathroom_main'
          ? 'mirror_streak'
          : 'window_blowout_area',
    market_frequency:
      r.slot_id === 'kitchen_main' ? 220 : r.slot_id === 'bathroom_main' ? 60 : 95,
    canonical_display_name: null,
    editor_reasoning: `editor reason for ${r.slot_id}`,
  }));
  const ranked = rankSignalsByMarketImpact(stamped);
  // Top should be kitchen_clutter (highest market_frequency × highest count).
  // p1+p3 both swap kitchen → 4 disagreements (2 from p1, 2 from p3). 220×4=880.
  // window_blowout_area: p2 has 2 disagreements. 95×2=190.
  // mirror_streak: p1 has 2 disagreements. 60×2=120.
  assertEquals(ranked[0].primary_signal_diff, 'kitchen_clutter');
  assertEquals(ranked[0].priority_score, 880);
  assertEquals(ranked[0].count, 4);
  // Validation: stamped editor_reasoning + primary_signal_diff → all pass.
  const validation = validateSubmittedDecisions(
    disagreeRows.map((r, i) => ({
      slot_id: r.slot_id,
      agreement: 'disagree' as const,
      editor_reasoning: `reason ${i}`,
      primary_signal_diff: 'aesthetic',
    })),
  );
  assertEquals(validation.ok, true);
});

// ─── Test 7: validation rejects empty disagreement reasoning ──────────────

Deno.test('validation rejects when half the disagreements are missing reasoning', () => {
  const rows = [
    { slot_id: 'kitchen_main', agreement: 'disagree' as const, editor_reasoning: 'good reason', primary_signal_diff: 'aesthetic' },
    { slot_id: 'living_room_hero', agreement: 'disagree' as const, editor_reasoning: null, primary_signal_diff: null },
    { slot_id: 'bathroom_main', agreement: 'match' as const, editor_reasoning: null, primary_signal_diff: null },
  ];
  const result = validateSubmittedDecisions(rows);
  assertEquals(result.ok, false);
  assertEquals(result.errors.length, 2);
  assert(result.errors[0].includes('living_room_hero'));
  assertNotEquals(result.errors.findIndex((e) => e.includes('bathroom_main')), 0);
});

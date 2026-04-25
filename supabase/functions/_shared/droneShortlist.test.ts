/**
 * Unit tests for droneShortlist pure helpers.
 * Run: deno test --allow-read supabase/functions/_shared/droneShortlist.test.ts
 *
 * Covers: empty input, all-distinct, dedup window, roll gate, cap honoured.
 */

import {
  assertEquals,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  pickAiShortlist,
  DEFAULT_SHORTLIST_CAP,
  FLIGHT_ROLL_REJECT_DEG,
  type ShortlistableShot,
} from './droneShortlist.ts';

// ── Test fixtures ─────────────────────────────────────────────────────────

function makeShot(overrides: Partial<ShortlistableShot> & { id: string }): ShortlistableShot {
  // Use `in` so explicit `null` overrides aren't replaced by the default
  // (??/|| would coerce null to the fallback, losing the test's intent).
  return {
    id: overrides.id,
    captured_at: 'captured_at' in overrides ? overrides.captured_at! : '2026-04-25T10:00:00.000Z',
    gps_lat: 'gps_lat' in overrides ? overrides.gps_lat! : -33.8688,
    gps_lon: 'gps_lon' in overrides ? overrides.gps_lon! : 151.2093,
    flight_yaw: 'flight_yaw' in overrides ? overrides.flight_yaw! : 0,
    flight_roll: 'flight_roll' in overrides ? overrides.flight_roll! : 0,
    shot_role: 'shot_role' in overrides ? overrides.shot_role! : 'oblique_hero',
  };
}

/**
 * Helper to step a fixture's captured_at by N seconds from a base.
 */
function tsAt(seconds: number): string {
  return new Date(Date.parse('2026-04-25T10:00:00.000Z') + seconds * 1000).toISOString();
}

// ── 1. empty input → empty ───────────────────────────────────────────────

Deno.test('pickAiShortlist: empty input yields empty', () => {
  assertEquals(pickAiShortlist([]), []);
  assertEquals(pickAiShortlist([], 5), []);
});

// ── 2. N distinct shots all included up to cap ───────────────────────────

Deno.test('pickAiShortlist: 5 distinct shots, all included (under cap)', () => {
  // Spread over 60s, 1° lat apart, all good roll → no dedup → all kept.
  const shots: ShortlistableShot[] = [];
  for (let i = 0; i < 5; i++) {
    shots.push(makeShot({
      id: `s${i}`,
      captured_at: tsAt(i * 12),
      gps_lat: -33.8688 + i * 1.0, // 1° apart, well outside dedup tolerance
      flight_yaw: i * 90, // wildly different headings
    }));
  }
  const out = pickAiShortlist(shots);
  assertEquals(out.length, 5);
  // Order is chronological ASC.
  assertEquals(out, ['s0', 's1', 's2', 's3', 's4']);
});

// ── 3. 3 near-duplicate shots within window → only 1 chosen (lowest roll) ──

Deno.test('pickAiShortlist: 3 near-duplicates collapse to lowest-roll winner', () => {
  // All within 4s, same gps to 4dp, yaw within 10° → one group.
  const shots: ShortlistableShot[] = [
    makeShot({ id: 'dup_a', captured_at: tsAt(0), flight_roll: 5, flight_yaw: 100 }),
    makeShot({ id: 'dup_b', captured_at: tsAt(2), flight_roll: 1, flight_yaw: 105 }),
    makeShot({ id: 'dup_c', captured_at: tsAt(4), flight_roll: 8, flight_yaw: 110 }),
    // A non-duplicate: 30s later, well outside window
    makeShot({ id: 'distinct', captured_at: tsAt(30), gps_lat: -34.0, flight_roll: 0 }),
  ];
  const out = pickAiShortlist(shots);
  // Expect dup_b (lowest roll) + distinct, ordered chronologically.
  assertEquals(out, ['dup_b', 'distinct']);
});

// ── 4. shots with |flight_roll| > 10° excluded ───────────────────────────

Deno.test(`pickAiShortlist: shots with |roll| > ${FLIGHT_ROLL_REJECT_DEG}° excluded`, () => {
  const shots: ShortlistableShot[] = [
    makeShot({ id: 'ok', flight_roll: 9.9, gps_lat: -33.0, captured_at: tsAt(0) }),
    makeShot({ id: 'just_over', flight_roll: 10.1, gps_lat: -34.0, captured_at: tsAt(60) }),
    makeShot({ id: 'way_over', flight_roll: 25, gps_lat: -35.0, captured_at: tsAt(120) }),
    makeShot({ id: 'neg_over', flight_roll: -15, gps_lat: -36.0, captured_at: tsAt(180) }),
    makeShot({ id: 'null_roll', flight_roll: null, gps_lat: -37.0, captured_at: tsAt(240) }),
  ];
  const out = pickAiShortlist(shots);
  // Only 'ok' survives — null and over-threshold roll are both rejected.
  assertEquals(out, ['ok']);
});

// ── 5. Cap honoured (20 input → 12 out by default) ───────────────────────

Deno.test(`pickAiShortlist: cap honoured (20 distinct → ${DEFAULT_SHORTLIST_CAP})`, () => {
  // 20 fully distinct shots — none dedup, none roll-rejected.
  const shots: ShortlistableShot[] = [];
  for (let i = 0; i < 20; i++) {
    shots.push(makeShot({
      id: `cap_${String(i).padStart(2, '0')}`,
      captured_at: tsAt(i * 60), // 1 min apart
      gps_lat: -33.8688 + i * 0.5,
      flight_yaw: (i * 17) % 360,
      flight_roll: 0,
    }));
  }
  const out = pickAiShortlist(shots);
  assertEquals(out.length, DEFAULT_SHORTLIST_CAP);
  // First N chronologically.
  assertEquals(out[0], 'cap_00');
  assertEquals(out[DEFAULT_SHORTLIST_CAP - 1], `cap_${String(DEFAULT_SHORTLIST_CAP - 1).padStart(2, '0')}`);

  // Custom cap also honoured.
  const out5 = pickAiShortlist(shots, 5);
  assertEquals(out5.length, 5);
  assertEquals(out5[0], 'cap_00');
});

// ── Bonus: yaw wrap-around (350° vs 5° = 15° delta, on boundary) ─────────

Deno.test('pickAiShortlist: yaw wrap-around handled (355° vs 5° = 10° delta → dedup)', () => {
  const shots: ShortlistableShot[] = [
    makeShot({ id: 'wrap_a', captured_at: tsAt(0), flight_yaw: 355, flight_roll: 2 }),
    makeShot({ id: 'wrap_b', captured_at: tsAt(2), flight_yaw: 5, flight_roll: 1 }),
  ];
  const out = pickAiShortlist(shots);
  // Yaw delta is 10° (not 350°), so they dedup; lower-roll wins.
  assertEquals(out, ['wrap_b']);
});

// ── Bonus: missing GPS means NOT a duplicate (defensive) ─────────────────

Deno.test('pickAiShortlist: shots with missing GPS are not deduped', () => {
  const shots: ShortlistableShot[] = [
    makeShot({ id: 'no_gps_a', captured_at: tsAt(0), gps_lat: null, gps_lon: null, flight_roll: 5 }),
    makeShot({ id: 'no_gps_b', captured_at: tsAt(2), gps_lat: null, gps_lon: null, flight_roll: 1 }),
  ];
  const out = pickAiShortlist(shots);
  // Both kept since dedup gates on GPS presence.
  assertEquals(out.length, 2);
  assert(out.includes('no_gps_a'));
  assert(out.includes('no_gps_b'));
});

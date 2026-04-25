/**
 * Unit tests for droneIngest pure helpers.
 * Run: deno test --allow-read supabase/functions/_shared/droneIngest.test.ts
 *
 * The EXIF-from-fixture test requires --allow-read for the bundled DJI JPG.
 */

import {
  assertEquals,
  assertAlmostEquals,
  assertExists,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  classifyShotRole,
  djiDateTimeToIso,
  extractExifFromBytes,
  groupShotsIntoShoots,
  parseDjiFilename,
  refineNadirClassifications,
} from './droneIngest.ts';

// ─── parseDjiFilename ────────────────────────────────────────────────────────

Deno.test('parseDjiFilename: standard DJI photo', () => {
  const out = parseDjiFilename('DJI_20260420094122_0773_D.JPG');
  assertEquals(out, { timestamp_str: '20260420094122', dji_index: 773, suffix: 'D' });
});

Deno.test('parseDjiFilename: returns null for non-DJI filenames', () => {
  assertEquals(parseDjiFilename('IMG_0001.JPG'), null);
  assertEquals(parseDjiFilename('random.jpg'), null);
  assertEquals(parseDjiFilename('DJI_NOT_A_VALID_NAME.JPG'), null);
});

// ─── djiDateTimeToIso ────────────────────────────────────────────────────────

Deno.test('djiDateTimeToIso: parses DJI EXIF timestamp', () => {
  assertEquals(djiDateTimeToIso('2026:04:20 09:41:22'), '2026-04-20T09:41:22.000Z');
});

Deno.test('djiDateTimeToIso: returns null for unparseable input', () => {
  assertEquals(djiDateTimeToIso(null), null);
  assertEquals(djiDateTimeToIso(''), null);
  assertEquals(djiDateTimeToIso('not a date'), null);
});

// ─── classifyShotRole ────────────────────────────────────────────────────────

Deno.test('classifyShotRole: -90° pitch → nadir_grid regardless of altitude', () => {
  assertEquals(classifyShotRole({ gimbal_pitch: -90, relative_altitude: 50 }), 'nadir_grid');
  assertEquals(classifyShotRole({ gimbal_pitch: -90, relative_altitude: 5 }), 'nadir_grid');
});

Deno.test('classifyShotRole: -85° boundary is inclusive nadir_grid', () => {
  assertEquals(classifyShotRole({ gimbal_pitch: -85, relative_altitude: 50 }), 'nadir_grid');
  // Just inside the band: -84.99° + 50m alt + (no orbital pitch range) → unclassified
  assertEquals(classifyShotRole({ gimbal_pitch: -84.99, relative_altitude: 50 }), 'oblique_hero');
});

Deno.test('classifyShotRole: 50m altitude + -15° pitch → orbital', () => {
  assertEquals(classifyShotRole({ gimbal_pitch: -15, relative_altitude: 50 }), 'orbital');
});

Deno.test('classifyShotRole: 50m altitude + -45° pitch → oblique_hero', () => {
  assertEquals(classifyShotRole({ gimbal_pitch: -45, relative_altitude: 50 }), 'oblique_hero');
});

Deno.test('classifyShotRole: very low altitude → ground_level (alt < 5m)', () => {
  // Threshold tightened from <10 to <5 when building_hero was added — true
  // ground-level (drone on ground, person walking past) only.
  assertEquals(classifyShotRole({ gimbal_pitch: -20, relative_altitude: 4.9 }), 'ground_level');
  assertEquals(classifyShotRole({ gimbal_pitch: -45, relative_altitude: 0 }), 'ground_level');
});

Deno.test('classifyShotRole: 5-30m alt + near-horizontal pitch → building_hero', () => {
  // The Everton case: alt 21-25m, pitch -7° to -11° (façade hero shots).
  assertEquals(classifyShotRole({ gimbal_pitch: -7.5, relative_altitude: 21.4 }), 'building_hero');
  assertEquals(classifyShotRole({ gimbal_pitch: -10.9, relative_altitude: 23.2 }), 'building_hero');
  // Boundaries
  assertEquals(classifyShotRole({ gimbal_pitch: 0, relative_altitude: 5 }), 'building_hero');
  assertEquals(classifyShotRole({ gimbal_pitch: -25, relative_altitude: 30 }), 'building_hero');
  // Just outside the building_hero pitch band (-26° < -25°): falls through
  // to unclassified because no other rule fits at alt=30, pitch=-26.
  assertEquals(classifyShotRole({ gimbal_pitch: -26, relative_altitude: 30 }), 'unclassified');
});

Deno.test('classifyShotRole: missing data → unclassified, never throws', () => {
  assertEquals(classifyShotRole({ gimbal_pitch: null, relative_altitude: null }), 'unclassified');
  // Pitch present but altitude missing — we refuse to guess.
  assertEquals(classifyShotRole({ gimbal_pitch: -20, relative_altitude: null }), 'unclassified');
});

Deno.test('classifyShotRole: 30m+ altitude + level pitch → unclassified (above building_hero band)', () => {
  // building_hero caps at 30m. Above that with a near-level pitch is
  // neither orbital (needs >40m and pitch -30..-5) nor oblique_hero
  // (needs pitch <-30) — drop to unclassified for operator review.
  assertEquals(classifyShotRole({ gimbal_pitch: 0, relative_altitude: 35 }), 'unclassified');
  assertEquals(classifyShotRole({ gimbal_pitch: -2, relative_altitude: 50 }), 'unclassified');
});

// ─── groupShotsIntoShoots ────────────────────────────────────────────────────

Deno.test('groupShotsIntoShoots: single group when all shots within 30 min', () => {
  const shots = [
    { id: 'a', captured_at: '2026-04-20T09:41:22.000Z' },
    { id: 'b', captured_at: '2026-04-20T09:42:30.000Z' },
    { id: 'c', captured_at: '2026-04-20T09:55:00.000Z' },
  ];
  const groups = groupShotsIntoShoots(shots);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].shots.length, 3);
  assertEquals(groups[0].flight_started_at, '2026-04-20T09:41:22.000Z');
  assertEquals(groups[0].flight_ended_at, '2026-04-20T09:55:00.000Z');
});

Deno.test('groupShotsIntoShoots: 30+ minute gap splits into two shoots', () => {
  const shots = [
    { id: 'a', captured_at: '2026-04-20T09:00:00.000Z' },
    { id: 'b', captured_at: '2026-04-20T09:10:00.000Z' },
    // 31 min later → new shoot
    { id: 'c', captured_at: '2026-04-20T09:41:01.000Z' },
    { id: 'd', captured_at: '2026-04-20T09:50:00.000Z' },
  ];
  const groups = groupShotsIntoShoots(shots);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].shots.map((s) => s.id), ['a', 'b']);
  assertEquals(groups[1].shots.map((s) => s.id), ['c', 'd']);
});

Deno.test('groupShotsIntoShoots: exactly 30-min gap stays in same shoot (boundary)', () => {
  // Boundary: gap > 30 min splits; gap == 30 min stays together.
  const shots = [
    { id: 'a', captured_at: '2026-04-20T09:00:00.000Z' },
    { id: 'b', captured_at: '2026-04-20T09:30:00.000Z' },
  ];
  const groups = groupShotsIntoShoots(shots);
  assertEquals(groups.length, 1);
});

Deno.test('groupShotsIntoShoots: out-of-order shots get sorted', () => {
  const shots = [
    { id: 'b', captured_at: '2026-04-20T09:42:30.000Z' },
    { id: 'a', captured_at: '2026-04-20T09:41:22.000Z' },
  ];
  const groups = groupShotsIntoShoots(shots);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].shots.map((s) => s.id), ['a', 'b']);
});

Deno.test('groupShotsIntoShoots: drops shots with null captured_at', () => {
  // Spec choice: shots with no timestamp are dropped from the grouping pass.
  // The Edge Function caller persists them anyway as drone_shots rows, but
  // they don't contribute to flight_started_at/flight_ended_at on a shoot.
  const shots = [
    { id: 'a', captured_at: '2026-04-20T09:41:22.000Z' },
    { id: 'b', captured_at: null },
  ];
  const groups = groupShotsIntoShoots(shots);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].shots.length, 1);
  assertEquals(groups[0].shots[0].id, 'a');
});

Deno.test('groupShotsIntoShoots: empty input → empty array', () => {
  assertEquals(groupShotsIntoShoots([]), []);
});

// ─── refineNadirClassifications ──────────────────────────────────────────────

Deno.test('refineNadirClassifications: 3+ nadirs within 30s all stay nadir_grid', () => {
  // 4 nadirs spaced ~5s apart — every one has >=3 neighbors in ±30s → cluster.
  const shots = [
    { captured_at: '2026-04-20T09:00:00.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:05.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:10.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:15.000Z', shot_role: 'nadir_grid' as const },
  ];
  const out = refineNadirClassifications(shots);
  assertEquals(out.map((s) => s.shot_role), [
    'nadir_grid', 'nadir_grid', 'nadir_grid', 'nadir_grid',
  ]);
});

Deno.test('refineNadirClassifications: 1 isolated nadir + 0 neighbors → nadir_hero', () => {
  const shots = [
    { captured_at: '2026-04-20T09:00:00.000Z', shot_role: 'nadir_grid' as const },
  ];
  const out = refineNadirClassifications(shots);
  assertEquals(out[0].shot_role, 'nadir_hero');
});

Deno.test('refineNadirClassifications: 5 grid + 1 isolated 5min later → 5 grid + 1 hero', () => {
  const shots = [
    { captured_at: '2026-04-20T09:00:00.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:05.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:10.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:15.000Z', shot_role: 'nadir_grid' as const },
    { captured_at: '2026-04-20T09:00:20.000Z', shot_role: 'nadir_grid' as const },
    // 5 minutes after the burst — outside the 30s window, no neighbors.
    { captured_at: '2026-04-20T09:05:20.000Z', shot_role: 'nadir_grid' as const },
  ];
  const out = refineNadirClassifications(shots);
  assertEquals(out.map((s) => s.shot_role), [
    'nadir_grid', 'nadir_grid', 'nadir_grid', 'nadir_grid', 'nadir_grid',
    'nadir_hero',
  ]);
});

Deno.test('refineNadirClassifications: empty input → empty output', () => {
  assertEquals(refineNadirClassifications([]), []);
});

Deno.test('refineNadirClassifications: all non-nadir shots → unchanged', () => {
  const shots = [
    { captured_at: '2026-04-20T09:00:00.000Z', shot_role: 'orbital' as const },
    { captured_at: '2026-04-20T09:00:05.000Z', shot_role: 'building_hero' as const },
    { captured_at: '2026-04-20T09:00:10.000Z', shot_role: 'oblique_hero' as const },
    { captured_at: '2026-04-20T09:00:15.000Z', shot_role: 'ground_level' as const },
    { captured_at: '2026-04-20T09:00:20.000Z', shot_role: 'unclassified' as const },
  ];
  const out = refineNadirClassifications(shots);
  assertEquals(out.map((s) => s.shot_role), [
    'orbital', 'building_hero', 'oblique_hero', 'ground_level', 'unclassified',
  ]);
});

// ─── extractExifFromBytes ────────────────────────────────────────────────────
//
// Uses a real DJI L2D-20c JPG (Mavic 3 Pro Cine) bundled at ./_fixtures/
// pulled from the Chauvel SfM test set. Confirmed via exiftool:
//   RelativeAltitude=+35.900  GimbalPitchDegree=-90.00
//   GPSLatitude=33°56'40.95"S GPSLongitude=150°56'33.07"E
//   FlightYawDegree=-147.30   FlightRollDegree=+3.30
//   GpsStatus="Measurement Active"
//   DateTimeOriginal="2026:04:20 09:41:22"
//   Model="L2D-20c"
//
// The test asserts our extraction agrees with exiftool to within 0.01° for
// coordinates and exact match for everything else.

Deno.test('extractExifFromBytes: real DJI fixture extracts XMP + GPS + time', async () => {
  const url = new URL('./_fixtures/dji_sample.jpg', import.meta.url);
  const bytes = await Deno.readFile(url);

  const exif = extractExifFromBytes(bytes);

  assertEquals(exif.captured_at, '2026-04-20T09:41:22.000Z');
  assertEquals(exif.drone_model, 'L2D-20c');
  assertEquals(exif.gimbal_pitch, -90);
  // ExifReader maps GPS IFD value 'A' to "Measurement in progress" (exiftool
  // calls it "Measurement Active"); both indicate a healthy GPS fix.
  assertEquals(exif.gps_status, 'Measurement in progress');

  // Numerical XMP fields — assert within 0.01 to absorb floating-point noise.
  assertExists(exif.relative_altitude);
  assertAlmostEquals(exif.relative_altitude!, 35.9, 0.01);
  assertExists(exif.flight_yaw);
  assertAlmostEquals(exif.flight_yaw!, -147.3, 0.01);
  assertExists(exif.flight_roll);
  assertAlmostEquals(exif.flight_roll!, 3.3, 0.01);
  assertEquals(exif.gimbal_roll, 0);

  // GPS — Sydney's south-western suburbs (Wattle Grove). Lat ≈ -33.94, Lon ≈ +150.94.
  assertExists(exif.gps_lat);
  assertExists(exif.gps_lon);
  assert(exif.gps_lat! < -33.9 && exif.gps_lat! > -34.0, `gps_lat ${exif.gps_lat} out of expected band`);
  assert(exif.gps_lon! > 150.9 && exif.gps_lon! < 151.0, `gps_lon ${exif.gps_lon} out of expected band`);

  // Sanity: classification of this real shot — pitch=-90° → nadir_grid.
  assertEquals(classifyShotRole(exif), 'nadir_grid');

  // raw is preserved.
  assertExists(exif.raw);
});

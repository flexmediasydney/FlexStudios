/**
 * persistImageClassificationFromV2.test.ts — QC iter 3 P0 F-3C-001 regression.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-finals-qa/persistImageClassificationFromV2.test.ts
 *
 * Coverage (per QC iter 3 finding F-3C-001):
 *   The pre-fix `persistFinalsClassification()` read top-level `out.time_of_day`,
 *   `out.is_drone`, `out.is_exterior`, `out.is_detail_shot` — all of which are
 *   NEVER emitted by the v2 universal schema (those signals live nested under
 *   `out.image_classification.{is_dusk, is_day, is_golden_hour, is_night,
 *   subject, is_drone}` and `out.image_type`). 5 prod v2 finals rows landed
 *   with NULL on these 4 columns since the W11.7.17 cutover. This file is
 *   the regression fence: every test asserts the v2-shaped emission lands
 *   non-null values, and the v1 fallback still works for replay parity.
 *
 *   Mirrors `shortlisting-shape-d/persistImageClassificationV2.test.ts` (the
 *   F-D-002 fix that shipped on shape-d but never on finals-qa).
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistFinalsClassification } from './index.ts';

interface Captured {
  table: string | null;
  row: Record<string, unknown> | null;
  conflict: string | null;
}

function makeFakeAdmin(captured: Captured) {
  return {
    from(table: string) {
      captured.table = table;
      return {
        upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
          captured.row = row;
          captured.conflict = opts?.onConflict ?? null;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const PROJECT_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
const GROUP_ID = 'bbbbbbbb-2222-2222-2222-222222222222';

function baseFinalsResult(out: Record<string, unknown>) {
  return {
    group_id: GROUP_ID,
    finals_path: '/Photos/Finals/IMG_1234.jpg',
    filename: 'IMG_1234.jpg',
    output: out,
    error: null,
    cost_usd: 0.014,
    wall_ms: 18_000,
    input_tokens: 6_500,
    output_tokens: 4_000,
    vendor_used: 'google' as const,
    model_used: 'gemini-2.5-pro',
    failover_triggered: false,
    failover_reason: null,
  };
}

// ─── Reusable v2 emission shapes ────────────────────────────────────────────

function v2DayInterior(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '2.0',
    image_type: 'is_day',
    image_classification: {
      is_relevant_property_content: true,
      subject: 'interior',
      is_dusk: false,
      is_day: true,
      is_golden_hour: false,
      is_night: false,
      time_of_day_confidence: 0.95,
      is_drone: false,
      is_video_frame: false,
    },
    room_classification: {
      room_type: 'kitchen_main',
      room_type_confidence: 0.92,
      composition_type: 'wide_establishing',
      vantage_point: 'interior_looking_out',
      is_styled: true,
      indoor_outdoor_visible: true,
    },
    signal_scores: {},
    quality_flags: { clutter_severity: 'none', flag_for_retouching: false },
    ...overrides,
  };
}

// ─── F-3C-001 Test 1: v2 day-interior derives all 4 cols correctly ─────────

Deno.test('F-3C-001 — v2 day interior: time_of_day=day, is_exterior=false, is_drone=false, is_detail_shot=false', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior()) as any,
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.time_of_day, 'day');
  assertStrictEquals(row.is_exterior, false);
  assertStrictEquals(row.is_drone, false);
  assertStrictEquals(row.is_detail_shot, false);
});

// ─── F-3C-001 Test 2: night exterior derives time_of_day=night ─────────────

Deno.test('F-3C-001 — v2 night exterior: time_of_day=night, is_exterior=true', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_type: 'is_facade_hero',
      image_classification: {
        is_relevant_property_content: true,
        subject: 'exterior',
        is_dusk: false,
        is_day: false,
        is_golden_hour: false,
        is_night: true,
        time_of_day_confidence: 0.9,
        is_drone: false,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.time_of_day, 'night');
  assertStrictEquals(row.is_exterior, true);
  assertStrictEquals(row.is_drone, false);
  assertStrictEquals(row.is_detail_shot, false);
});

// ─── F-3C-001 Test 3: dusk takes priority over day ─────────────────────────

Deno.test('F-3C-001 — v2 dusk: time_of_day=dusk_twilight (priority over day)', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_type: 'is_dusk',
      image_classification: {
        is_relevant_property_content: true,
        subject: 'exterior',
        is_dusk: true,
        is_day: true, // both flagged — dusk should win
        is_golden_hour: false,
        is_night: false,
        time_of_day_confidence: 0.85,
        is_drone: false,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  assertStrictEquals(captured.row!.time_of_day, 'dusk_twilight');
});

// ─── F-3C-001 Test 4: golden hour ──────────────────────────────────────────

Deno.test('F-3C-001 — v2 golden_hour: time_of_day=golden_hour', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_classification: {
        is_relevant_property_content: true,
        subject: 'exterior',
        is_dusk: false,
        is_day: false,
        is_golden_hour: true,
        is_night: false,
        time_of_day_confidence: 0.88,
        is_drone: false,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  assertStrictEquals(captured.row!.time_of_day, 'golden_hour');
});

// ─── F-3C-001 Test 5: drone subject + is_drone ─────────────────────────────

Deno.test('F-3C-001 — v2 drone subject: is_drone=true', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_type: 'is_drone',
      image_classification: {
        is_relevant_property_content: true,
        subject: 'drone',
        is_dusk: false,
        is_day: true,
        is_golden_hour: false,
        is_night: false,
        time_of_day_confidence: 0.95,
        is_drone: true,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.is_drone, true);
  // subject='drone' is NOT 'exterior', so is_exterior stays false (drone is
  // its own category in v2 — separate from exterior).
  assertStrictEquals(row.is_exterior, false);
});

// ─── F-3C-001 Test 6: image_type=is_drone fallback when is_drone bool absent ──

Deno.test('F-3C-001 — image_type=is_drone derives is_drone=true even if bool unset', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_type: 'is_drone',
      image_classification: {
        is_relevant_property_content: true,
        subject: 'exterior', // drone subject not flagged but image_type is
        is_dusk: false,
        is_day: true,
        is_golden_hour: false,
        is_night: false,
        time_of_day_confidence: 0.95,
        is_drone: false, // model didn't set the boolean
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  // image_type fallback ensures the column lands true.
  assertStrictEquals(captured.row!.is_drone, true);
});

// ─── F-3C-001 Test 7: detail subject (mig 442 — column DEPRECATED) ─────────

Deno.test('mig 442: v2 detail subject — is_detail_shot=false (column DEPRECATED)', async () => {
  // Mig 442 (2026-05-02, schema v2.5): is_detail_shot column DEPRECATED —
  // replaced by shot_scale='detail' / 'tight'. Persist now writes false on
  // every new row regardless of model emission. Column kept for backwards-
  // compat with v1/v1.x/v2 readers.
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      // v2.5 dropped 'is_detail_shot' from IMAGE_TYPE_OPTIONS — use 'is_other'.
      image_type: 'is_other',
      image_classification: {
        is_relevant_property_content: true,
        subject: 'detail',
        is_dusk: false,
        is_day: true,
        is_golden_hour: false,
        is_night: false,
        time_of_day_confidence: 0.9,
        is_drone: false,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  const row = captured.row!;
  // Mig 442: column always false post-migration.
  assertStrictEquals(row.is_detail_shot, false);
  assertStrictEquals(row.is_exterior, false);
});

// ─── F-3C-001 Test 8: replay of pre-mig-442 image_type signal (still false) ─

Deno.test('mig 442: legacy image_type=is_detail_shot replay — column still lands false', async () => {
  // Backwards-compat: a replay of pre-mig-442 traffic still carrying
  // image_type='is_detail_shot' must not light up the column either.
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_type: 'is_detail_shot',
      image_classification: {
        is_relevant_property_content: true,
        subject: 'interior',
        is_dusk: false,
        is_day: true,
        is_golden_hour: false,
        is_night: false,
        time_of_day_confidence: 0.9,
        is_drone: false,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  // Mig 442: always false post-migration.
  assertStrictEquals(captured.row!.is_detail_shot, false);
});

// ─── F-3C-001 Test 9: v1 fallback (image_classification absent) ────────────

Deno.test('F-3C-001 — v1 backward-compat: missing image_classification falls back to top-level keys', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult({
      schema_version: '1.0',
      // No image_classification — pure v1 shape.
      time_of_day: 'dusk_twilight',
      is_drone: true,
      is_exterior: true,
      is_detail_shot: false,
      room_classification: { room_type: 'exterior_front', room_type_confidence: 0.9 },
      signal_scores: {},
      quality_flags: {},
    }) as any,
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.time_of_day, 'dusk_twilight');
  assertStrictEquals(row.is_drone, true);
  assertStrictEquals(row.is_exterior, true);
  assertStrictEquals(row.is_detail_shot, false);
});

// ─── F-3C-001 Test 10: time_of_day=null when no booleans flagged ───────────

Deno.test('F-3C-001 — v2 with no time-of-day boolean true: time_of_day lands null', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior({
      image_classification: {
        is_relevant_property_content: true,
        subject: 'interior',
        is_dusk: false,
        is_day: false,
        is_golden_hour: false,
        is_night: false,
        time_of_day_confidence: 0.0,
        is_drone: false,
        is_video_frame: false,
      },
    })) as any,
    warnings: [],
  });

  // All four time_of_day flags are false — derived enum is null. This is
  // expected for floorplans, agent_headshots, and other quarantined frames.
  assertStrictEquals(captured.row!.time_of_day, null);
});

// ─── F-3C-002 Test 11: prompt_block_versions merges full assembled map ─────

Deno.test('F-3C-002 — prompt_block_versions merges promptBlockVersions arg with v2 keys on top', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior()) as any,
    warnings: [],
    promptBlockVersions: {
      header: 'v1.0',
      stepOrdering: 'v1.0',
      streamBAnchors: 'v1.0',
      pass1V2Orientation: 'v1.0',
      roomTypeTaxonomy: 'v1.0',
      spaceZoneTaxonomy: 'v1.0',
      compositionTypeTaxonomy: 'v1.0',
      vantagePoint: 'v1.0',
      clutterSeverity: 'v1.0',
    },
  });

  const versions = captured.row!.prompt_block_versions as Record<string, string>;
  // Pre-fix: only 3 keys landed. Post-fix: ~12 keys.
  assertEquals(Object.keys(versions).length >= 12, true,
    `expected >= 12 keys, got ${Object.keys(versions).length}: ${JSON.stringify(versions)}`);
  // All assembled-prompt block names present.
  assertStrictEquals(versions.header, 'v1.0');
  assertStrictEquals(versions.stepOrdering, 'v1.0');
  assertStrictEquals(versions.roomTypeTaxonomy, 'v1.0');
  assertStrictEquals(versions.compositionTypeTaxonomy, 'v1.0');
  assertStrictEquals(versions.clutterSeverity, 'v1.0');
  // v2 schema/signal/source keys still present (and win on collision).
  assertEquals(typeof versions.universal_vision_response_schema, 'string');
  assertEquals(typeof versions.signal_measurement, 'string');
  assertEquals(typeof versions.source_context, 'string');
});

// ─── F-3C-002 Test 12: prompt_block_versions backwards-compat without arg ──

Deno.test('F-3C-002 — prompt_block_versions still has v2 keys when no promptBlockVersions arg passed', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(v2DayInterior()) as any,
    warnings: [],
    // no promptBlockVersions
  });

  const versions = captured.row!.prompt_block_versions as Record<string, string>;
  // With no arg, only the 3 hardcoded v2 keys remain (defensive).
  assertEquals(typeof versions.universal_vision_response_schema, 'string');
  assertEquals(typeof versions.signal_measurement, 'string');
  assertEquals(typeof versions.source_context, 'string');
});

/**
 * pulseVisionPersist.test.ts — Wave 15b.2 unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/_shared/pulseVisionPersist.test.ts
 *
 * Coverage (per W15b.2 spec):
 *   1. Pure aggregation math — photo_breakdown counts (14 imgs → 10 day +
 *      3 dusk + 1 floorplan)
 *   2. Pure aggregation math — competitor branding rolls up watermark /
 *      photographer credit / dominant brand
 *   3. Pure aggregation math — video_breakdown rolls up day/dusk/drone
 *      segments + agent_in_frame
 *   4. createPulseVisionExtract — first call inserts, returns created=true
 *   5. createPulseVisionExtract — second call (same listing+version) returns
 *      the existing id with created=false (idempotency)
 *   6. markPulseVisionExtractRunning — status pending → running
 *   7. markPulseVisionExtractSucceeded — stamps cost / vendor / model
 *   8. markPulseVisionExtractFailed — captures failed_reason
 *   9. applyManualOverride — status=manually_overridden + actor/reason captured
 *  10. aggregatePerImageResults — writes computed breakdown to the row
 *
 * No real DB — fake Supabase client captures the table / row / filter trio
 * for each call so we can assert on the writes directly.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  aggregateCompetitorBranding,
  aggregatePerImageResults,
  aggregateVideoResults,
  applyManualOverride,
  computeCompetitorBranding,
  computePhotoBreakdown,
  computeVideoBreakdown,
  createPulseVisionExtract,
  markPulseVisionExtractFailed,
  markPulseVisionExtractRunning,
  markPulseVisionExtractSucceeded,
  type VisionResponseV2,
} from './pulseVisionPersist.ts';

// ─── Test plumbing ──────────────────────────────────────────────────────────

interface CapturedCall {
  table: string;
  op: 'select' | 'insert' | 'update';
  values?: Record<string, unknown>;
  filters: Record<string, unknown>;
}

interface FakeAdminConfig {
  /**
   * For each (table, op, listing_id, schema_version) tuple, what should the
   * SELECT/INSERT return? The test seeds this before each call.
   */
  selectExisting?: { id: string } | null;
  insertReturnId?: string;
  insertError?: { code?: string; message?: string };
}

function makeFakeAdmin(
  cfg: FakeAdminConfig,
  captured: CapturedCall[],
) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};

      builder.select = (_cols: string) => {
        const sel: Record<string, unknown> = {};
        sel.eq = (col: string, val: unknown) => {
          filters[col] = val;
          return sel;
        };
        sel.maybeSingle = () => {
          captured.push({ table, op: 'select', filters: { ...filters } });
          return Promise.resolve({ data: cfg.selectExisting ?? null, error: null });
        };
        sel.single = () => {
          captured.push({ table, op: 'select', filters: { ...filters } });
          return Promise.resolve({
            data: cfg.selectExisting ?? { id: cfg.insertReturnId ?? 'fallback-id' },
            error: null,
          });
        };
        return sel;
      };

      builder.insert = (values: Record<string, unknown>) => {
        const ins: Record<string, unknown> = {};
        ins.select = (_cols: string) => {
          const single = () => {
            captured.push({ table, op: 'insert', values, filters: {} });
            if (cfg.insertError) {
              return Promise.resolve({
                data: null,
                error: cfg.insertError,
              });
            }
            return Promise.resolve({
              data: { id: cfg.insertReturnId ?? 'inserted-id' },
              error: null,
            });
          };
          return { single };
        };
        return ins;
      };

      builder.update = (values: Record<string, unknown>) => {
        const upd: Record<string, unknown> = {};
        upd.eq = (col: string, val: unknown) => {
          filters[col] = val;
          captured.push({ table, op: 'update', values, filters: { ...filters } });
          return Promise.resolve({ error: null });
        };
        return upd;
      };

      return builder;
    },
  };
}

// ─── Test 1: photo_breakdown counts ─────────────────────────────────────────

Deno.test('W15b.2 — computePhotoBreakdown: 14 images → 10 day + 3 dusk + 1 floorplan', () => {
  const classifications: VisionResponseV2[] = [
    ...Array(10).fill(0).map(() => ({ image_type: 'is_day' })),
    ...Array(3).fill(0).map(() => ({ image_type: 'is_dusk' })),
    { image_type: 'is_floorplan' },
  ];
  const breakdown = computePhotoBreakdown(classifications);
  assertStrictEquals(breakdown.day_count, 10);
  assertStrictEquals(breakdown.dusk_count, 3);
  assertStrictEquals(breakdown.floorplan_count, 1);
  assertStrictEquals(breakdown.drone_count, 0);
  assertStrictEquals(breakdown.total_images, 14);
});

Deno.test('W15b.2 — computePhotoBreakdown: covers drone / detail / video_thumbnail / agent_headshot', () => {
  const classifications: VisionResponseV2[] = [
    { image_type: 'is_drone' },
    { image_type: 'is_drone' },
    { image_type: 'is_detail_shot' },
    { image_type: 'is_video_frame' },
    { image_type: 'is_agent_headshot' },
    { image_type: 'is_other' }, // → only total_images++
  ];
  const breakdown = computePhotoBreakdown(classifications);
  assertStrictEquals(breakdown.drone_count, 2);
  assertStrictEquals(breakdown.detail_count, 1);
  assertStrictEquals(breakdown.video_thumbnail_count, 1);
  assertStrictEquals(breakdown.agent_headshot_count, 1);
  // is_other doesn't bucket
  assertStrictEquals(breakdown.day_count, 0);
  assertStrictEquals(breakdown.total_images, 6);
});

// ─── Test 2: competitor branding ────────────────────────────────────────────

Deno.test('W15b.2 — computeCompetitorBranding: detects watermark + photographer credit + brand', () => {
  const classifications: VisionResponseV2[] = [
    {
      image_type: 'is_day',
      observed_attributes: [
        { raw_label: 'watermark', canonical_value_id: 'watermark_visible' },
        { raw_label: 'photographer credit', canonical_value_id: 'credit_text' },
      ],
    },
    {
      image_type: 'is_day',
      observed_attributes: [
        { raw_label: 'agency_brand', canonical_value_id: 'ray_white' },
      ],
    },
    {
      image_type: 'is_day',
      observed_attributes: [
        { raw_label: 'agency_brand', canonical_value_id: 'ray_white' },
        { raw_label: 'agency_brand', canonical_value_id: 'belle_property' },
      ],
    },
  ];
  const competitor = computeCompetitorBranding(classifications);
  assertStrictEquals(competitor.watermark_visible, true);
  assertStrictEquals(competitor.photographer_credit, true);
  assertStrictEquals(competitor.dominant_brand_inferred, 'ray_white'); // 2 vs 1
  assertStrictEquals(competitor.agency_logo, false);
});

// ─── Test 3: video_breakdown ─────────────────────────────────────────────

Deno.test('W15b.2 — computeVideoBreakdown: rolls up segments + agent_in_frame + duration', () => {
  const videoFrames: VisionResponseV2[] = [
    { image_type: 'is_day' },
    { image_type: 'is_day' },
    { image_type: 'is_dusk' },
    { image_type: 'is_drone' },
    {
      image_type: 'is_day',
      observed_attributes: [
        { raw_label: 'agent on camera', canonical_value_id: 'agent_visible' },
      ],
    },
  ];
  const breakdown = computeVideoBreakdown(videoFrames, {
    total_duration_s: 92,
    frames_extracted: 5,
  });
  assertStrictEquals(breakdown.present, true);
  assertStrictEquals(breakdown.day_segments_count, 3);
  assertStrictEquals(breakdown.dusk_segments_count, 1);
  assertStrictEquals(breakdown.drone_segments_count, 1);
  assertStrictEquals(breakdown.agent_in_frame, true);
  assertStrictEquals(breakdown.total_duration_s, 92);
  assertStrictEquals(breakdown.frames_extracted, 5);
});

Deno.test('W15b.2 — computeVideoBreakdown: empty video → present=false', () => {
  const breakdown = computeVideoBreakdown([]);
  assertStrictEquals(breakdown.present, false);
  assertStrictEquals(breakdown.day_segments_count, 0);
  assertStrictEquals(breakdown.total_duration_s, null);
});

// ─── Test 4 + 5: createPulseVisionExtract idempotency ───────────────────────

Deno.test('W15b.2 — createPulseVisionExtract: first call inserts (created=true)', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin(
    { selectExisting: null, insertReturnId: 'extract-aaa' },
    captured,
  );

  const result = await createPulseVisionExtract(
    // deno-lint-ignore no-explicit-any
    admin as any,
    {
      listing_id: '11111111-1111-1111-1111-111111111111',
      triggered_by: 'pulse_detail_enrich',
    },
  );
  assertStrictEquals(result.created, true);
  assertStrictEquals(result.extract_id, 'extract-aaa');

  // Verify INSERT was made
  const ins = captured.find((c) => c.op === 'insert');
  assert(ins, 'expected an INSERT call');
  assertStrictEquals(ins!.values!.status, 'pending');
  assertStrictEquals(ins!.values!.triggered_by, 'pulse_detail_enrich');
  assertStrictEquals(ins!.values!.schema_version, 'v1.0');
});

Deno.test('W15b.2 — createPulseVisionExtract: idempotent (existing row → created=false)', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin(
    { selectExisting: { id: 'extract-existing-bbb' } },
    captured,
  );

  const result = await createPulseVisionExtract(
    // deno-lint-ignore no-explicit-any
    admin as any,
    {
      listing_id: '22222222-2222-2222-2222-222222222222',
      triggered_by: 'mass_backfill',
    },
  );
  assertStrictEquals(result.created, false);
  assertStrictEquals(result.extract_id, 'extract-existing-bbb');

  // No INSERT should have been issued
  const ins = captured.find((c) => c.op === 'insert');
  assertStrictEquals(ins, undefined);
});

// ─── Test 6: markPulseVisionExtractRunning ─────────────────────────────────

Deno.test('W15b.2 — markPulseVisionExtractRunning: pending → running', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);
  await markPulseVisionExtractRunning(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-xyz',
  );
  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertStrictEquals(upd!.values!.status, 'running');
  assertStrictEquals(upd!.filters.id, 'extract-xyz');
});

// ─── Test 7: markPulseVisionExtractSucceeded ───────────────────────────────

Deno.test('W15b.2 — markPulseVisionExtractSucceeded: stamps cost / vendor / model', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);
  await markPulseVisionExtractSucceeded(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-success-id',
    {
      total_cost_usd: 0.0421,
      total_input_tokens: 18_500,
      total_output_tokens: 4_200,
      vendor: 'google',
      model_version: 'gemini-2.5-flash',
      prompt_block_versions: { stage1_external: 'v1.3' },
    },
  );
  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertStrictEquals(upd!.values!.status, 'succeeded');
  assertStrictEquals(upd!.values!.total_cost_usd, 0.0421);
  assertStrictEquals(upd!.values!.vendor, 'google');
  assertStrictEquals(upd!.values!.model_version, 'gemini-2.5-flash');
  assertStrictEquals(upd!.values!.total_input_tokens, 18_500);
  assertEquals(upd!.values!.prompt_block_versions, { stage1_external: 'v1.3' });
  // extracted_at is set to a timestamp string
  assertEquals(typeof upd!.values!.extracted_at, 'string');
});

// ─── Test 8: markPulseVisionExtractFailed ──────────────────────────────────

Deno.test('W15b.2 — markPulseVisionExtractFailed: captures failed_reason', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);
  await markPulseVisionExtractFailed(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-fail-id',
    'gemini_429_after_retries',
  );
  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertStrictEquals(upd!.values!.status, 'failed');
  assertStrictEquals(upd!.values!.failed_reason, 'gemini_429_after_retries');
  assertStrictEquals(upd!.filters.id, 'extract-fail-id');
});

// ─── Test 9: applyManualOverride ───────────────────────────────────────────

Deno.test('W15b.2 — applyManualOverride: sets manually_overridden + actor + reason', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);
  await applyManualOverride(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-override-id',
    'user-master-admin-uuid',
    'Listing images paywalled — manual product mix entered via dashboard',
  );
  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertStrictEquals(upd!.values!.status, 'manually_overridden');
  assertStrictEquals(upd!.values!.manual_override_by, 'user-master-admin-uuid');
  assertStrictEquals(
    upd!.values!.manual_override_reason,
    'Listing images paywalled — manual product mix entered via dashboard',
  );
});

// ─── Test 10: aggregatePerImageResults end-to-end ──────────────────────────

Deno.test('W15b.2 — aggregatePerImageResults: writes computed breakdown to row', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);

  const classifications: VisionResponseV2[] = [
    { image_type: 'is_day' },
    { image_type: 'is_day' },
    { image_type: 'is_dusk' },
    { image_type: 'is_floorplan' },
  ];
  const breakdown = await aggregatePerImageResults(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-agg-id',
    classifications,
  );

  // Returned breakdown matches pure-fn output
  assertStrictEquals(breakdown.day_count, 2);
  assertStrictEquals(breakdown.dusk_count, 1);
  assertStrictEquals(breakdown.floorplan_count, 1);
  assertStrictEquals(breakdown.total_images, 4);

  // UPDATE wrote photo_breakdown
  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertEquals(upd!.values!.photo_breakdown, breakdown);
});

// ─── Test 11: aggregateVideoResults end-to-end ─────────────────────────────

Deno.test('W15b.2 — aggregateVideoResults: writes video_breakdown JSONB', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);
  const breakdown = await aggregateVideoResults(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-vid-id',
    [{ image_type: 'is_day' }, { image_type: 'is_drone' }],
    { total_duration_s: 60, frames_extracted: 2 },
  );
  assertStrictEquals(breakdown.present, true);
  assertStrictEquals(breakdown.day_segments_count, 1);
  assertStrictEquals(breakdown.drone_segments_count, 1);
  assertStrictEquals(breakdown.total_duration_s, 60);

  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertEquals(upd!.values!.video_breakdown, breakdown);
});

// ─── Test 12: aggregateCompetitorBranding end-to-end ───────────────────────

Deno.test('W15b.2 — aggregateCompetitorBranding: writes competitor JSONB to row', async () => {
  const captured: CapturedCall[] = [];
  const admin = makeFakeAdmin({}, captured);
  const competitor = await aggregateCompetitorBranding(
    // deno-lint-ignore no-explicit-any
    admin as any,
    'extract-comp-id',
    [
      {
        image_type: 'is_day',
        observed_attributes: [
          { raw_label: 'watermark', canonical_value_id: 'watermark_visible' },
        ],
      },
    ],
  );
  assertStrictEquals(competitor.watermark_visible, true);
  const upd = captured.find((c) => c.op === 'update');
  assert(upd, 'expected an UPDATE call');
  assertEquals(upd!.values!.competitor, competitor);
});

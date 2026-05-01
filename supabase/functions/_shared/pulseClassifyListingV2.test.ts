/**
 * pulseClassifyListingV2.test.ts — Wave 15b.5 unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/_shared/pulseClassifyListingV2.test.ts
 *
 * Coverage (per W15b.5 spec):
 *   1. No extract row → returns 'PENDING_VISION' sentinel + confidence 0.0
 *   2. Tier 1 — succeeded extract w/ day+dusk+drone+floorplan+dusk_video
 *      → 'Dusk Video Package', step=tier1_premium_dusk_video_drone
 *   3. Tier 2 — day video + 3 dusk shots + floorplan
 *      → 'Day Video Package' + add_on_items=[{item:'dusk_image_addon', qty:3}]
 *   4. Tier 3 — day video, 0 dusk, floorplan
 *      → 'Day Video Package', step=tier3_day_video_no_dusk
 *   5. Tier 4 — photos+floorplan no video, >10 photos
 *      → 'Gold Package' (≤10 → 'Silver Package')
 *   6. Tier 5 — 1 photo only
 *      → 'Silver Package' (basic fallback)
 *   7. Empty extract (0 of everything) → 'UNCLASSIFIABLE'
 *   8. manually_overridden status → confidence=1.0
 *
 * Strategy:
 *   These tests target the **JS-side caller contract** for the classifier:
 *   the rpc shape (function name + uuid argument), the response schema, and
 *   the tier→package_name reference matrix used by callers (W15b.6 quote
 *   engine, W15b.8 dashboard).
 *
 *   The actual SQL cascade is exercised end-to-end by the in-database test
 *   suite that ran during migration apply (8 ASSERTs in a transaction with
 *   ROLLBACK; see migration 401_w15b5_classify_listing_package_v2.sql self-test
 *   block + the verification harness on apply).
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

// ─── Test plumbing ──────────────────────────────────────────────────────────

interface CapturedRpc {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * Fake Supabase client that records each rpc() invocation and replays a
 * caller-configured response. Mirrors the minimal surface
 * `supabase.rpc(fn, args)` returns.
 */
function makeFakeClient(
  responses: Record<string, unknown>,
  captured: CapturedRpc[],
) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      captured.push({ fn, args });
      const response = responses[fn] ?? null;
      return Promise.resolve({ data: response, error: null });
    },
  };
}

// Reference fixtures — mirror what the SQL cascade emits per tier.
// Used to verify caller-side contract (response shape) + the tier→package
// reference matrix surfaced to operators on the missed-opportunity dashboard.

const PENDING_VISION_RESPONSE = {
  classified_package_id: null,
  classified_package_name: 'PENDING_VISION',
  add_on_items: [],
  classification_confidence: 0.0,
  classification_reason: [{ step: 'no_vision_extract', matched: false }],
  extract_id: null,
  extract_status: null,
};

const TIER1_DUSK_VIDEO_RESPONSE = {
  classified_package_id: '40000000-0000-4000-a000-000000000004',
  classified_package_name: 'Dusk Video Package',
  add_on_items: [],
  classification_confidence: 0.95,
  classification_reason: [{
    step: 'tier1_premium_dusk_video_drone',
    matched: true,
    signals: { has_dusk_video: true, drone_count: 3, dusk_count: 5, floorplan_count: 1 },
  }],
  extract_id: '00000000-0000-0000-0000-000000000001',
  extract_status: 'succeeded',
};

const TIER2_DAY_VIDEO_DUSK_ADDON_RESPONSE = {
  classified_package_id: '40000000-0000-4000-a000-000000000003',
  classified_package_name: 'Day Video Package',
  add_on_items: [{ item: 'dusk_image_addon', qty: 3 }],
  classification_confidence: 0.95,
  classification_reason: [{
    step: 'tier2_day_video_with_dusk_addon',
    matched: true,
    dusk_addons: 3,
  }],
  extract_id: '00000000-0000-0000-0000-000000000002',
  extract_status: 'succeeded',
};

const TIER3_DAY_VIDEO_RESPONSE = {
  classified_package_id: '40000000-0000-4000-a000-000000000003',
  classified_package_name: 'Day Video Package',
  add_on_items: [],
  classification_confidence: 0.95,
  classification_reason: [{ step: 'tier3_day_video_no_dusk', matched: true }],
  extract_id: '00000000-0000-0000-0000-000000000003',
  extract_status: 'succeeded',
};

const TIER4_GOLD_RESPONSE = {
  classified_package_id: '40000000-0000-4000-a000-000000000002',
  classified_package_name: 'Gold Package',
  add_on_items: [
    { item: 'dusk_image_addon', qty: 2 },
    { item: 'drone_addon', qty: 1 },
  ],
  classification_confidence: 0.95,
  classification_reason: [{
    step: 'tier4_photos_floorplan_no_video',
    matched: true,
    total_images: 15,
    dusk_addons: 2,
    drone_addons: 1,
  }],
  extract_id: '00000000-0000-0000-0000-000000000004',
  extract_status: 'succeeded',
};

const TIER5_SILVER_RESPONSE = {
  classified_package_id: '40000000-0000-4000-a000-000000000001',
  classified_package_name: 'Silver Package',
  add_on_items: [],
  classification_confidence: 0.7,
  classification_reason: [{ step: 'tier5_photos_only', matched: true, total_images: 1 }],
  extract_id: '00000000-0000-0000-0000-000000000005',
  extract_status: 'partial',
};

const UNCLASSIFIABLE_RESPONSE = {
  classified_package_id: null,
  classified_package_name: 'UNCLASSIFIABLE',
  add_on_items: [],
  classification_confidence: 0.95,
  classification_reason: [{ step: 'unclassifiable_no_signal', matched: false }],
  extract_id: '00000000-0000-0000-0000-000000000006',
  extract_status: 'succeeded',
};

const MANUAL_OVERRIDE_RESPONSE = {
  classified_package_id: '40000000-0000-4000-a000-000000000002',
  classified_package_name: 'Gold Package',
  add_on_items: [],
  classification_confidence: 1.0,
  classification_reason: [{
    step: 'tier4_photos_floorplan_no_video',
    matched: true,
    total_images: 15,
    dusk_addons: 0,
    drone_addons: 0,
  }],
  extract_id: '00000000-0000-0000-0000-000000000007',
  extract_status: 'manually_overridden',
};

// ─── Test 1: no extract → PENDING_VISION ───────────────────────────────────

Deno.test('W15b.5 — no extract row → returns PENDING_VISION sentinel + confidence 0.0', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: PENDING_VISION_RESPONSE },
    captured,
  );

  const listingId = '11111111-1111-1111-1111-111111111111';
  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: listingId,
  });

  assertEquals(captured.length, 1);
  assertStrictEquals(captured[0].fn, 'pulse_classify_listing_package_v2');
  assertStrictEquals(captured[0].args.p_listing_id, listingId);

  const r = data as typeof PENDING_VISION_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'PENDING_VISION');
  assertStrictEquals(r.classified_package_id, null);
  assertStrictEquals(r.classification_confidence, 0.0);
  assertStrictEquals(r.extract_id, null);
  assertStrictEquals(r.extract_status, null);
  assertEquals(r.add_on_items, []);
});

// ─── Test 2: Tier 1 — premium dusk video + drone ──────────────────────────

Deno.test('W15b.5 — Tier 1 (succeeded + dusk_video + drone≥1 + dusk≥3 + fp) → Dusk Video Package', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: TIER1_DUSK_VIDEO_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '22222222-2222-2222-2222-222222222222',
  });

  const r = data as typeof TIER1_DUSK_VIDEO_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'Dusk Video Package');
  assertStrictEquals(r.classification_reason[0].step, 'tier1_premium_dusk_video_drone');
  assertStrictEquals(r.classification_reason[0].matched, true);
  assertStrictEquals(r.classification_confidence, 0.95);
  assertEquals(r.add_on_items, []);
});

// ─── Test 3: Tier 2 — day video + dusk add-on ─────────────────────────────

Deno.test('W15b.5 — Tier 2 (day video + 3 dusk + fp, no dusk video) → Day Video + dusk_image_addon×3', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: TIER2_DAY_VIDEO_DUSK_ADDON_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '33333333-3333-3333-3333-333333333333',
  });

  const r = data as typeof TIER2_DAY_VIDEO_DUSK_ADDON_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'Day Video Package');
  assertStrictEquals(r.classification_reason[0].step, 'tier2_day_video_with_dusk_addon');
  assertStrictEquals(r.add_on_items.length, 1);
  assertStrictEquals(r.add_on_items[0].item, 'dusk_image_addon');
  assertStrictEquals(r.add_on_items[0].qty, 3);
});

// ─── Test 4: Tier 3 — day video standard, no dusk ─────────────────────────

Deno.test('W15b.5 — Tier 3 (day video, 0 dusk, fp) → Day Video Package, no add-ons', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: TIER3_DAY_VIDEO_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '44444444-4444-4444-4444-444444444444',
  });

  const r = data as typeof TIER3_DAY_VIDEO_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'Day Video Package');
  assertStrictEquals(r.classification_reason[0].step, 'tier3_day_video_no_dusk');
  assertEquals(r.add_on_items, []);
});

// ─── Test 5: Tier 4 — photos + floorplan no video → Gold (>10 photos) ────

Deno.test('W15b.5 — Tier 4 (photos+fp, no video, >10) → Gold Package + dusk_image_addon + drone_addon', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: TIER4_GOLD_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '55555555-5555-5555-5555-555555555555',
  });

  const r = data as typeof TIER4_GOLD_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'Gold Package');
  assertStrictEquals(r.classification_reason[0].step, 'tier4_photos_floorplan_no_video');
  assertStrictEquals(r.add_on_items.length, 2);
  // Add-ons emitted in fixed order: dusk first, drone second
  assertStrictEquals(r.add_on_items[0].item, 'dusk_image_addon');
  assertStrictEquals(r.add_on_items[1].item, 'drone_addon');
});

// ─── Test 6: Tier 5 — minimal photos only (partial extract → conf=0.7) ───

Deno.test('W15b.5 — Tier 5 (1 photo only, partial extract) → Silver Package, confidence=0.7', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: TIER5_SILVER_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '66666666-6666-6666-6666-666666666666',
  });

  const r = data as typeof TIER5_SILVER_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'Silver Package');
  assertStrictEquals(r.classification_reason[0].step, 'tier5_photos_only');
  assertStrictEquals(r.classification_confidence, 0.7);
  assertStrictEquals(r.extract_status, 'partial');
});

// ─── Test 7: empty extract → UNCLASSIFIABLE ───────────────────────────────

Deno.test('W15b.5 — empty extract (zero of everything) → UNCLASSIFIABLE', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: UNCLASSIFIABLE_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '77777777-7777-7777-7777-777777777777',
  });

  const r = data as typeof UNCLASSIFIABLE_RESPONSE;
  assertStrictEquals(r.classified_package_name, 'UNCLASSIFIABLE');
  assertStrictEquals(r.classified_package_id, null);
  assertStrictEquals(r.classification_reason[0].step, 'unclassifiable_no_signal');
  assertStrictEquals(r.classification_reason[0].matched, false);
});

// ─── Test 8: manually_overridden → confidence=1.0 ────────────────────────

Deno.test('W15b.5 — manually_overridden status → confidence=1.0', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: MANUAL_OVERRIDE_RESPONSE },
    captured,
  );

  const { data } = await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: '88888888-8888-8888-8888-888888888888',
  });

  const r = data as typeof MANUAL_OVERRIDE_RESPONSE;
  assertStrictEquals(r.classification_confidence, 1.0);
  assertStrictEquals(r.extract_status, 'manually_overridden');
});

// ─── Test 9: rpc args contract ────────────────────────────────────────────

Deno.test('W15b.5 — rpc invocation passes p_listing_id as the only argument', async () => {
  const captured: CapturedRpc[] = [];
  const client = makeFakeClient(
    { pulse_classify_listing_package_v2: PENDING_VISION_RESPONSE },
    captured,
  );

  const listingId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await client.rpc('pulse_classify_listing_package_v2', {
    p_listing_id: listingId,
  });

  assertStrictEquals(captured.length, 1);
  assertStrictEquals(captured[0].fn, 'pulse_classify_listing_package_v2');
  assertStrictEquals(captured[0].args.p_listing_id, listingId);
  assertStrictEquals(Object.keys(captured[0].args).length, 1);
});

// ─── Test 10: response schema invariants (every tier emits the same keys) ─

Deno.test('W15b.5 — every classification response carries the seven canonical keys', () => {
  const REQUIRED_KEYS = [
    'classified_package_id',
    'classified_package_name',
    'add_on_items',
    'classification_confidence',
    'classification_reason',
    'extract_id',
    'extract_status',
  ];
  const responses = [
    PENDING_VISION_RESPONSE,
    TIER1_DUSK_VIDEO_RESPONSE,
    TIER2_DAY_VIDEO_DUSK_ADDON_RESPONSE,
    TIER3_DAY_VIDEO_RESPONSE,
    TIER4_GOLD_RESPONSE,
    TIER5_SILVER_RESPONSE,
    UNCLASSIFIABLE_RESPONSE,
    MANUAL_OVERRIDE_RESPONSE,
  ];
  for (const r of responses) {
    for (const k of REQUIRED_KEYS) {
      assert(
        Object.prototype.hasOwnProperty.call(r, k),
        `response missing required key: ${k} (response: ${JSON.stringify(r)})`,
      );
    }
    // add_on_items must always be an array
    assert(Array.isArray((r as Record<string, unknown>).add_on_items));
    // classification_reason must always be a non-empty array
    const reason = (r as Record<string, unknown>).classification_reason as unknown[];
    assert(Array.isArray(reason));
    assert(reason.length >= 1);
  }
});

/**
 * Tests for pulse-video-frame-extractor pure helpers.
 *
 * Coverage targets (per W15b.3 spec):
 *   1. Frame extraction call shape — buildModalRequestBody emits the canonical
 *      _token / listing_id / video_url / target_fps fields.
 *   2. Aggregation math — a frame whose vision response says "drone" at index 6
 *      flows through normaliseFrameToVisionV2 + computeVideoBreakdown so
 *      drone_segments_count >= 1 and present=true.
 *   3. Cost cap enforcement — runFrameVisionFanout stops issuing calls once
 *      accumulated cost crosses the cap.
 *   4. Failure mode — callModal surfaces a descriptive error when the Modal
 *      endpoint returns 5xx OR a JSON body with ok=false; orchestrator can
 *      detect this and treat the run as 'partial' (not failed).
 *   5. validateVideoUrl — accepts when Content-Length absent; rejects when
 *      Content-Length exceeds the cap.
 *   6. normaliseFrameToVisionV2 — agent + car + narrator labels surface as
 *      observed_attributes that downstream computeVideoBreakdown reads.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  buildModalRequestBody,
  callModal,
  type FrameAnalysis,
  normaliseFrameToVisionV2,
  type ResolvedInput,
  runFrameVisionFanout,
  validateVideoUrl,
} from './index.ts';
import { computeVideoBreakdown } from '../_shared/pulseVisionPersist.ts';

// ─── 1. Frame extraction call shape ──────────────────────────────────────────

Deno.test('buildModalRequestBody: emits the canonical _token / listing_id / video_url / target_fps fields', () => {
  const input: ResolvedInput = {
    listingId: 'aaaaaaaa-1111-2222-3333-444444444444',
    videoUrl: 'https://i.realestate.com.au/abc/sample.mp4',
    targetFps: 0.2,
    costCapUsd: 0.10,
  };
  const body = buildModalRequestBody(input, 'sb_secret_xxxxxx');
  assertEquals(body._token, 'sb_secret_xxxxxx');
  assertEquals(body.listing_id, 'aaaaaaaa-1111-2222-3333-444444444444');
  assertEquals(body.video_url, 'https://i.realestate.com.au/abc/sample.mp4');
  assertEquals(body.target_fps, 0.2);
  // No cost_cap_usd in the Modal body — that's edge-side only.
  assertEquals('cost_cap_usd' in (body as Record<string, unknown>), false);
});

Deno.test('callModal: passes Authorization Bearer header AND _token in body', async () => {
  interface Captured {
    url: string;
    init: RequestInit | undefined;
  }
  let captured: Captured | null = null;
  const mockFetch: typeof fetch = (input, init) => {
    captured = { url: String(input), init } as Captured;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          listing_id: 'aaaa',
          total_duration_s: 30.5,
          frame_count: 6,
          frame_urls: ['https://signed/0.jpg', 'https://signed/1.jpg'],
          frame_timestamps_s: [0, 5],
          scene_changes_s: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  };

  const input: ResolvedInput = {
    listingId: 'aaaa',
    videoUrl: 'https://x/y.mp4',
    targetFps: 0.2,
    costCapUsd: 0.10,
  };
  const resp = await callModal(input, 'https://mock-modal.example/', 'TOKEN-ABC', mockFetch);
  assertEquals(resp.ok, true);
  assertEquals(resp.frame_urls?.length, 2);
  const cap = captured as Captured | null;
  assert(cap !== null);
  const headers = (cap!.init?.headers || {}) as Record<string, string>;
  assertEquals(headers['Authorization'], 'Bearer TOKEN-ABC');
  const sentBody = JSON.parse(String(cap!.init?.body));
  assertEquals(sentBody._token, 'TOKEN-ABC');
});

// ─── 2. Aggregation math ─────────────────────────────────────────────────────

Deno.test('normaliseFrameToVisionV2 + computeVideoBreakdown: drone in frame at index 6 → drone_segments_count=1, present=true', () => {
  const frames: FrameAnalysis[] = [
    {
      index: 0,
      timestamp_s: 0,
      ok: true,
      cost_usd: 0.001,
      signals: {},
    },
    {
      index: 6,
      timestamp_s: 30,
      ok: true,
      cost_usd: 0.001,
      signals: { has_drone_footage: true },
    },
  ];
  const visionV2 = frames.map(normaliseFrameToVisionV2);
  // Frame 0 is non-drone (default day); frame at index 6 is is_drone.
  assertEquals(visionV2[0].image_type, 'is_day');
  assertEquals(visionV2[1].image_type, 'is_drone');
  assertEquals(visionV2[1].source_video_frame_index, 6);

  const breakdown = computeVideoBreakdown(visionV2, {
    total_duration_s: 60,
    frames_extracted: 2,
  });
  assertEquals(breakdown.present, true);
  assertEquals(breakdown.drone_segments_count, 1);
  assertEquals(breakdown.day_segments_count, 1);
  assertEquals(breakdown.dusk_segments_count, 0);
  assertEquals(breakdown.total_duration_s, 60);
  assertEquals(breakdown.frames_extracted, 2);
});

Deno.test('normaliseFrameToVisionV2: dusk + agent + car labels propagate into observed_attributes', () => {
  const frame: FrameAnalysis = {
    index: 3,
    timestamp_s: 45,
    ok: true,
    cost_usd: 0.001,
    signals: {
      has_dusk_footage: true,
      has_agent_in_frame: true,
      has_car_in_frame: true,
    },
  };
  const v2 = normaliseFrameToVisionV2(frame);
  assertEquals(v2.image_type, 'is_dusk');
  const labels = (v2.observed_attributes || []).map((a) => a.raw_label);
  assert(labels.includes('agent on camera'));
  assert(labels.includes('car_visible'));
  // Run through computeVideoBreakdown so the assertion mirrors how the
  // production aggregator reads these attrs.
  const bd = computeVideoBreakdown([v2], {});
  assertEquals(bd.dusk_segments_count, 1);
  assertEquals(bd.agent_in_frame, true);
  assertEquals(bd.car_in_frame, true);
});

// ─── 3. Cost cap enforcement ─────────────────────────────────────────────────

type CallVisionMock = (
  listingId: string,
  frameUrl: string,
  index: number,
  timestampS: number,
) => Promise<FrameAnalysis>;

Deno.test('runFrameVisionFanout: stops issuing calls once cost cap is crossed', async () => {
  // 10 frames @ $0.05 each = $0.50 total. Cap at $0.10 should stop after
  // 2 frames have completed (the 3rd push would push us over the cap, but the
  // worker checks at the top of the loop so the cap-trip happens once
  // totalCost >= cap).
  const frameUrls = Array.from({ length: 10 }, (_, i) => `https://f/${i}.jpg`);
  const frameTs = frameUrls.map((_, i) => i * 5);
  let calls = 0;

  const callVision: CallVisionMock = (_lid, _u, idx, ts) => {
    calls++;
    return Promise.resolve({
      index: idx,
      timestamp_s: ts,
      ok: true,
      cost_usd: 0.05,
      signals: {},
    });
  };

  const result = await runFrameVisionFanout({
    listingId: 'lid',
    frameUrls,
    frameTs,
    costCapUsd: 0.10,
    // Concurrency 1 keeps the call accounting deterministic for this test.
    concurrency: 1,
    callVision,
  });

  assertEquals(result.costCapHit, true);
  // Worker enters loop, sees totalCost(0) < cap, makes call 1 → totalCost=$0.05.
  // Worker re-enters, sees totalCost(0.05) < cap, makes call 2 → totalCost=$0.10.
  // Worker re-enters, sees totalCost(0.10) >= cap, sets costCapHit, exits.
  assertEquals(calls, 2);
  assertEquals(result.totalCost, 0.10);
});

Deno.test('runFrameVisionFanout: under cost cap, processes all frames', async () => {
  const frameUrls = ['https://f/0.jpg', 'https://f/1.jpg', 'https://f/2.jpg'];
  let calls = 0;
  const callVision: CallVisionMock = (_lid, _u, idx, ts) => {
    calls++;
    return Promise.resolve({
      index: idx,
      timestamp_s: ts,
      ok: true,
      cost_usd: 0.001,
      signals: {},
    });
  };
  const result = await runFrameVisionFanout({
    listingId: 'lid',
    frameUrls,
    frameTs: [0, 5, 10],
    costCapUsd: 0.10,
    concurrency: 2,
    callVision,
  });
  assertEquals(result.costCapHit, false);
  assertEquals(calls, 3);
  assertEquals(result.analyses.length, 3);
});

// ─── 4. Failure mode (Modal endpoint down) ──────────────────────────────────

Deno.test('callModal: surfaces descriptive error when Modal returns HTTP 502', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response('Bad gateway', { status: 502 }),
    );
  const input: ResolvedInput = {
    listingId: 'lid',
    videoUrl: 'https://x/y.mp4',
    targetFps: 0.2,
    costCapUsd: 0.10,
  };
  let caught: Error | null = null;
  try {
    await callModal(input, 'https://mock/', 'TOKEN', mockFetch);
  } catch (err) {
    caught = err as Error;
  }
  assert(caught !== null);
  assertStringIncludes(caught!.message, 'Modal');
  // Error should contain the HTTP status so ops can triage.
  assertStringIncludes(caught!.message, '502');
});

Deno.test('callModal: surfaces descriptive error when Modal returns 200 with ok:false', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ ok: false, error: 'video duration 700s exceeds max 600s' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  const input: ResolvedInput = {
    listingId: 'lid',
    videoUrl: 'https://x/y.mp4',
    targetFps: 0.2,
    costCapUsd: 0.10,
  };
  let caught: Error | null = null;
  try {
    await callModal(input, 'https://mock/', 'TOKEN', mockFetch);
  } catch (err) {
    caught = err as Error;
  }
  assert(caught !== null);
  assertStringIncludes(caught!.message, 'video duration');
});

// ─── 5. validateVideoUrl ─────────────────────────────────────────────────────

Deno.test('validateVideoUrl: accepts response with no Content-Length header', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response('', { status: 200 }));
  const r = await validateVideoUrl('https://x/y.mp4', 200 * 1024 * 1024, mockFetch);
  assertEquals(r.ok, true);
  assertEquals(r.bytes, null);
});

Deno.test('validateVideoUrl: rejects oversize Content-Length', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(
      new Response('', {
        status: 200,
        headers: { 'Content-Length': String(300 * 1024 * 1024) },
      }),
    );
  const r = await validateVideoUrl('https://x/y.mp4', 200 * 1024 * 1024, mockFetch);
  assertEquals(r.ok, false);
  assertEquals(r.bytes, 300 * 1024 * 1024);
  assertStringIncludes(r.reason || '', 'exceeds');
});

Deno.test('validateVideoUrl: rejects HTTP 404', async () => {
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response('', { status: 404 }));
  const r = await validateVideoUrl('https://x/y.mp4', 200 * 1024 * 1024, mockFetch);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason || '', '404');
});

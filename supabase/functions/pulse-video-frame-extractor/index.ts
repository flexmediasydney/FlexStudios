/**
 * pulse-video-frame-extractor
 * ───────────────────────────
 * Wave 15b.3 — orchestrates frame extraction + per-frame vision analysis for
 * a Pulse listing's `video_url`.
 *
 * Pipeline:
 *   1. Resolve `{listing_id, video_url}` (from body or pulled off the listing).
 *   2. Validate `video_url` is reachable + within size cap (HEAD).
 *   3. POST to the Modal `pulse-video-frame-extractor` endpoint, which:
 *        - downloads the MP4
 *        - extracts frames at target_fps + scene-change boundaries
 *        - uploads each frame to Supabase Storage `pulse-video-frames`
 *        - returns N signed URLs + their timestamps + scene changes
 *   4. For each frame URL, invoke W15b.1's `pulse-listing-vision-extract` with
 *      `{listing_id, image_urls: [frame_url], media_kind: 'video_frame'}`
 *      (concurrent with bounded fan-out).
 *   5. Aggregate the frame analyses into a `video_breakdown` JSONB and persist
 *      via W15b.2's `aggregateVideoResults` helper. The vision response shape
 *      is normalised to `VisionResponseV2` (image_type + observed_attributes)
 *      so the helper can reuse its segment-counting logic.
 *
 * Cost cap is tracked separately from the image cap; recorded onto the extract
 * row's total_cost_usd column.
 *
 * Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md (W15b.3).
 *
 * Invocation modes:
 *   - { listing_id, video_url? }       — direct master_admin call.
 *   - { listing_id }                    — pulls video_url off pulse_listings.
 *   - { _health_check: true }           — version stamp.
 *
 * NOTE: Modal deployment is a manual one-time step. See
 *   modal/pulse-video-frame-extractor/README.md.
 * Until `MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL` is set on the Supabase project,
 * this function returns 503 with a clear ops error.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import {
  aggregateVideoResults,
  createPulseVisionExtract,
  markPulseVisionExtractFailed,
  type ObservedAttribute,
  type VideoBreakdown,
  type VisionResponseV2,
} from '../_shared/pulseVisionPersist.ts';

const GENERATOR = 'pulse-video-frame-extractor';
const VERSION = 'v1.0';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TARGET_FPS = 0.2;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB
const HEAD_TIMEOUT_MS = 15_000;
const MODAL_TIMEOUT_MS = 5 * 60 * 1000; // 300s — matches Modal endpoint timeout
const VISION_TIMEOUT_MS = 90_000;
const VISION_CONCURRENCY = 4;
// Cost cap (USD) per video. Each frame is one Gemini-Flash vision call ~$0.0014;
// 60-frame cap × 0.0014 = $0.084. Round to $0.10 per video as the default cap.
const DEFAULT_COST_CAP_USD = 0.10;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const MODAL_URL = Deno.env.get('MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL') || '';
// Optional dedicated dispatcher JWT (mirrors drone-job-dispatcher pattern).
// Falls back to SERVICE_ROLE_KEY when unset.
const DISPATCHER_JWT =
  Deno.env.get('PULSE_DISPATCHER_JWT') || SUPABASE_SERVICE_ROLE_KEY;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RequestBody {
  listing_id?: string;
  video_url?: string;
  target_fps?: number;
  cost_cap_usd?: number;
  _health_check?: boolean;
}

export interface ModalFrameResponse {
  ok: boolean;
  listing_id?: string;
  video_url?: string;
  total_duration_s?: number;
  target_fps?: number;
  frame_count?: number;
  frame_urls?: string[];
  frame_timestamps_s?: number[];
  scene_changes_s?: number[];
  elapsed_seconds?: number;
  error?: string;
}

export interface ResolvedInput {
  listingId: string;
  videoUrl: string;
  targetFps: number;
  costCapUsd: number;
}

export interface FrameAnalysis {
  index: number;
  timestamp_s: number;
  ok: boolean;
  cost_usd: number;
  /** W15b.1 vision response signals — see normaliseFrameToVisionV2 doc. */
  signals: Record<string, unknown>;
  /** Free-form labels surfaced from observed_attributes (lowercased). */
  observed_labels?: string[];
  error?: string;
}

interface ExtractRunResult {
  ok: boolean;
  status: 'succeeded' | 'partial' | 'failed';
  listing_id: string;
  extract_id: string | null;
  total_duration_s: number;
  frame_count: number;
  frames_analyzed: number;
  total_cost_usd: number;
  scene_change_count: number;
  video_breakdown: VideoBreakdown | null;
  errors: string[];
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden — master_admin only', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }

  if (body._health_check) {
    return jsonResponse(
      {
        _version: VERSION,
        _fn: GENERATOR,
        modal_configured: Boolean(MODAL_URL),
      },
      200,
      req,
    );
  }

  if (!MODAL_URL) {
    return errorResponse(
      'MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL not configured — see modal/pulse-video-frame-extractor/README.md',
      503,
      req,
    );
  }
  if (!SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_URL) {
    return errorResponse('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL not configured', 500, req);
  }

  let input: ResolvedInput;
  try {
    input = await resolveInput(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 400, req);
  }

  try {
    const result = await runExtraction(input);
    const status = result.status === 'failed' ? 502 : 200;
    return jsonResponse(result, status, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed: ${msg}`);
    return errorResponse(`pulse-video-frame-extractor failed: ${msg}`, 500, req);
  }
});

// ─── Input resolution ────────────────────────────────────────────────────────

async function resolveInput(body: RequestBody): Promise<ResolvedInput> {
  if (!body.listing_id || typeof body.listing_id !== 'string') {
    throw new Error('listing_id required');
  }
  let videoUrl = (body.video_url || '').trim();
  if (!videoUrl) {
    const admin = getAdminClient();
    const { data: row, error } = await admin
      .from('pulse_listings')
      .select('id, video_url')
      .eq('id', body.listing_id)
      .maybeSingle();
    if (error) throw new Error(`pulse_listings lookup failed: ${error.message}`);
    if (!row) throw new Error(`pulse_listing ${body.listing_id} not found`);
    if (!row.video_url) {
      throw new Error(`pulse_listing ${body.listing_id} has no video_url`);
    }
    videoUrl = String(row.video_url).trim();
  }
  if (!/^https?:\/\//i.test(videoUrl)) {
    throw new Error(`video_url must be http(s): got "${videoUrl.slice(0, 80)}"`);
  }

  const targetFps = body.target_fps ?? DEFAULT_TARGET_FPS;
  if (typeof targetFps !== 'number' || targetFps <= 0 || targetFps > 5) {
    throw new Error('target_fps must be a number in (0, 5]');
  }
  const costCapUsd = body.cost_cap_usd ?? DEFAULT_COST_CAP_USD;
  if (typeof costCapUsd !== 'number' || costCapUsd <= 0) {
    throw new Error('cost_cap_usd must be a positive number');
  }

  return {
    listingId: body.listing_id,
    videoUrl,
    targetFps,
    costCapUsd,
  };
}

// ─── HEAD validation ─────────────────────────────────────────────────────────

/**
 * Best-effort size + reachability check via HTTP HEAD. Many CDNs (REA included)
 * don't return a Content-Length on HEAD; in that case we accept and let the
 * Modal endpoint enforce the size cap on the streaming download.
 *
 * Pure (only does network I/O); accepts a fetch impl for testing.
 */
export async function validateVideoUrl(
  videoUrl: string,
  maxBytes = MAX_VIDEO_BYTES,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; bytes: number | null; reason?: string }> {
  try {
    const resp = await fetchImpl(videoUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return {
        ok: false,
        bytes: null,
        reason: `HEAD returned HTTP ${resp.status}`,
      };
    }
    const cl = resp.headers.get('content-length');
    if (!cl) return { ok: true, bytes: null };
    const n = Number(cl);
    if (!Number.isFinite(n)) return { ok: true, bytes: null };
    if (n > maxBytes) {
      return {
        ok: false,
        bytes: n,
        reason: `Content-Length ${n} exceeds ${maxBytes}`,
      };
    }
    return { ok: true, bytes: n };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, bytes: null, reason: `HEAD failed: ${msg}` };
  }
}

// ─── Modal call ──────────────────────────────────────────────────────────────

/**
 * Pure helper that builds the Modal request body. Exported for tests so we can
 * assert the call shape without firing a real network call.
 */
export function buildModalRequestBody(
  input: ResolvedInput,
  serviceRoleKey: string,
): Record<string, unknown> {
  return {
    _token: serviceRoleKey,
    listing_id: input.listingId,
    video_url: input.videoUrl,
    target_fps: input.targetFps,
  };
}

export async function callModal(
  input: ResolvedInput,
  modalUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModalFrameResponse> {
  const body = buildModalRequestBody(input, serviceRoleKey);
  const resp = await fetchImpl(modalUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });
  const text = await resp.text().catch(() => '');
  let parsed: ModalFrameResponse;
  try {
    parsed = JSON.parse(text || '{}') as ModalFrameResponse;
  } catch {
    throw new Error(`Modal returned non-JSON body (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok || !parsed.ok) {
    const reason = parsed.error || `HTTP ${resp.status}: ${text.slice(0, 200)}`;
    throw new Error(`Modal frame extract failed: ${reason}`);
  }
  return parsed;
}

// ─── Per-frame vision call ───────────────────────────────────────────────────

async function callVisionForFrame(
  listingId: string,
  frameUrl: string,
  index: number,
  timestampS: number,
): Promise<FrameAnalysis> {
  const url = `${SUPABASE_URL}/functions/v1/pulse-listing-vision-extract`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DISPATCHER_JWT}`,
        'x-caller-context': GENERATOR,
      },
      body: JSON.stringify({
        listing_id: listingId,
        image_urls: [frameUrl],
        media_kind: 'video_frame',
        media_index: index,
        media_timestamp_s: timestampS,
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    const rawText = await resp.text().catch(() => '');
    let parsed: Record<string, unknown> = {};
    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch {
      // fall through; we'll surface error below
    }
    if (!resp.ok || parsed.ok === false) {
      const reason =
        (typeof parsed.error === 'string' && parsed.error) ||
        `HTTP ${resp.status}: ${rawText.slice(0, 200)}`;
      return {
        index,
        timestamp_s: timestampS,
        ok: false,
        cost_usd: 0,
        error: reason,
        signals: {},
      };
    }
    // Vision response shape (W15b.1 contract):
    //   { ok: true, signals: { has_drone, has_agent_in_frame, has_dusk, ... },
    //     cost_usd: number,
    //     observed_labels?: string[] }
    const signals = (parsed.signals && typeof parsed.signals === 'object'
      ? parsed.signals
      : {}) as Record<string, unknown>;
    const costRaw = (parsed as Record<string, unknown>).cost_usd;
    const cost = typeof costRaw === 'number' ? costRaw : 0;
    const labelsRaw = (parsed as Record<string, unknown>).observed_labels;
    const observed_labels = Array.isArray(labelsRaw)
      ? (labelsRaw as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.toLowerCase())
      : undefined;
    return {
      index,
      timestamp_s: timestampS,
      ok: true,
      cost_usd: cost,
      signals,
      observed_labels,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      index,
      timestamp_s: timestampS,
      ok: false,
      cost_usd: 0,
      error: msg,
      signals: {},
    };
  }
}

// ─── Vision result → VisionResponseV2 normaliser ─────────────────────────────

/**
 * Convert a frame's signals + observed labels into the VisionResponseV2 shape
 * that W15b.2's aggregateVideoResults expects.
 *
 * Mapping rules:
 *   - has_drone_footage / has_drone     → image_type='is_drone'
 *   - has_dusk_footage / has_dusk       → image_type='is_dusk'
 *   - default lighting=day              → image_type='is_day'
 *   - has_agent_in_frame                → emits an observed_attribute with
 *                                         raw_label='agent on camera'
 *   - has_car_in_frame                  → emits raw_label='car_visible'
 *   - has_narrator                      → raw_label='narrator'
 *
 * Pure function — exported for tests.
 */
export function normaliseFrameToVisionV2(frame: FrameAnalysis): VisionResponseV2 {
  const sig = frame.signals || {};
  const isDrone = bool(sig.has_drone_footage) || bool(sig.has_drone);
  const isDusk = bool(sig.has_dusk_footage) || bool(sig.has_dusk);
  const hasAgent =
    bool(sig.has_agent_in_frame) ||
    bool(sig.has_agent) ||
    (frame.observed_labels?.some((l) => l.includes('agent')) ?? false);
  const hasCar =
    bool(sig.has_car_in_frame) ||
    bool(sig.has_car) ||
    (frame.observed_labels?.some((l) => l.includes('car')) ?? false);
  const hasNarrator =
    bool(sig.has_narrator) ||
    bool(sig.narrator_inferred) ||
    (frame.observed_labels?.some(
      (l) => l.includes('narrator') || l.includes('voiceover'),
    ) ?? false);

  let image_type: VisionResponseV2['image_type'] = 'is_day';
  if (isDrone) image_type = 'is_drone';
  else if (isDusk) image_type = 'is_dusk';

  const observed_attributes: ObservedAttribute[] = [];
  if (hasAgent) observed_attributes.push({ raw_label: 'agent on camera' });
  if (hasCar) observed_attributes.push({ raw_label: 'car_visible' });
  if (hasNarrator) observed_attributes.push({ raw_label: 'narrator' });

  return {
    image_type,
    observed_attributes,
    source_video_frame_index: frame.index,
  };
}

function bool(v: unknown): boolean {
  return v === true;
}

// ─── Fan-out + cost cap (pure-ish — accepts a callVision injection) ──────────

export interface FanoutInput {
  listingId: string;
  frameUrls: string[];
  frameTs: number[];
  costCapUsd: number;
  concurrency: number;
  /** Injected per-frame vision call. Real impl uses fetch; tests inject mock. */
  callVision: (
    listingId: string,
    frameUrl: string,
    index: number,
    timestampS: number,
  ) => Promise<FrameAnalysis>;
}

export interface FanoutResult {
  analyses: FrameAnalysis[];
  totalCost: number;
  costCapHit: boolean;
  errors: string[];
}

/**
 * Run bounded-concurrency vision calls over frame URLs, stopping when the
 * accumulated cost crosses `costCapUsd`. Pure-ish — accepts a `callVision`
 * function so tests can inject a deterministic mock and assert cost-cap and
 * fan-out behaviour without firing network calls.
 */
export async function runFrameVisionFanout(
  inp: FanoutInput,
): Promise<FanoutResult> {
  const { listingId, frameUrls, frameTs, costCapUsd, concurrency, callVision } = inp;
  const analyses: FrameAnalysis[] = new Array(frameUrls.length);
  let totalCost = 0;
  let cursor = 0;
  let costCapHit = false;
  const errors: string[] = [];

  const worker = async () => {
    while (true) {
      if (costCapHit) return;
      const i = cursor++;
      if (i >= frameUrls.length) return;
      if (totalCost >= costCapUsd) {
        costCapHit = true;
        return;
      }
      const result = await callVision(listingId, frameUrls[i], i, frameTs[i] ?? 0);
      analyses[i] = result;
      totalCost += result.cost_usd;
      if (!result.ok && result.error) errors.push(`frame[${i}]: ${result.error}`);
    }
  };
  const workers: Array<Promise<void>> = [];
  const poolSize = Math.min(concurrency, frameUrls.length);
  for (let w = 0; w < poolSize; w++) workers.push(worker());
  await Promise.all(workers);

  return { analyses, totalCost, costCapHit, errors };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

async function runExtraction(input: ResolvedInput): Promise<ExtractRunResult> {
  const errors: string[] = [];
  const admin = getAdminClient();

  // Reserve / find the extract row up-front so the row exists even if Modal
  // fails — operators can see the partial state in the dashboard.
  let extractId: string | null = null;
  try {
    const { extract_id } = await createPulseVisionExtract(admin, {
      listing_id: input.listingId,
      triggered_by: 'operator_manual',
    });
    extractId = extract_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`extract row reserve failed: ${msg}`);
  }

  // 1. Validate the video URL
  const head = await validateVideoUrl(input.videoUrl);
  if (!head.ok) {
    if (extractId) {
      await markPulseVisionExtractFailed(
        admin,
        extractId,
        (head.reason || 'video URL HEAD validation failed').slice(0, 1000),
      ).catch(() => {});
    }
    return {
      ok: false,
      status: 'failed',
      listing_id: input.listingId,
      extract_id: extractId,
      total_duration_s: 0,
      frame_count: 0,
      frames_analyzed: 0,
      total_cost_usd: 0,
      scene_change_count: 0,
      video_breakdown: null,
      errors: [head.reason || 'video URL HEAD validation failed'],
    };
  }

  // 2. Call Modal
  let modalResp: ModalFrameResponse;
  try {
    modalResp = await callModal(input, MODAL_URL, SUPABASE_SERVICE_ROLE_KEY);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    // Modal failure is partial — write empty video_breakdown via aggregator
    // so the row reflects "we tried, got nothing back". Caller can retry.
    if (extractId) {
      await aggregateVideoResults(admin, extractId, [], {
        total_duration_s: null,
        frames_extracted: 0,
      }).catch(() => {});
    }
    return {
      ok: false,
      status: 'partial',
      listing_id: input.listingId,
      extract_id: extractId,
      total_duration_s: 0,
      frame_count: 0,
      frames_analyzed: 0,
      total_cost_usd: 0,
      scene_change_count: 0,
      video_breakdown: null,
      errors,
    };
  }

  const frameUrls = modalResp.frame_urls || [];
  const frameTs = modalResp.frame_timestamps_s || [];
  const sceneChanges = modalResp.scene_changes_s || [];
  const totalDuration = modalResp.total_duration_s || 0;

  if (frameUrls.length === 0) {
    errors.push('Modal returned 0 frames');
    if (extractId) {
      await aggregateVideoResults(admin, extractId, [], {
        total_duration_s: totalDuration,
        frames_extracted: 0,
      }).catch(() => {});
    }
    return {
      ok: false,
      status: 'partial',
      listing_id: input.listingId,
      extract_id: extractId,
      total_duration_s: totalDuration,
      frame_count: 0,
      frames_analyzed: 0,
      total_cost_usd: 0,
      scene_change_count: sceneChanges.length,
      video_breakdown: null,
      errors,
    };
  }

  // 3. Fan out vision calls (bounded concurrency, cost cap)
  const fanoutResult = await runFrameVisionFanout({
    listingId: input.listingId,
    frameUrls,
    frameTs,
    costCapUsd: input.costCapUsd,
    concurrency: VISION_CONCURRENCY,
    callVision: callVisionForFrame,
  });
  const analyses = fanoutResult.analyses;
  const totalCost = fanoutResult.totalCost;
  for (const e of fanoutResult.errors) errors.push(e);
  if (fanoutResult.costCapHit) {
    errors.push(
      `cost cap $${input.costCapUsd.toFixed(4)} reached after ${
        analyses.filter(Boolean).length
      } frames; remaining frames skipped`,
    );
  }

  // 4. Aggregate via W15b.2 helper
  const completed = analyses.filter((a) => a && a.ok);
  const visionV2 = completed.map(normaliseFrameToVisionV2);

  let videoBreakdown: VideoBreakdown | null = null;
  if (extractId) {
    try {
      videoBreakdown = await aggregateVideoResults(admin, extractId, visionV2, {
        total_duration_s: totalDuration,
        frames_extracted: completed.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`aggregateVideoResults failed: ${msg}`);
    }

    // Stamp per-video cost onto the extract row separately from the per-image
    // cost cap. We additively bump total_cost_usd so a follow-up image extract
    // pass doesn't clobber the video number.
    try {
      const { data: existing } = await admin
        .from('pulse_listing_vision_extracts')
        .select('total_cost_usd')
        .eq('id', extractId)
        .maybeSingle();
      const prior = Number(existing?.total_cost_usd) || 0;
      await admin
        .from('pulse_listing_vision_extracts')
        .update({ total_cost_usd: prior + totalCost })
        .eq('id', extractId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] cost stamp failed: ${msg}`);
    }
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'succeeded' : 'partial',
    listing_id: input.listingId,
    extract_id: extractId,
    total_duration_s: totalDuration,
    frame_count: frameUrls.length,
    frames_analyzed: completed.length,
    total_cost_usd: totalCost,
    scene_change_count: sceneChanges.length,
    video_breakdown: videoBreakdown,
    errors,
  };
}

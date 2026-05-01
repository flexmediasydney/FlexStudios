/**
 * pulseVisionPersist — Wave 15b.2 persistence helpers for the
 * `pulse_listing_vision_extracts` substrate (mig 400).
 *
 * Pure persistence functions consumed by the W15b family of edge functions:
 *   - W15b.1 (Flash extractor)         calls createPulseVisionExtract / mark*
 *   - W15b.3 (video frame extractor)   threads its output into the same row
 *   - W15b.5 (SQL classifier v2)       reads the aggregates this layer writes
 *
 * Design notes:
 *   * No vendor SDK calls in here — caller already produced the per-image
 *     classifications via composition_classifications. This module only
 *     aggregates and writes the rollup row.
 *   * Idempotency is enforced at the DB level via the unique index on
 *     (listing_id, schema_version). createPulseVisionExtract uses an upsert
 *     with onConflict='listing_id,schema_version' so re-creation returns the
 *     existing id without overwriting state.
 *   * Aggregation functions (aggregatePerImageResults / aggregateVideoResults
 *     / aggregateCompetitorBranding) are exported separately so they can be
 *     unit tested against pure-data inputs without a DB.
 *
 * Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Public types ───────────────────────────────────────────────────────────

export type PulseVisionExtractStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'manually_overridden';

export type PulseVisionTriggeredBy =
  | 'pulse_detail_enrich'
  | 'operator_manual'
  | 'mass_backfill';

/**
 * Per-image vision classification (subset of the W11.7.17 v2 universal vision
 * response we care about for W15b aggregation). The full row in
 * composition_classifications has many more fields; we only need the inputs
 * to roll up photo/competitor counts.
 *
 * The optional richer fields (`analysis`, `signal_scores`, `appeal_signals`,
 * `concern_signals`, `observed_objects`, `confidence_score`) are populated
 * when the vision call emits the W11 v2 universal schema (W15b.4 video
 * aggregator path) and undefined for the leaner W15b.1 image-classifier
 * shape. Aggregators MUST treat them as optional.
 */
export interface VisionResponseV2 {
  image_type:
    | 'is_day'
    | 'is_dusk'
    | 'is_drone'
    | 'is_agent_headshot'
    | 'is_test_shot'
    | 'is_bts'
    | 'is_floorplan'
    | 'is_video_frame'
    | 'is_detail_shot'
    | 'is_facade_hero'
    | 'is_other'
    | string;
  observed_attributes?: ObservedAttribute[] | null;
  /**
   * Free-form objects detected in the frame (W11 v2 "observed_objects"
   * stream). Each has a raw_label and an optional category /
   * proposed_canonical_id. W15b.4 reads `category === 'drone_shot'` and
   * branding categories off this stream.
   */
  observed_objects?: ObservedObject[] | null;
  /**
   * W11.6.14 lighting state for video-frame aggregation. Day/dusk/twilight/
   * night are the segmentation buckets; null/undefined frames are bucketed as
   * 'unknown' and excluded from has_*_segment flags.
   */
  analysis?: {
    lighting_state?: 'day' | 'dusk' | 'twilight' | 'night' | string | null;
  } | null;
  /**
   * Per-signal numeric scores. Keys match the W11 v2 26-signal taxonomy.
   * Aggregators take median + max + populated-frame-count across the video.
   */
  signal_scores?: Record<string, number | null | undefined> | null;
  /**
   * Marketing appeal hints surfaced by the model (e.g. "wide-open vista",
   * "natural light through bifold doors"). Aggregator counts frames with >=3.
   */
  appeal_signals?: string[] | null;
  /**
   * Concerns / detractors (e.g. "garage door open", "lawn patchy"). Aggregator
   * counts frames where this is non-empty.
   */
  concern_signals?: string[] | null;
  /**
   * High-level "how confident is this frame's classification" score.
   * Used to mean-aggregate per-segment confidence and to pick the
   * representative frame (median of segment).
   */
  confidence_score?: number | null;
  /**
   * Frame-aware spatial fields used by the aggregator's unique_spaces /
   * unique_zones rollups.
   */
  space_type?: string | null;
  zone_focus?: string | string[] | null;
  source_image_url?: string | null;
  source_video_frame_index?: number | null;
}

export interface ObservedAttribute {
  raw_label?: string | null;
  canonical_attribute_id?: string | null;
  canonical_value_id?: string | null;
  confidence?: number | null;
  /** Optional free-form anchor (e.g. "watermark in bottom-right corner"). */
  object_anchor?: string | null;
}

/**
 * W11 v2 observed_objects stream entry. Used by W15b.4 to detect drone shots
 * (category='drone_shot') and competitor branding (category='branding_overlay'
 * or raw_label includes a known competitor name). Tolerant of partial shapes
 * because Stage 1 emits a slimmer subset than Stage 2.
 */
export interface ObservedObject {
  raw_label?: string | null;
  category?: string | null;
  proposed_canonical_id?: string | null;
  confidence?: number | null;
}

/** Shape for video metadata threaded through from W15b.3. */
export interface VideoMetadata {
  total_duration_s?: number | null;
  frames_extracted?: number | null;
  /**
   * Per-frame timestamps in seconds, parallel array to the
   * `videoClassifications` argument. Required for richer segment detection
   * (W15b.4). When omitted, the aggregator falls back to legacy per-frame
   * counts only.
   */
  frame_timestamps_s?: number[] | null;
  /**
   * Timestamps (s) where the Modal pre-processor detected a scene change.
   * Used as hard-cuts in segment detection in addition to lighting_state
   * flips. Optional — defaults to empty.
   */
  scene_changes_s?: number[] | null;
}

/** Shape of the photo_breakdown JSONB. */
export interface PhotoBreakdown {
  day_count: number;
  dusk_count: number;
  drone_count: number;
  floorplan_count: number;
  detail_count: number;
  video_thumbnail_count: number;
  agent_headshot_count: number;
  total_images: number;
}

/**
 * Per-segment summary emitted by W15b.4 segment detection.
 *
 * `start_s` / `end_s` are the first and last frame timestamps assigned to
 * the segment. `duration_s` is `end_s - start_s` (0 for a single-frame
 * segment). `confidence` is the mean of `confidence_score` across frames in
 * the segment (null when no frame had a confidence score).
 *
 * `representative_frame_url` is the source URL of the frame with the median
 * confidence within the segment — chosen deterministically (sorted by ts,
 * pick floor(n/2)).
 */
export interface VideoSegment {
  type: 'day' | 'dusk' | 'twilight' | 'night' | 'unknown';
  duration_s: number;
  start_s: number;
  end_s: number;
  confidence: number | null;
  representative_frame_url: string | null;
}

/** Per-signal aggregation summary across all frames in the video. */
export interface SignalScoreAggregate {
  median: number;
  max: number;
  frame_count: number;
}

/** Branding signals detected across the video. */
export interface VideoBrandingSignals {
  competitor_logos_seen: string[];
  flexmedia_branding_seen: boolean;
}

/**
 * Shape of the video_breakdown JSONB.
 *
 * BACKWARDS COMPAT: the legacy W15b.2 keys (`present`, `*_segments_count`,
 * `agent_in_frame`, `car_in_frame`, `narrator_inferred`, `total_duration_s`,
 * `frames_extracted`) are kept because callers and the SQL classifier (W15b.5)
 * read them. W15b.4 adds the richer keys (segments[], unique_*, signal_score_*,
 * etc.) on top — they're optional in the type so consumers can ignore them.
 */
export interface VideoBreakdown {
  present: boolean;
  day_segments_count: number;
  dusk_segments_count: number;
  drone_segments_count: number;
  agent_in_frame: boolean;
  car_in_frame: boolean;
  narrator_inferred: boolean;
  total_duration_s: number | null;
  frames_extracted: number | null;

  // ── W15b.4 enrichment (optional, populated when richer inputs available) ──
  frame_count?: number;
  scene_change_count?: number;
  segments?: VideoSegment[];
  has_drone?: boolean;
  has_dusk_segment?: boolean;
  has_day_segment?: boolean;
  dusk_segment_count?: number;
  day_segment_count?: number;
  unique_spaces?: string[];
  unique_zones?: string[];
  signal_score_summary?: Record<string, SignalScoreAggregate>;
  branding_signals?: VideoBrandingSignals;
  frames_with_concerns?: number;
  frames_with_strong_appeal?: number;
}

/** Shape of the competitor JSONB. */
export interface CompetitorBranding {
  watermark_visible: boolean;
  agency_logo: boolean;
  photographer_credit: boolean;
  dominant_brand_inferred: string | null;
}

// ─── Pure aggregators (no DB) ───────────────────────────────────────────────

/**
 * Roll up per-image image_type counts into a photo_breakdown JSONB. Pure
 * function — no DB. Caller passes whatever subset of vision rows it has
 * (e.g. all rows for one extract). Unrecognised image_types fall through to
 * the `total_images` count but don't increment any specific bucket.
 */
export function computePhotoBreakdown(
  classifications: VisionResponseV2[],
): PhotoBreakdown {
  const breakdown: PhotoBreakdown = {
    day_count: 0,
    dusk_count: 0,
    drone_count: 0,
    floorplan_count: 0,
    detail_count: 0,
    video_thumbnail_count: 0,
    agent_headshot_count: 0,
    total_images: classifications.length,
  };
  for (const c of classifications) {
    switch (c.image_type) {
      case 'is_day':
        breakdown.day_count += 1;
        break;
      case 'is_dusk':
        breakdown.dusk_count += 1;
        break;
      case 'is_drone':
        breakdown.drone_count += 1;
        break;
      case 'is_floorplan':
        breakdown.floorplan_count += 1;
        break;
      case 'is_detail_shot':
        breakdown.detail_count += 1;
        break;
      case 'is_video_frame':
        breakdown.video_thumbnail_count += 1;
        break;
      case 'is_agent_headshot':
        breakdown.agent_headshot_count += 1;
        break;
      // is_test_shot, is_bts, is_facade_hero, is_other → only total_images
      default:
        break;
    }
  }
  return breakdown;
}

/**
 * Roll up video-frame classifications into a video_breakdown JSONB.
 *
 * Backward-compat path (W15b.2): when `videoMetadata.frame_timestamps_s` is
 * absent, this returns the legacy shape — `day_segments_count` is the count
 * of frames classified `is_day`, etc. Existing callers continue to work.
 *
 * Enrichment path (W15b.4): when `frame_timestamps_s` is supplied, this also
 * computes:
 *   - `segments[]` via grouping consecutive frames by `analysis.lighting_state`,
 *     splitting on either a lighting_state flip OR a `scene_changes_s` boundary.
 *   - `signal_score_summary` median/max/frame_count across all 26 signals seen.
 *   - `unique_spaces` / `unique_zones` dedup.
 *   - `branding_signals` — competitor logos detected in observed_objects /
 *     observed_attributes, plus a flexmedia_branding_seen flag.
 *   - `has_drone` from observed_objects with category 'drone_shot' or aerial cues.
 *   - `frames_with_concerns` and `frames_with_strong_appeal` (>=3 appeal_signals).
 *
 * The `present` flag is true iff there is at least one classification.
 *
 * Pure function — no DB. Exported for unit tests.
 */
export function computeVideoBreakdown(
  videoClassifications: VisionResponseV2[],
  videoMetadata: VideoMetadata = {},
): VideoBreakdown {
  const present = videoClassifications.length > 0;
  let day_segments_count = 0;
  let dusk_segments_count = 0;
  let drone_segments_count = 0;
  let agent_in_frame = false;
  let car_in_frame = false;
  let narrator_inferred = false;

  for (const c of videoClassifications) {
    if (c.image_type === 'is_day') day_segments_count += 1;
    if (c.image_type === 'is_dusk') dusk_segments_count += 1;
    if (c.image_type === 'is_drone') drone_segments_count += 1;
    if (c.image_type === 'is_agent_headshot') agent_in_frame = true;
    // observed_attributes inspection
    for (const a of c.observed_attributes ?? []) {
      const label = (a.raw_label ?? '').toLowerCase();
      const valueId = (a.canonical_value_id ?? '').toLowerCase();
      if (label.includes('agent') && label.includes('on camera')) {
        agent_in_frame = true;
      }
      if (label.includes('car') || valueId.includes('car_visible')) {
        car_in_frame = true;
      }
      if (label.includes('narrator') || label.includes('voiceover')) {
        narrator_inferred = true;
      }
    }
  }

  const breakdown: VideoBreakdown = {
    present,
    day_segments_count,
    dusk_segments_count,
    drone_segments_count,
    agent_in_frame,
    car_in_frame,
    narrator_inferred,
    total_duration_s: videoMetadata.total_duration_s ?? null,
    frames_extracted: videoMetadata.frames_extracted ?? null,
  };

  // ── W15b.4 enrichment — only when timestamps provided ───────────────────
  const hasTs = Array.isArray(videoMetadata.frame_timestamps_s);
  if (hasTs) {
    const enriched = computeEnrichedVideoBreakdown(
      videoClassifications,
      videoMetadata.frame_timestamps_s ?? [],
      videoMetadata.scene_changes_s ?? [],
      videoMetadata.total_duration_s ?? 0,
    );
    Object.assign(breakdown, enriched);
  }
  return breakdown;
}

// ─── W15b.4 enrichment helpers (pure) ───────────────────────────────────────

/**
 * The full set of signal_scores keys we aggregate. Mirrors the W11 v2
 * 26-signal taxonomy (24 stage-1 signals + the 2 stage-2 follow-ups). When
 * a frame doesn't include a particular key, it's skipped for that signal —
 * `frame_count` reflects the number of frames that DID supply a numeric
 * value.
 */
const W15B4_SIGNAL_KEYS = [
  // Technical (6)
  'exposure_balance',
  'color_cast',
  'sharpness_subject',
  'sharpness_corners',
  'plumb_verticals',
  'perspective_distortion',
  // Compositional (8)
  'depth_layering',
  'composition_geometry',
  'vantage_quality',
  'framing_quality',
  'leading_lines',
  'negative_space',
  'symmetry_quality',
  'foreground_anchor',
  // Aesthetic / styling (4)
  'material_specificity',
  'period_reading',
  'styling_quality',
  'distraction_freeness',
  // Workflow (4)
  'retouch_debt',
  'gallery_arc_position',
  'social_crop_survival',
  'brochure_print_survival',
  // Stage-2 follow-ups (4) — included so we don't silently drop them
  'lifestyle_appeal',
  'narrative_strength',
  'time_of_day_quality',
  'weather_quality',
] as const;

const COMPETITOR_BRAND_TOKENS = [
  'ray white',
  'belle property',
  'mcgrath',
  'lj hooker',
  'harcourts',
  'the agency',
  'di jones',
  'starr partners',
  'first national',
  'professionals',
  'raine & horne',
  'century 21',
];

/**
 * Compute the enrichment fields for the video_breakdown — segments,
 * signal_score_summary, unique_*, branding, concerns, appeal counts.
 * Pure helper. Returns a partial VideoBreakdown the caller merges in.
 *
 * Algorithm:
 *   1. Build per-frame records (lighting_state, ts, classification ref).
 *   2. Walk frames in timestamp order; start a new segment when the
 *      lighting_state differs from prior, OR a scene_changes_s timestamp
 *      falls strictly between prior_ts and current_ts.
 *   3. For each segment, compute start_s/end_s/duration_s/confidence + pick
 *      the median-confidence frame as representative.
 *   4. Roll up unique spaces, zones, signal medians, branding, concerns,
 *      appeal counts.
 */
export function computeEnrichedVideoBreakdown(
  frames: VisionResponseV2[],
  frame_timestamps_s: number[],
  scene_changes_s: number[],
  total_duration_s: number,
): Partial<VideoBreakdown> {
  // ─── Empty input → safe empty breakdown ───────────────────────────────
  if (frames.length === 0) {
    return {
      total_duration_s: total_duration_s || 0,
      frame_count: 0,
      scene_change_count: scene_changes_s.length,
      segments: [],
      has_drone: false,
      has_dusk_segment: false,
      has_day_segment: false,
      dusk_segment_count: 0,
      day_segment_count: 0,
      unique_spaces: [],
      unique_zones: [],
      signal_score_summary: {},
      branding_signals: {
        competitor_logos_seen: [],
        flexmedia_branding_seen: false,
      },
      frames_with_concerns: 0,
      frames_with_strong_appeal: 0,
    };
  }

  // ─── Sort frames by timestamp (defensive — caller usually passes sorted) ─
  const indexed = frames
    .map((f, i) => ({
      frame: f,
      ts: typeof frame_timestamps_s[i] === 'number'
        ? frame_timestamps_s[i]
        : 0,
    }))
    .sort((a, b) => a.ts - b.ts);

  const sceneCuts = [...(scene_changes_s ?? [])].sort((a, b) => a - b);

  // ─── 1. Walk + group into segments ────────────────────────────────────
  type FrameRec = {
    frame: VisionResponseV2;
    ts: number;
    lighting: VideoSegment['type'];
    confidence: number | null;
    url: string | null;
  };

  const recs: FrameRec[] = indexed.map((it) => ({
    frame: it.frame,
    ts: it.ts,
    lighting: normaliseLightingState(it.frame.analysis?.lighting_state),
    confidence: typeof it.frame.confidence_score === 'number'
      ? it.frame.confidence_score
      : null,
    url: typeof it.frame.source_image_url === 'string'
      ? it.frame.source_image_url
      : null,
  }));

  const segments: VideoSegment[] = [];
  let current: FrameRec[] = [];

  const flushCurrent = (nextTs: number | null) => {
    if (current.length === 0) return;
    const start_s = current[0].ts;
    const last = current[current.length - 1];
    const end_s = nextTs ?? last.ts;
    const lighting = current[0].lighting;
    // confidence: mean of populated confidence_scores
    const confs = current
      .map((r) => r.confidence)
      .filter((c): c is number => typeof c === 'number');
    const meanConf = confs.length > 0
      ? confs.reduce((a, b) => a + b, 0) / confs.length
      : null;
    // representative: median by confidence (stable: tiebreak on ts asc)
    const sortedByConf = [...current].sort((a, b) => {
      const ca = a.confidence ?? -1;
      const cb = b.confidence ?? -1;
      if (ca !== cb) return ca - cb;
      return a.ts - b.ts;
    });
    const median = sortedByConf[Math.floor(sortedByConf.length / 2)];

    segments.push({
      type: lighting,
      duration_s: Math.max(0, end_s - start_s),
      start_s,
      end_s,
      confidence: meanConf,
      representative_frame_url: median?.url ?? null,
    });
    current = [];
  };

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (current.length === 0) {
      current.push(rec);
      continue;
    }
    const prev = current[current.length - 1];
    const lightingChanged = rec.lighting !== prev.lighting;
    // Scene cut between prev and current?
    const cutBetween = sceneCuts.some((c) => c > prev.ts && c <= rec.ts);
    if (lightingChanged || cutBetween) {
      flushCurrent(null);
    }
    current.push(rec);
  }
  flushCurrent(null);

  // ─── 2. Roll up segment-derived flags / counts ────────────────────────
  let day_segment_count = 0;
  let dusk_segment_count = 0;
  let has_dusk_segment = false;
  let has_day_segment = false;
  for (const seg of segments) {
    if (seg.type === 'day') {
      day_segment_count++;
      has_day_segment = true;
    } else if (seg.type === 'dusk' || seg.type === 'twilight') {
      dusk_segment_count++;
      has_dusk_segment = true;
    }
  }

  // ─── 3. has_drone ─────────────────────────────────────────────────────
  let has_drone = false;
  for (const f of frames) {
    if (f.image_type === 'is_drone') {
      has_drone = true;
      break;
    }
    for (const obj of f.observed_objects ?? []) {
      const cat = (obj.category ?? '').toLowerCase();
      const label = (obj.raw_label ?? '').toLowerCase();
      if (cat === 'drone_shot' || cat === 'aerial_view') {
        has_drone = true;
        break;
      }
      if (label.includes('drone') || label.includes('aerial')) {
        has_drone = true;
        break;
      }
    }
    if (has_drone) break;
  }

  // ─── 4. unique_spaces / unique_zones ──────────────────────────────────
  const spaces = new Set<string>();
  const zones = new Set<string>();
  for (const f of frames) {
    if (typeof f.space_type === 'string' && f.space_type.length > 0) {
      spaces.add(f.space_type);
    }
    const zf = f.zone_focus;
    if (typeof zf === 'string' && zf.length > 0) {
      zones.add(zf);
    } else if (Array.isArray(zf)) {
      for (const z of zf) {
        if (typeof z === 'string' && z.length > 0) zones.add(z);
      }
    }
  }

  // ─── 5. signal_score_summary — median, max, frame_count ─────────────
  const signal_score_summary: Record<string, SignalScoreAggregate> = {};
  // Collect per-key values across frames
  const valuesByKey: Record<string, number[]> = {};
  for (const f of frames) {
    const ss = f.signal_scores;
    if (!ss || typeof ss !== 'object') continue;
    for (const key of W15B4_SIGNAL_KEYS) {
      const v = ss[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        (valuesByKey[key] ||= []).push(v);
      }
    }
    // Also pick up any signal_scores keys outside the known list (forwards-compat)
    for (const [k, v] of Object.entries(ss)) {
      if ((W15B4_SIGNAL_KEYS as readonly string[]).includes(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) {
        (valuesByKey[k] ||= []).push(v);
      }
    }
  }
  for (const [key, vals] of Object.entries(valuesByKey)) {
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const max = sorted.length === 0 ? 0 : sorted[sorted.length - 1];
    signal_score_summary[key] = {
      median,
      max,
      frame_count: vals.length,
    };
  }

  // ─── 6. branding_signals ──────────────────────────────────────────────
  const competitorLogos = new Set<string>();
  let flexmediaBrandingSeen = false;
  for (const f of frames) {
    // Check observed_objects for brand overlays
    for (const obj of f.observed_objects ?? []) {
      const label = (obj.raw_label ?? '').toLowerCase();
      const cat = (obj.category ?? '').toLowerCase();
      if (label.includes('flexmedia') || label.includes('flex media')) {
        flexmediaBrandingSeen = true;
        continue;
      }
      const isBrandLike = cat.includes('branding') ||
        cat.includes('logo') ||
        cat.includes('watermark') ||
        cat === 'competitor_branding';
      if (!isBrandLike) {
        // Even non-branding category labels can name a competitor.
        // Fall through to the token check.
      }
      for (const tok of COMPETITOR_BRAND_TOKENS) {
        if (label.includes(tok)) {
          competitorLogos.add(tok);
        }
      }
      // If the category is brand-like and label is non-empty, capture raw label
      if (isBrandLike && label.length > 0 && !label.includes('flexmedia')) {
        // Only capture short labels (avoid full prose getting in)
        if (label.length <= 60) competitorLogos.add(label);
      }
    }
    // Also check observed_attributes for brand_text / agency_brand tokens
    for (const a of f.observed_attributes ?? []) {
      const label = (a.raw_label ?? '').toLowerCase();
      const valueId = (a.canonical_value_id ?? '').toLowerCase();
      if (label.includes('flexmedia') || valueId.includes('flexmedia')) {
        flexmediaBrandingSeen = true;
        continue;
      }
      if (label === 'agency_brand' || label === 'brand_text') {
        if (valueId && valueId.length > 0) {
          // Map a few known canonical value IDs to friendly tokens.
          if (valueId.includes('flexmedia')) flexmediaBrandingSeen = true;
          else competitorLogos.add(valueId);
        }
      }
    }
  }

  // ─── 7. concerns / strong appeal counts ───────────────────────────────
  let frames_with_concerns = 0;
  let frames_with_strong_appeal = 0;
  for (const f of frames) {
    if (Array.isArray(f.concern_signals) && f.concern_signals.length > 0) {
      frames_with_concerns++;
    }
    if (Array.isArray(f.appeal_signals) && f.appeal_signals.length >= 3) {
      frames_with_strong_appeal++;
    }
  }

  return {
    total_duration_s,
    frame_count: frames.length,
    scene_change_count: scene_changes_s.length,
    segments,
    has_drone,
    has_dusk_segment,
    has_day_segment,
    dusk_segment_count,
    day_segment_count,
    unique_spaces: Array.from(spaces).sort(),
    unique_zones: Array.from(zones).sort(),
    signal_score_summary,
    branding_signals: {
      competitor_logos_seen: Array.from(competitorLogos).sort(),
      flexmedia_branding_seen: flexmediaBrandingSeen,
    },
    frames_with_concerns,
    frames_with_strong_appeal,
  };
}

/**
 * Normalise the W11.6.14 `lighting_state` field. Any value outside
 * day/dusk/twilight/night becomes 'unknown'. Null/undefined → 'unknown'.
 * Pure helper, exported for tests.
 */
export function normaliseLightingState(
  v: unknown,
): VideoSegment['type'] {
  if (typeof v !== 'string') return 'unknown';
  const s = v.toLowerCase();
  if (s === 'day' || s === 'dusk' || s === 'twilight' || s === 'night') {
    return s;
  }
  return 'unknown';
}

/**
 * Extract competitor-branding signals from per-image observed_attributes.
 * Pure function. Returns the JSONB shape stored on the extract row.
 *
 * Detection rules (case-insensitive substring against raw_label /
 * canonical_value_id):
 *   - watermark_visible: any attribute with "watermark" in label/value
 *   - agency_logo: any attribute with "agency_logo" or "logo overlay"
 *   - photographer_credit: any attribute with "photographer credit" or
 *     "photo by" in label
 *   - dominant_brand_inferred: most-frequent canonical_value_id of any
 *     attribute with raw_label "agency_brand" or "brand_text"; null if
 *     no consensus.
 */
export function computeCompetitorBranding(
  classifications: VisionResponseV2[],
): CompetitorBranding {
  let watermark_visible = false;
  let agency_logo = false;
  let photographer_credit = false;
  const brandCounts: Record<string, number> = {};

  for (const c of classifications) {
    for (const a of c.observed_attributes ?? []) {
      const label = (a.raw_label ?? '').toLowerCase();
      const valueId = (a.canonical_value_id ?? '').toLowerCase();
      if (label.includes('watermark') || valueId.includes('watermark')) {
        watermark_visible = true;
      }
      if (
        label.includes('agency_logo') ||
        label.includes('logo overlay') ||
        valueId.includes('agency_logo')
      ) {
        agency_logo = true;
      }
      if (
        label.includes('photographer credit') ||
        label.includes('photo by') ||
        valueId.includes('photographer_credit')
      ) {
        photographer_credit = true;
      }
      if (label === 'agency_brand' || label === 'brand_text') {
        const v = a.canonical_value_id;
        if (v) brandCounts[v] = (brandCounts[v] ?? 0) + 1;
      }
    }
  }

  let dominant_brand_inferred: string | null = null;
  let max = 0;
  for (const [brand, n] of Object.entries(brandCounts)) {
    if (n > max) {
      max = n;
      dominant_brand_inferred = brand;
    }
  }

  return {
    watermark_visible,
    agency_logo,
    photographer_credit,
    dominant_brand_inferred,
  };
}

// ─── DB-touching helpers ────────────────────────────────────────────────────

export interface CreateExtractInput {
  listing_id: string;
  triggered_by: PulseVisionTriggeredBy;
  triggered_by_user?: string | null;
  schema_version?: string;
}

export interface CreateExtractResult {
  extract_id: string;
  /** True if this call inserted the row; false if it returned an existing one. */
  created: boolean;
}

/**
 * Create a pending extract row, or return the existing one if (listing_id,
 * schema_version) already has a row. Idempotent by design.
 *
 * Returns { extract_id, created }. created=true means we just inserted;
 * created=false means a previous run owned it. Callers that need to retry
 * should check status on the returned row separately.
 */
export async function createPulseVisionExtract(
  admin: SupabaseClient,
  input: CreateExtractInput,
): Promise<CreateExtractResult> {
  const schemaVersion = input.schema_version ?? 'v1.0';

  // First try to find an existing row.
  const { data: existing, error: selErr } = await admin
    .from('pulse_listing_vision_extracts')
    .select('id')
    .eq('listing_id', input.listing_id)
    .eq('schema_version', schemaVersion)
    .maybeSingle();

  if (selErr) {
    throw new Error(
      `pulse_listing_vision_extracts SELECT failed: ${selErr.message}`,
    );
  }
  if (existing?.id) {
    return { extract_id: existing.id, created: false };
  }

  // Insert a new pending row.
  const { data: inserted, error: insErr } = await admin
    .from('pulse_listing_vision_extracts')
    .insert({
      listing_id: input.listing_id,
      schema_version: schemaVersion,
      status: 'pending',
      triggered_by: input.triggered_by,
      triggered_by_user: input.triggered_by_user ?? null,
    })
    .select('id')
    .single();

  if (insErr) {
    // Race: another tick won the unique-index. Re-select.
    if (insErr.code === '23505') {
      const { data: raceWinner } = await admin
        .from('pulse_listing_vision_extracts')
        .select('id')
        .eq('listing_id', input.listing_id)
        .eq('schema_version', schemaVersion)
        .single();
      if (raceWinner?.id) {
        return { extract_id: raceWinner.id, created: false };
      }
    }
    throw new Error(
      `pulse_listing_vision_extracts INSERT failed: ${insErr.message}`,
    );
  }

  return { extract_id: inserted!.id, created: true };
}

/** Transition pending → running. */
export async function markPulseVisionExtractRunning(
  admin: SupabaseClient,
  extract_id: string,
): Promise<void> {
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({ status: 'running' })
    .eq('id', extract_id);
  if (error) {
    throw new Error(
      `markPulseVisionExtractRunning failed: ${error.message}`,
    );
  }
}

/**
 * Aggregate per-image classifications into the photo_breakdown JSONB and
 * write it onto the extract row. Caller passes the per-image rows directly
 * (already fetched from composition_classifications, or freshly emitted).
 *
 * Returns the computed breakdown so callers can chain it into logging /
 * notifications without re-querying.
 */
export async function aggregatePerImageResults(
  admin: SupabaseClient,
  extract_id: string,
  classifications: VisionResponseV2[],
): Promise<PhotoBreakdown> {
  const breakdown = computePhotoBreakdown(classifications);
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({ photo_breakdown: breakdown })
    .eq('id', extract_id);
  if (error) {
    throw new Error(
      `aggregatePerImageResults UPDATE failed: ${error.message}`,
    );
  }
  return breakdown;
}

/**
 * Aggregate video classifications and write video_breakdown JSONB.
 *
 * Backward-compat: when `videoMetadata.frame_timestamps_s` is omitted, this
 * computes only the legacy fields (`day_segments_count` etc.) — same as the
 * original W15b.2 helper.
 *
 * Enrichment path (W15b.4): when the caller supplies `frame_timestamps_s`
 * and (optionally) `scene_changes_s`, this also persists the richer fields:
 * segments[], signal_score_summary, has_drone, has_*_segment, unique_spaces,
 * unique_zones, branding_signals, frames_with_concerns,
 * frames_with_strong_appeal.
 *
 * Returns the computed VideoBreakdown so callers can chain it into logs.
 */
export async function aggregateVideoResults(
  admin: SupabaseClient,
  extract_id: string,
  videoClassifications: VisionResponseV2[],
  videoMetadata: VideoMetadata = {},
): Promise<VideoBreakdown> {
  const breakdown = computeVideoBreakdown(videoClassifications, videoMetadata);
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({ video_breakdown: breakdown })
    .eq('id', extract_id);
  if (error) {
    throw new Error(
      `aggregateVideoResults UPDATE failed: ${error.message}`,
    );
  }
  return breakdown;
}

/** Aggregate competitor branding from per-image observed_attributes. */
export async function aggregateCompetitorBranding(
  admin: SupabaseClient,
  extract_id: string,
  classifications: VisionResponseV2[],
): Promise<CompetitorBranding> {
  const competitor = computeCompetitorBranding(classifications);
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({ competitor })
    .eq('id', extract_id);
  if (error) {
    throw new Error(
      `aggregateCompetitorBranding UPDATE failed: ${error.message}`,
    );
  }
  return competitor;
}

export interface SuccessInput {
  total_cost_usd: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  vendor: string;
  model_version: string;
  prompt_block_versions?: Record<string, string>;
}

/** Transition any state → succeeded. Stamps cost / vendor / model fields. */
export async function markPulseVisionExtractSucceeded(
  admin: SupabaseClient,
  extract_id: string,
  input: SuccessInput,
): Promise<void> {
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({
      status: 'succeeded',
      extracted_at: new Date().toISOString(),
      total_cost_usd: input.total_cost_usd,
      total_input_tokens: input.total_input_tokens ?? 0,
      total_output_tokens: input.total_output_tokens ?? 0,
      vendor: input.vendor,
      model_version: input.model_version,
      prompt_block_versions: input.prompt_block_versions ?? {},
    })
    .eq('id', extract_id);
  if (error) {
    throw new Error(
      `markPulseVisionExtractSucceeded failed: ${error.message}`,
    );
  }
}

/** Transition any state → failed. Captures the failure reason. */
export async function markPulseVisionExtractFailed(
  admin: SupabaseClient,
  extract_id: string,
  failed_reason: string,
): Promise<void> {
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({
      status: 'failed',
      extracted_at: new Date().toISOString(),
      failed_reason,
    })
    .eq('id', extract_id);
  if (error) {
    throw new Error(
      `markPulseVisionExtractFailed failed: ${error.message}`,
    );
  }
}

/**
 * Master_admin override path: stamp status='manually_overridden' with the
 * actor and reason so audit trails preserve who decided to short-circuit
 * the vision pipeline for this listing (e.g. for cost reasons, or because
 * the listing's images are paywalled).
 */
export async function applyManualOverride(
  admin: SupabaseClient,
  extract_id: string,
  user_id: string,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from('pulse_listing_vision_extracts')
    .update({
      status: 'manually_overridden',
      manual_override_by: user_id,
      manual_override_reason: reason,
    })
    .eq('id', extract_id);
  if (error) {
    throw new Error(`applyManualOverride failed: ${error.message}`);
  }
}

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

/** Shape for video metadata threaded through from W15b.3. */
export interface VideoMetadata {
  total_duration_s?: number | null;
  frames_extracted?: number | null;
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

/** Shape of the video_breakdown JSONB. */
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
 * Roll up video-frame classifications into a video_breakdown JSONB. The
 * `present` flag is true iff there is at least one classification. Segment
 * counts come from grouping consecutive frames of the same image_type — but
 * for W15b.2 we keep the simple "count distinct frames per type" until W15b.3
 * lands proper segment detection. Caller may override post-hoc.
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

  return {
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

/** Aggregate video classifications and write video_breakdown JSONB. */
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

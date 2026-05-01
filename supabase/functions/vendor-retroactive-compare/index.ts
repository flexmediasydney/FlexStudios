/**
 * vendor-retroactive-compare
 * ──────────────────────────
 * Wave 11.8 retroactive vendor A/B harness.
 *
 * One-shot edge function that re-runs an existing shortlisting round through
 * multiple (vendor, model) configurations using the same prompt + image set,
 * persists the responses to `vendor_shadow_runs`, computes pairwise
 * comparison metrics, and writes a row to `vendor_comparison_results` plus
 * a markdown report to Dropbox at `Photos/_AUDIT/vendor_comparison_<round_id>.md`.
 *
 * Drives the Saladine A/B test (round 3ed54b53-9184-402f-9907-d168ed1968a4,
 * 42 composition_groups) per W11-8 spec Section 5.
 *
 * Auth: master_admin only (service-role bypass also allowed).
 *
 * Body (RetroactiveCompareRequest):
 *   {
 *     "round_id": "<uuid>",
 *     "vendors_to_compare": [
 *       { "vendor": "anthropic", "model": "claude-opus-4-7", "label": "anthropic-opus-baseline" },
 *       { "vendor": "google",    "model": "gemini-2.0-pro",   "label": "google-pro-test" }
 *     ],
 *     "pass_kinds": ["unified"],          // v1 only supports 'unified' (Pass 1 schema as the comparison)
 *     "cost_cap_usd": 5.00,
 *     "dry_run": false
 *   }
 *
 * Returns a summary JSON of cost actuals, latency, and the comparison_results
 * row id(s) written.
 *
 * Per-vendor flow (per spec Section 5):
 *   1. Load round's composition_groups with their best_bracket_stem
 *   2. Resolve preview Dropbox URLs at <root>/Photos/Raws/Shortlist Proposed/Previews/<stem>.jpg
 *   3. Build the unified prompt using existing W7.6 prompt blocks
 *   4. Fetch preview JPEGs as base64 (Dropbox getDropboxAccessToken + content endpoint)
 *   5. Call vendor via callVisionAdapter
 *   6. Persist raw response in vendor_shadow_runs
 *
 * After all vendors complete:
 *   7. Compute pairwise comparison metrics (vendorComparisonMetrics)
 *   8. Generate markdown report
 *   9. Write to vendor_comparison_results + upload to Dropbox _AUDIT
 *
 * Cost gate: pre-flight estimate (per spec, conservative fixed-token estimate)
 * × N vendors must fit cost_cap_usd or 400 with detail.
 *
 * For v1, the comparison schema is today's Pass 1 output (W11.7 unified is not
 * yet shipped); the harness validates COMPARATIVE quality between vendors
 * against the same prompt + schema.
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
  callVisionAdapter,
  estimateCost,
  MissingVendorCredential,
  VendorCallError,
  type VisionRequest,
  type VisionResponse,
  type VisionVendor,
} from '../_shared/visionAdapter/index.ts';
import { getDropboxAccessToken, uploadFile, createFolder } from '../_shared/dropbox.ts';
import { buildPass1Prompt } from '../_shared/pass1Prompt.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';
import {
  computeAgreementMatrix,
  computeScoreDelta,
  computeObjectOverlap,
  computeRoomTypeAgreement,
  generateMarkdownReport,
  type VendorRunSummary,
} from '../_shared/vendorComparisonMetrics.ts';
import {
  voiceAnchorBlock,
  SYDNEY_PRIMER_BLOCK,
  SELF_CRITIQUE_BLOCK,
} from './iter5VoiceAnchor.ts';
import {
  sourceContextBlock,
  SOURCE_CONTEXT_BLOCK_VERSION,
  type SourceType,
} from './iter5SourceContext.ts';
import {
  COMPARISON_TOOL_NAME_ITER5,
  COMPARISON_TOOL_SCHEMA_ITER5,
} from './iter5Schema.ts';
import {
  STAGE4_TOOL_NAME,
  STAGE4_TOOL_SCHEMA,
  buildStage4SystemPrompt,
  buildStage4UserPrompt,
  stage4PromptVersions,
  type PropertyFacts,
  type Stage1MergedEntry,
} from './iter5Stage4.ts';

const GENERATOR = 'vendor-retroactive-compare';

// ─── Types ───────────────────────────────────────────────────────────────────

interface VendorConfig {
  vendor: VisionVendor;
  model: string;
  label: string;
}

interface RetroactiveCompareRequest {
  round_id: string;
  vendors_to_compare: VendorConfig[];
  pass_kinds: ('unified' | 'description_backfill')[];
  cost_cap_usd: number;
  dry_run?: boolean;
  /**
   * Limit how many composition_groups to call. Useful for dev / partial
   * tests. Defaults to all groups in the round.
   */
  max_groups?: number;
  /**
   * iter-5: voice tier for listing copy. Drives both per-image listing_copy
   * and Stage 4 master_listing voice. Default 'standard'.
   */
  property_tier?: 'premium' | 'standard' | 'approachable';
  /**
   * iter-5: free-text override of the tier rubric (operator-supplied voice
   * direction). Forbidden patterns from standard tier still apply.
   */
  property_voice_anchor_override?: string;
  /**
   * iter-5: when any label includes "iter5", we activate iter-5 mode:
   *   - schema swapped to iter-5 enriched (per-image listing_copy etc)
   *   - voice anchor + Sydney primer + self-critique injected
   *   - Stage 1 thinkingBudget bumped to 2048
   *   - Stage 4 visual master synthesis call fired after Stage 1 completes
   * Set explicitly via this flag to force iter-5 mode regardless of label.
   */
  force_iter5?: boolean;
  /**
   * iter-5: skip the Stage 4 visual master synthesis (smoke testing only).
   * Default false.
   */
  skip_stage4?: boolean;
  /**
   * iter-5: when true, skip Stage 1 entirely and run ONLY Stage 4 against
   * already-primed shadow_runs for this (round, label). Used when Stage 1
   * completed previously but Stage 4 hit the edge runtime wall time, so we
   * re-invoke just Stage 4 with a fresh worker budget.
   */
  stage4_only?: boolean;
  /**
   * iter-5b: source type of the input images. Drives the source-context
   * preamble in Stage 1 + Stage 4 prompts. Default 'internal_raw' which
   * matches our primary workflow (RAW HDR brackets pre-merge). Critical for
   * Gemini, which doesn't self-classify RAW vs final from training (Anthropic
   * Opus 4.7 does). Without this, Gemini judges EV0 brackets as final
   * deliverables and produces "technical failure" coverage_notes.
   */
  source_type?: SourceType;
}

interface CompositionRow {
  group_id: string;
  group_index: number;
  stem: string;
  delivery_reference_stem: string | null;
  best_bracket_stem: string | null;
}

// ─── Cost pre-flight ─────────────────────────────────────────────────────────

/**
 * Conservative per-call token estimates. The unified Pass 1 prompt averages
 * ~2.5K input tokens (system+user blocks) + ~1500 input tokens per image
 * (Anthropic compresses to ~1.5K; Gemini varies; we bill at the ceiling).
 * Output is ~1500 tokens hard-cap by request.
 *
 * For dry_run / pre-flight we estimate per-composition cost at one call,
 * multiply by N compositions × N vendors. The actual usage is recorded on
 * the response and persisted.
 */
const PRE_FLIGHT_INPUT_TOKENS_PER_COMPOSITION = 4_000;
const PRE_FLIGHT_OUTPUT_TOKENS_PER_COMPOSITION = 1_500;

function preflightCost(vendor: VisionVendor, model: string, n_compositions: number): number {
  const per = estimateCost(vendor, model, {
    input_tokens: PRE_FLIGHT_INPUT_TOKENS_PER_COMPOSITION,
    output_tokens: PRE_FLIGHT_OUTPUT_TOKENS_PER_COMPOSITION,
    cached_input_tokens: 0,
  });
  return per * n_compositions;
}

// ─── Body validation ─────────────────────────────────────────────────────────

function validateBody(body: unknown): { ok: true; req: RetroactiveCompareRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.round_id !== 'string' || !b.round_id) return { ok: false, error: 'round_id required' };
  if (!Array.isArray(b.vendors_to_compare) || b.vendors_to_compare.length < 1) {
    return { ok: false, error: 'vendors_to_compare must be a non-empty array' };
  }
  for (const v of b.vendors_to_compare as unknown[]) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'vendor entry malformed' };
    const vc = v as Record<string, unknown>;
    if (vc.vendor !== 'anthropic' && vc.vendor !== 'google') {
      return { ok: false, error: `vendor must be 'anthropic' or 'google' (got '${vc.vendor}')` };
    }
    if (typeof vc.model !== 'string' || !vc.model) return { ok: false, error: 'vendor.model required' };
    if (typeof vc.label !== 'string' || !vc.label) return { ok: false, error: 'vendor.label required' };
  }
  if (!Array.isArray(b.pass_kinds) || b.pass_kinds.length === 0) {
    return { ok: false, error: 'pass_kinds must be a non-empty array' };
  }
  for (const pk of b.pass_kinds as unknown[]) {
    if (pk !== 'unified' && pk !== 'description_backfill') {
      return { ok: false, error: `pass_kind must be 'unified' or 'description_backfill' (got '${pk}')` };
    }
  }
  if (typeof b.cost_cap_usd !== 'number' || b.cost_cap_usd <= 0) {
    return { ok: false, error: 'cost_cap_usd must be a positive number' };
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') {
    return { ok: false, error: 'dry_run must be boolean when present' };
  }
  if (b.max_groups !== undefined && (typeof b.max_groups !== 'number' || b.max_groups <= 0)) {
    return { ok: false, error: 'max_groups must be a positive number when present' };
  }
  if (b.property_tier !== undefined &&
      b.property_tier !== 'premium' &&
      b.property_tier !== 'standard' &&
      b.property_tier !== 'approachable') {
    return { ok: false, error: "property_tier must be 'premium' | 'standard' | 'approachable'" };
  }
  if (b.property_voice_anchor_override !== undefined &&
      typeof b.property_voice_anchor_override !== 'string') {
    return { ok: false, error: 'property_voice_anchor_override must be string when present' };
  }
  if (b.force_iter5 !== undefined && typeof b.force_iter5 !== 'boolean') {
    return { ok: false, error: 'force_iter5 must be boolean when present' };
  }
  if (b.skip_stage4 !== undefined && typeof b.skip_stage4 !== 'boolean') {
    return { ok: false, error: 'skip_stage4 must be boolean when present' };
  }
  if (b.source_type !== undefined &&
      b.source_type !== 'internal_raw' &&
      b.source_type !== 'internal_finals' &&
      b.source_type !== 'external_listing' &&
      b.source_type !== 'floorplan_image') {
    return { ok: false, error: "source_type must be 'internal_raw' | 'internal_finals' | 'external_listing' | 'floorplan_image' when present" };
  }
  if (b.stage4_only !== undefined && typeof b.stage4_only !== 'boolean') {
    return { ok: false, error: 'stage4_only must be boolean when present' };
  }
  return { ok: true, req: b as unknown as RetroactiveCompareRequest };
}

// ─── Round load ──────────────────────────────────────────────────────────────

async function loadRoundContext(roundId: string): Promise<{
  round: { project_id: string };
  project: {
    dropbox_root_path: string | null;
    property_facts: PropertyFacts;
    pricing_tier: string | null;
  };
  compositions: CompositionRow[];
}> {
  const admin = getAdminClient();
  const { data: round, error: rErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id')
    .eq('id', roundId)
    .single();
  if (rErr || !round) throw new Error(`round ${roundId} not found: ${rErr?.message || 'no row'}`);

  // iter-5: pull CRM-side property facts for the Stage 4 master_listing
  // synthesis. We use existing `projects` columns; missing CRM fields appear
  // as null and the Stage 4 prompt explicitly omits them from copy.
  const { data: projRaw, error: pErr } = await admin
    .from('projects')
    .select(
      'id, dropbox_root_path, property_address, property_suburb, pricing_tier, ' +
      'property_type',
    )
    .eq('id', round.project_id)
    .single();
  if (pErr || !projRaw) throw new Error(`project ${round.project_id} not found: ${pErr?.message || 'no row'}`);
  const proj = projRaw as unknown as Record<string, unknown>;

  const { data: groups, error: gErr } = await admin
    .from('composition_groups')
    .select('id, group_index, delivery_reference_stem, best_bracket_stem')
    .eq('round_id', roundId)
    .order('group_index');
  if (gErr) throw new Error(`composition_groups load failed: ${gErr.message}`);

  const compositions: CompositionRow[] = (groups || []).map((g: Record<string, unknown>) => {
    const delivery = (g.delivery_reference_stem as string | null) || null;
    const best = (g.best_bracket_stem as string | null) || null;
    return {
      group_id: g.id as string,
      group_index: g.group_index as number,
      stem: delivery || best || `group_${g.group_index}`,
      delivery_reference_stem: delivery,
      best_bracket_stem: best,
    };
  });

  const property_facts: PropertyFacts = {
    address_line: (proj.property_address as string | null) ?? null,
    suburb: (proj.property_suburb as string | null) ?? null,
    state: 'NSW', // Sydney CRM is single-state for now
    bedrooms: null,
    bathrooms: null,
    car_spaces: null,
    land_size_sqm: null,
    internal_size_sqm: null,
    price_guide_band: null,
    auction_or_private_treaty: null,
  };

  return {
    round: { project_id: round.project_id as string },
    project: {
      dropbox_root_path: (proj.dropbox_root_path as string | null) ?? null,
      property_facts,
      pricing_tier: (proj.pricing_tier as string | null) ?? null,
    },
    compositions,
  };
}

// ─── Preview fetch ───────────────────────────────────────────────────────────

/**
 * Fetch a Dropbox preview JPEG and return it as base64.
 *
 * Uses the Dropbox content endpoint /files/download via getDropboxAccessToken
 * (matches the dropbox.ts fetch pattern). Throws on failure — the harness
 * catches and skips the composition (logs an error_message in the shadow_run
 * row so the operator can see which images failed).
 */
async function fetchPreviewBase64(
  dropboxPath: string,
): Promise<{ data: string; media_type: string }> {
  const token = await getDropboxAccessToken();
  // Team-folder namespace header — without this, paths like
  // "/Flex Media Team Folder/..." resolve in the user's PERSONAL namespace
  // and 404. Mirrors `_shared/dropbox.ts:pathRootHeader()`.
  const ns = Deno.env.get('DROPBOX_TEAM_NAMESPACE_ID');
  const pathRootHeader: Record<string, string> = ns
    ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: ns }) }
    : {};
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      ...pathRootHeader,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`dropbox download ${res.status}: ${txt.slice(0, 200)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // Base64-encode in fixed-size chunks so we don't blow the call stack on
  // 1MB+ JPEGs (String.fromCharCode(...veryLargeArray) crashes V8).
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  const data = btoa(bin);
  return { data, media_type: 'image/jpeg' };
}

// ─── Schema for the comparison call ──────────────────────────────────────────

/**
 * For v1, we use today's Pass 1 schema as the comparison shape — the
 * "unified" call is conceptually a Pass 1+2 merged classification, but
 * W11.7 hasn't shipped, so we score the comparison on the per-image Pass 1
 * fields. This reuses the existing prompt blocks and produces directly-
 * comparable outputs across vendors.
 *
 * The schema has to be Gemini-responseSchema-compatible (no $ref, no
 * patternProperties, no additionalProperties: keep it flat).
 */
const COMPARISON_TOOL_NAME = 'classify_image';
/**
 * Iteration 4: schema enriched with `description` fields and `minItems`.
 *
 * The first three iterations let `key_elements` default to terse single
 * nouns on Gemini ('window', 'desk') vs Opus's verbose noun phrases
 * ('window with venetian blinds', 'shaker-style cabinetry'). Both Anthropic
 * tool-use and Gemini responseSchema honour `description` fields on
 * properties — using them to specify granularity, content rules, and
 * forbidden patterns is the cheapest way to align verbosity across vendors.
 *
 * Per-property guidance:
 *   - analysis: 5–7 detailed sentences, ~250 words minimum, no nested JSON
 *     (Opus emitted a stringified JSON-in-string at 1/42 in iter 3)
 *   - key_elements: minItems=8, multi-noun phrases with material/treatment
 *     descriptors, single-noun entries forbidden
 *   - zones_visible: minItems=2, area names not object names
 *   - clutter_detail: prose explanation, not a list
 */
const COMPARISON_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    analysis: {
      type: 'string',
      description:
        'Write 5–7 detailed sentences (~250 words minimum) covering: ' +
        '(1) composition geometry, vantage and depth layering; ' +
        '(2) lighting condition, exposure stage (single bracket vs final HDR), and tonal balance; ' +
        '(3) distinguishing architectural features and materials with specific descriptors ' +
        '(e.g. "Corinthian column with capital", "terracotta hipped roof", "shaker cabinetry", ' +
        '"gooseneck mixer tap" — NOT generic nouns like "column", "roof", "cabinetry"); ' +
        '(4) styling state, distractions, clutter, and retouch concerns; ' +
        '(5) hero-shot vs supporting-angle judgement with reasoning. ' +
        'Do NOT emit nested JSON — return only the descriptive paragraph as a single string.',
    },
    room_type: {
      type: 'string',
      description:
        'Use one room_type value from the canonical taxonomy in the system prompt. ' +
        'Prefer the most specific applicable value — e.g. bedroom_guest over bedroom_secondary ' +
        'when the bedroom is clearly a formally-styled spare room; alfresco_undercover over alfresco ' +
        'when the alfresco is roofed; exterior_facade_hero over exterior_front when the shot is ' +
        'a hero-quality framing of the front facade.',
    },
    room_type_confidence: { type: 'number' },
    composition_type: {
      type: 'string',
      description: 'Use one value from the composition_type taxonomy in the system prompt.',
    },
    vantage_point: {
      type: 'string',
      description:
        'Use one of: interior_looking_out | exterior_looking_in | neutral | ' +
        'low_angle | high_angle | eye_level_through_threshold | aerial_oblique | aerial_nadir.',
    },
    time_of_day: { type: 'string' },
    is_drone: { type: 'boolean' },
    is_exterior: { type: 'boolean' },
    is_detail_shot: { type: 'boolean' },
    zones_visible: {
      type: 'array',
      minItems: 2,
      description:
        'List of distinct functional zones visible in the frame ' +
        '(e.g. "kitchen", "dining_zone", "alfresco_through_doors", "study_through_archway"). ' +
        'Different from key_elements — these are AREAS, not objects.',
      items: { type: 'string' },
    },
    key_elements: {
      type: 'array',
      minItems: 8,
      description:
        'List 8 OR MORE specific architectural and styling elements visible in the frame. ' +
        'Each entry MUST be a multi-noun phrase that includes a material, treatment, style or ' +
        'descriptor — NOT a generic single noun. ' +
        'GOOD: "casement window with venetian blinds", "four-poster bed with timber frame", ' +
        '"patterned Persian rug", "shaker-style cabinetry", "gooseneck mixer tap", ' +
        '"terracotta tiled hipped roof", "Corinthian column with capital", ' +
        '"variegated red-brown brick veneer", "ornate white turned baluster railing". ' +
        'FORBIDDEN single-noun entries: "window", "bed", "rug", "cabinetry", "tap", ' +
        '"roof", "column", "brick", "balustrade". ' +
        'Aim for the level of granularity a master architectural photographer would write ' +
        'in a Tier P feature description — every architectural feature, finish, fixture and ' +
        'styling element gets a specific, identifiable phrase.',
      items: { type: 'string' },
    },
    is_styled: { type: 'boolean' },
    indoor_outdoor_visible: { type: 'boolean' },
    clutter_severity: { type: 'string' },
    clutter_detail: {
      type: 'string',
      description:
        'Prose paragraph identifying clutter or retouch concerns and proposing remediation. ' +
        'Empty string when clutter_severity is "none".',
    },
    flag_for_retouching: { type: 'boolean' },
    technical_score: { type: 'number' },
    lighting_score: { type: 'number' },
    composition_score: { type: 'number' },
    aesthetic_score: { type: 'number' },
  },
  required: [
    'analysis',
    'room_type',
    'composition_type',
    'technical_score',
    'lighting_score',
    'composition_score',
    'aesthetic_score',
    'key_elements',
    'zones_visible',
  ],
};

/**
 * Iteration 4: V2 expanded room taxonomy + master-architectural-photographer
 * granularity directive, appended to the user_text. This is a prompt-only
 * change (no schema enum) so models can still emit any value but are guided
 * toward the V2 set.
 *
 * The 23 V2 additions on top of the 40 W7.6 types lift specificity in
 * categories where the existing taxonomy lumped distinct feature rooms:
 *   - bedroom granularity (guest, nursery, kids)
 *   - living granularity (formal, family, media-dedicated)
 *   - kitchen + pantry (butlers_pantry, walk_in_pantry, island_hero)
 *   - bathroom granularity (powder, main, ensuite_walkthrough)
 *   - alfresco granularity (undercover, pavilion)
 *   - outdoor entertainment (pool_with_water_feature, bbq_zone, firepit_zone)
 *   - exterior framing (streetscape, facade_hero, entry_portico, garage_feature)
 *   - detail shots (hardware, textile)
 *
 * Total taxonomy: 40 → 63 room types.
 */
const V2_TAXONOMY_AND_GRANULARITY_INSTRUCTION = [
  '',
  '── ITERATION 4 ENRICHMENT ──',
  '',
  'EXPANDED ROOM TYPE TAXONOMY (use these in addition to the canonical 40, prefer the most specific):',
  'bedroom_guest | bedroom_nursery | bedroom_kids | living_formal | living_family | ' +
    'living_media_dedicated | kitchen_butlers_pantry | kitchen_pantry_walk_in | ' +
    'kitchen_island_hero | bathroom_powder | bathroom_main | ensuite_walkthrough | ' +
    'alfresco_undercover | alfresco_pavilion | pool_with_water_feature | bbq_zone | ' +
    'firepit_zone | exterior_streetscape | exterior_facade_hero | exterior_entry_portico | ' +
    'exterior_garage_feature | detail_hardware | detail_textile',
  '',
  'EXPANDED COMPOSITION_TYPE VALUES (use these alongside the canonical set):',
  'hero_wide | hero_axial | hero_threshold_through | supporting_corner_two_point | ' +
    'supporting_axial_one_point | detail_close | detail_macro | aerial_oblique | ' +
    'aerial_nadir | streetscape_context | feature_pull_back | feature_step_in | ' +
    'lifestyle_anchor',
  '',
  'EXPANDED VANTAGE_POINT VALUES:',
  'interior_looking_out | exterior_looking_in | neutral | low_angle | high_angle | ' +
    'eye_level_through_threshold | aerial_oblique | aerial_nadir | seated_height | ' +
    'standing_height | counter_height | floor_anchor | ceiling_detail',
  '',
  'GRANULARITY DIRECTIVE — write as a master architectural photographer:',
  '• Every architectural feature, finish, and fixture gets a specific phrase that names',
  '  the material, style, or treatment. NEVER a single generic noun.',
  '• "Federation-influenced fretwork", "Corinthian column with acanthus capital",',
  '  "shaker-style raised-panel cabinetry", "terracotta tiled hipped roof",',
  '  "variegated red-brown brick veneer", "white turned-baluster railing".',
  '• If your draft `key_elements` includes any of these forbidden bare nouns, expand them:',
  '  window → window with [treatment]; bed → [style] bed with [material] frame;',
  '  rug → [pattern] [origin/style] rug; tap → [shape] mixer tap in [finish];',
  '  cabinetry → [door style] [colour] cabinetry; roof → [material] [shape] roof;',
  '  fence → [material/colour] fence (e.g. "Colorbond fence", "white timber picket fence").',
  '• Aim for 8–12 entries in key_elements. Aim for ~250 words in analysis.',
  '',
].join('\n');

// ─── Per-vendor sweep ────────────────────────────────────────────────────────

/**
 * Concurrency for the composition sweep. Each composition fans out one call
 * per vendor in parallel; we then run BATCH_SIZE compositions in parallel.
 *
 * For 42 compositions × 2 vendors @ ~15s/call:
 *   - sequential (old): 1260s = 21 min (way past the 400s edge worker cap)
 *   - parallel vendors only: 630s = 10.5 min
 *   - batches of 4 compositions × parallel vendors: ~165s = 2.75 min
 *
 * Both Anthropic (tier-1: 50 RPM) and Gemini 2.5 Pro pay-as-you-go (60 RPM)
 * tolerate this comfortably. Per-call AbortSignal.timeout(90s) inside the
 * adapter ensures one slow call can't stall the whole batch.
 */
const BATCH_SIZE = 4;

interface ShadowRunRecord {
  group_id: string;
  vendor: VisionVendor;
  model: string;
  label: string;
  output: Record<string, unknown> | null;
  cost_usd: number;
  elapsed_ms: number;
  error_message: string | null;
}

interface Stage1CallSpec {
  iter5: boolean;
  toolName: string;
  toolSchema: Record<string, unknown>;
  thinkingBudget: number; // gemini-only override; ignored on Anthropic
  maxOutputTokens: number;
}

async function runVendorOnComposition(
  cfg: VendorConfig,
  comp: CompositionRow,
  preview: { data: string; media_type: string },
  promptSystem: string,
  promptUser: string,
  spec: Stage1CallSpec,
): Promise<{ resp: VisionResponse | null; error?: string }> {
  const req: VisionRequest = {
    vendor: cfg.vendor,
    model: cfg.model,
    tool_name: spec.toolName,
    tool_input_schema: spec.toolSchema,
    system: promptSystem,
    user_text: promptUser,
    images: [{ source_type: 'base64', media_type: preview.media_type, data: preview.data }],
    max_output_tokens: spec.maxOutputTokens,
    temperature: 0,
    thinking_budget: spec.thinkingBudget,
  };
  try {
    const resp = await callVisionAdapter(req);
    return { resp };
  } catch (err) {
    if (err instanceof MissingVendorCredential) {
      return { resp: null, error: err.message };
    }
    if (err instanceof VendorCallError) {
      return { resp: null, error: `${err.vendor}/${err.model} ${err.status ?? ''}: ${err.message}` };
    }
    return { resp: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function persistShadowRun(
  round_id: string,
  cfg: VendorConfig,
  comp: CompositionRow,
  resp: VisionResponse | null,
  error: string | undefined,
  pass_kind: 'unified' | 'description_backfill',
  request_payload: VisionRequest,
): Promise<void> {
  const admin = getAdminClient();
  // We strip the base64 image data from the persisted request_payload — those
  // are tens of MB and Dropbox path is more useful for replay. Replace
  // images with their length+media_type.
  const safe_request: Record<string, unknown> = {
    ...request_payload,
    images: request_payload.images.map((i) => ({
      source_type: i.source_type,
      media_type: i.media_type,
      data_length: i.data?.length ?? 0,
    })),
  };
  const row: Record<string, unknown> = {
    round_id,
    pass_kind,
    vendor: cfg.vendor,
    model: cfg.model,
    label: cfg.label,
    group_id: comp.group_id,
    request_payload: safe_request,
    response_output: resp?.output ?? null,
    response_usage: resp?.usage ?? null,
    vendor_meta: resp?.vendor_meta ?? null,
    error_message: error ?? null,
  };
  const { error: insErr } = await admin.from('vendor_shadow_runs').insert(row);
  if (insErr) {
    console.warn(`[${GENERATOR}] vendor_shadow_runs insert failed: ${insErr.message}`);
  }
}

// ─── Markdown upload ─────────────────────────────────────────────────────────

async function uploadComparisonReport(
  dropboxRoot: string | null,
  round_id: string,
  markdown: string,
): Promise<string | null> {
  if (!dropboxRoot) return null;
  const path = `${dropboxRoot.replace(/\/+$/, '')}/Photos/_AUDIT/vendor_comparison_${round_id}.md`;
  try {
    await uploadFile(path, markdown, 'overwrite');
    return path;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Same recovery pattern as shortlist-lock: if Photos/_AUDIT/ doesn't
    // exist, create it and retry once.
    if (msg.includes('path/not_found') || msg.includes('not_found')) {
      try {
        const auditDir = `${dropboxRoot.replace(/\/+$/, '')}/Photos/_AUDIT`;
        await createFolder(auditDir);
        await uploadFile(path, markdown, 'overwrite');
        return path;
      } catch (retryErr) {
        const m = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(`[${GENERATOR}] markdown report upload retry failed: ${m}`);
        return null;
      }
    }
    console.warn(`[${GENERATOR}] markdown report upload failed: ${msg}`);
    return null;
  }
}

// ─── Background processing ───────────────────────────────────────────────────

interface ProcessComparisonArgs {
  round_id: string;
  ctx: Awaited<ReturnType<typeof loadRoundContext>>;
  compositionsToRun: CompositionRow[];
  vendors_to_compare: VendorConfig[];
  pass_kinds: ('unified' | 'description_backfill')[];
  prompt: { system: string; userPrefix: string };
  spec: Stage1CallSpec;
  /** iter-5: voice tier + override + Stage 4 toggle */
  iter5_voice?: {
    tier: 'premium' | 'standard' | 'approachable';
    override: string | null;
  };
  iter5_run_stage4?: boolean;
  /** iter-5: skip Stage 1 entirely (rely on primed runs), run only Stage 4. */
  iter5_stage4_only?: boolean;
  /** iter-5b: source type for source-context preamble. Default 'internal_raw'. */
  iter5_source_type?: SourceType;
}

interface PrimedRun {
  group_id: string;
  label: string;
  output: Record<string, unknown>;
  cost_usd: number;
  elapsed_ms: number;
}

/**
 * Load existing successful shadow_runs for this (round, vendor-set) so we
 * don't re-pay for compositions we've already classified. Per-vendor cache:
 * if a (group_id, label) already has response_output != null, we reuse it
 * and skip the API call.
 *
 * This is crucial for iterative debugging — when a vendor (e.g. Gemini)
 * fails 95% of compositions and the adapter is fixed, re-running the
 * harness should ONLY retry the failed combos, not re-pay $6 for the
 * already-good Anthropic side.
 */
async function loadPrimedRuns(
  round_id: string,
  labels: string[],
): Promise<Map<string, PrimedRun>> {
  const primed = new Map<string, PrimedRun>();
  if (labels.length === 0) return primed;
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('vendor_shadow_runs')
    .select('group_id, label, response_output, response_usage, vendor_meta')
    .eq('round_id', round_id)
    .in('label', labels)
    .not('response_output', 'is', null);
  if (error) {
    console.warn(`[${GENERATOR}] loadPrimedRuns failed (will treat all as fresh): ${error.message}`);
    return primed;
  }
  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const group_id = row.group_id as string;
    const label = row.label as string;
    const output = row.response_output as Record<string, unknown> | null;
    if (!output) continue;
    const usage = (row.response_usage as Record<string, unknown> | null) || {};
    const vendor_meta = (row.vendor_meta as Record<string, unknown> | null) || {};
    const cost_usd = typeof usage.estimated_cost_usd === 'number' ? usage.estimated_cost_usd : 0;
    const elapsed_ms = typeof vendor_meta.elapsed_ms === 'number' ? vendor_meta.elapsed_ms : 0;
    primed.set(`${group_id}::${label}`, { group_id, label, output, cost_usd, elapsed_ms });
  }
  return primed;
}

/**
 * Process one composition: fetch preview once, fan out one call per vendor
 * in parallel, persist shadow runs, return the per-vendor summaries.
 *
 * Each call has the adapter's own AbortSignal.timeout(90s) — the slowest
 * vendor caps the composition's wall time.
 */
async function processOneComposition(
  comp: CompositionRow,
  vendors_to_compare: VendorConfig[],
  prompt: { system: string; userPrefix: string },
  pass_kinds: ('unified' | 'description_backfill')[],
  round_id: string,
  dropboxRoot: string,
  primed: Map<string, PrimedRun>,
  spec: Stage1CallSpec,
): Promise<Array<{
  cfg: VendorConfig;
  group_id: string;
  stem: string;
  resp: VisionResponse | null;
  elapsed_ms: number;
  cost_usd: number;
  err?: string;
  primed?: boolean;
}>> {
  // Determine which vendors actually need a fresh API call. If a vendor
  // already has a successful shadow_run for this (round, group, label) we
  // reuse it via the primed map and skip the call.
  const vendorsToCall: VendorConfig[] = [];
  const primedResults: Array<{
    cfg: VendorConfig;
    group_id: string;
    stem: string;
    resp: VisionResponse | null;
    elapsed_ms: number;
    cost_usd: number;
    err?: string;
    primed?: boolean;
  }> = [];
  for (const cfg of vendors_to_compare) {
    const key = `${comp.group_id}::${cfg.label}`;
    const p = primed.get(key);
    if (p) {
      // Reconstruct a minimal VisionResponse-shaped record so downstream
      // metrics see the cached output. resp is intentionally null since
      // there's no fresh adapter response — we hand-pack the fields the
      // summary loop reads.
      primedResults.push({
        cfg,
        group_id: comp.group_id,
        stem: comp.stem,
        resp: {
          output: p.output,
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, estimated_cost_usd: p.cost_usd },
          vendor_meta: { vendor: cfg.vendor, model: cfg.model, request_id: '', finish_reason: 'stop', elapsed_ms: p.elapsed_ms },
          raw_response_excerpt: '',
        } as VisionResponse,
        elapsed_ms: p.elapsed_ms,
        cost_usd: p.cost_usd,
        primed: true,
      });
    } else {
      vendorsToCall.push(cfg);
    }
  }
  // Skip preview fetch entirely if every vendor is already primed.
  if (vendorsToCall.length === 0) return primedResults;

  const previewPath = `${dropboxRoot.replace(/\/+$/, '')}/Photos/Raws/Shortlist Proposed/Previews/${comp.stem}.jpg`;
  let preview: { data: string; media_type: string } | null = null;
  let previewErr: string | null = null;
  try {
    preview = await fetchPreviewBase64(previewPath);
  } catch (err) {
    previewErr = err instanceof Error ? err.message : String(err);
  }

  const passKind: 'unified' | 'description_backfill' = pass_kinds.includes('unified')
    ? 'unified'
    : pass_kinds[0];

  // Fan out vendors in parallel for this composition (those not already primed).
  const vendorResults = await Promise.all(vendorsToCall.map(async (cfg) => {
    const startSpan = Date.now();
    let resp: VisionResponse | null = null;
    let err: string | undefined;
    let request_payload: VisionRequest;

    if (preview) {
      request_payload = {
        vendor: cfg.vendor,
        model: cfg.model,
        tool_name: spec.toolName,
        tool_input_schema: spec.toolSchema,
        system: prompt.system,
        user_text: prompt.userPrefix,
        images: [{ source_type: 'base64', media_type: preview.media_type, data: preview.data }],
        max_output_tokens: spec.maxOutputTokens,
        temperature: 0,
        thinking_budget: spec.thinkingBudget,
      };
      const r = await runVendorOnComposition(cfg, comp, preview, prompt.system, prompt.userPrefix, spec);
      resp = r.resp;
      err = r.error;
    } else {
      err = previewErr || 'preview unavailable';
      request_payload = {
        vendor: cfg.vendor,
        model: cfg.model,
        tool_name: spec.toolName,
        tool_input_schema: spec.toolSchema,
        system: prompt.system,
        user_text: prompt.userPrefix,
        images: [],
        max_output_tokens: spec.maxOutputTokens,
        temperature: 0,
        thinking_budget: spec.thinkingBudget,
      };
    }

    try {
      await persistShadowRun(round_id, cfg, comp, resp, err, passKind, request_payload);
    } catch (persistErr) {
      console.warn(`[${GENERATOR}] persist shadow run failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
    }

    const elapsed_ms = resp?.vendor_meta.elapsed_ms ?? (Date.now() - startSpan);
    const cost_usd = resp?.usage.estimated_cost_usd ?? 0;
    return { cfg, group_id: comp.group_id, stem: comp.stem, resp, elapsed_ms, cost_usd, err };
  }));

  // Merge primed (cached) results with fresh API results. Order doesn't
  // matter for the summary aggregation downstream.
  return [...primedResults, ...vendorResults];
}

/**
 * Run the full composition sweep + metrics + persistence asynchronously.
 *
 * Invoked via `EdgeRuntime.waitUntil(...)` from the handler so the request
 * returns immediately and the worker keeps running until this resolves.
 *
 * Progress is observable in real time via:
 *   SELECT count(*) FROM vendor_shadow_runs WHERE round_id = '<id>'
 * which increments after each vendor call persists.
 *
 * The final markdown report appears at:
 *   <dropbox_root>/Photos/_AUDIT/vendor_comparison_<round_id>.md
 *
 * On completion, vendor_comparison_results gets one row per (primary, shadow)
 * pair.
 */
// ─── iter-5 Stage 4: visual master synthesis ─────────────────────────────────

/**
 * Build the merged Stage 1 entries the Stage 4 prompt needs as text context.
 * Pulls per-image classification + iter-5 enrichments from the Stage 1
 * `results` array (which holds the parsed tool output per composition).
 */
function buildStage1Merged(
  comps: CompositionRow[],
  stage1Results: Array<{ group_id: string; stem: string; output: Record<string, unknown> }>,
): Stage1MergedEntry[] {
  // Map by group_id so we can preserve composition order from `comps`.
  const byGroup: Map<string, Record<string, unknown>> = new Map();
  for (const r of stage1Results) byGroup.set(r.group_id, r.output);

  const merged: Stage1MergedEntry[] = [];
  for (const c of comps) {
    const out = byGroup.get(c.group_id);
    if (!out) continue;
    const lc = (out.listing_copy as Record<string, unknown> | null) ?? null;
    const cpf = (out.confidence_per_field as Record<string, unknown> | null) ?? null;
    merged.push({
      stem: c.stem,
      group_id: c.group_id,
      group_index: c.group_index,
      room_type: typeof out.room_type === 'string' ? (out.room_type as string) : null,
      composition_type: typeof out.composition_type === 'string' ? (out.composition_type as string) : null,
      vantage_point: typeof out.vantage_point === 'string' ? (out.vantage_point as string) : null,
      technical_score: typeof out.technical_score === 'number' ? (out.technical_score as number) : null,
      lighting_score: typeof out.lighting_score === 'number' ? (out.lighting_score as number) : null,
      composition_score: typeof out.composition_score === 'number' ? (out.composition_score as number) : null,
      aesthetic_score: typeof out.aesthetic_score === 'number' ? (out.aesthetic_score as number) : null,
      is_styled: typeof out.is_styled === 'boolean' ? (out.is_styled as boolean) : null,
      indoor_outdoor_visible: typeof out.indoor_outdoor_visible === 'boolean'
        ? (out.indoor_outdoor_visible as boolean) : null,
      clutter_severity: typeof out.clutter_severity === 'string' ? (out.clutter_severity as string) : null,
      flag_for_retouching: typeof out.flag_for_retouching === 'boolean'
        ? (out.flag_for_retouching as boolean) : null,
      appeal_signals: Array.isArray(out.appeal_signals) ? (out.appeal_signals as string[]) : null,
      concern_signals: Array.isArray(out.concern_signals) ? (out.concern_signals as string[]) : null,
      retouch_priority: typeof out.retouch_priority === 'string' ? (out.retouch_priority as string) : null,
      gallery_position_hint: typeof out.gallery_position_hint === 'string'
        ? (out.gallery_position_hint as string) : null,
      shot_intent: typeof out.shot_intent === 'string' ? (out.shot_intent as string) : null,
      style_archetype: typeof out.style_archetype === 'string' ? (out.style_archetype as string) : null,
      era_hint: typeof out.era_hint === 'string' ? (out.era_hint as string) : null,
      material_palette_summary: Array.isArray(out.material_palette_summary)
        ? (out.material_palette_summary as string[]) : null,
      embedding_anchor_text: typeof out.embedding_anchor_text === 'string'
        ? (out.embedding_anchor_text as string) : null,
      key_elements: Array.isArray(out.key_elements) ? (out.key_elements as string[]) : null,
      zones_visible: Array.isArray(out.zones_visible) ? (out.zones_visible as string[]) : null,
      listing_copy: lc ? {
        headline: typeof lc.headline === 'string' ? (lc.headline as string) : '',
        paragraphs: typeof lc.paragraphs === 'string' ? (lc.paragraphs as string) : '',
      } : null,
      social_first_friendly: typeof out.social_first_friendly === 'boolean'
        ? (out.social_first_friendly as boolean) : null,
      requires_human_review: typeof out.requires_human_review === 'boolean'
        ? (out.requires_human_review as boolean) : null,
      confidence_per_field: cpf ? {
        room_type: typeof cpf.room_type === 'number' ? (cpf.room_type as number) : undefined,
        scoring: typeof cpf.scoring === 'number' ? (cpf.scoring as number) : undefined,
        classification: typeof cpf.classification === 'number' ? (cpf.classification as number) : undefined,
      } : null,
    });
  }
  return merged;
}

/**
 * Run Stage 4 visual master synthesis for a single vendor.
 *
 * Inputs:
 *   - All Stage 1 successful results (text context)
 *   - All preview images (visual context)
 *   - Property facts + voice anchor + Sydney primer
 *
 * Persists the response to `vendor_shadow_runs` with pass_kind='stage4'
 * and group_id=NULL (round-level emission, not per-composition).
 *
 * Returns cost + elapsed for cost-rollup. Full output stays in DB.
 */
async function runStage4(
  cfg: VendorConfig,
  ctx: Awaited<ReturnType<typeof loadRoundContext>>,
  comps: CompositionRow[],
  stage1Results: Array<{ group_id: string; stem: string; output: Record<string, unknown> }>,
  voice: { tier: 'premium' | 'standard' | 'approachable'; override: string | null },
  dropboxRoot: string,
  round_id: string,
  sourceType: SourceType,
): Promise<{ ok: boolean; cost_usd: number; elapsed_ms: number; error?: string }> {
  const start = Date.now();

  // Skip Anthropic for Stage 4 in iter-5 — Stage 4 is Gemini-anchored per
  // W11.7 (cheaper, multi-image-friendly, higher output ceiling). When the
  // operator wires Anthropic into the harness for an audit run, we just log
  // and skip — they can use force_iter5 + a separate label.
  if (cfg.vendor !== 'google') {
    console.log(
      `[${GENERATOR}] Stage 4 skipped for ${cfg.label} — Stage 4 is Gemini-only ` +
      'in iter-5 harness (Anthropic failover via W11.8 not yet wired)',
    );
    return { ok: false, cost_usd: 0, elapsed_ms: 0, error: 'stage4_anthropic_not_wired' };
  }

  // Build merged Stage 1 entries (compact per-image text context).
  const stage1Merged = buildStage1Merged(comps, stage1Results);

  // Fetch ALL preview images. Do this in parallel with reasonable
  // concurrency — Dropbox tolerates ~10 simultaneous downloads.
  const stems: string[] = stage1Merged.map((m) => m.stem);
  const PREVIEW_CONCURRENCY = 8;
  const previews: Array<{ stem: string; data: string; media_type: string } | null> = [];
  for (let i = 0; i < stems.length; i += PREVIEW_CONCURRENCY) {
    const slice = stems.slice(i, i + PREVIEW_CONCURRENCY);
    const fetched = await Promise.all(slice.map(async (stem) => {
      const path = `${dropboxRoot.replace(/\/+$/, '')}/Photos/Raws/Shortlist Proposed/Previews/${stem}.jpg`;
      try {
        const p = await fetchPreviewBase64(path);
        return { stem, data: p.data, media_type: p.media_type };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] Stage 4 preview ${stem} fetch failed: ${msg}`);
        return null;
      }
    }));
    previews.push(...fetched);
  }
  const validPreviews = previews.filter((p): p is { stem: string; data: string; media_type: string } => p !== null);
  if (validPreviews.length === 0) {
    return { ok: false, cost_usd: 0, elapsed_ms: Date.now() - start, error: 'no_previews_fetched' };
  }

  const userText = buildStage4UserPrompt({
    voice,
    propertyFacts: ctx.project.property_facts,
    stage1Merged,
    imageStemsInBatchOrder: validPreviews.map((p) => p.stem),
    totalImages: validPreviews.length,
    sourceType,
  });

  const sysText = [
    buildStage4SystemPrompt(),
    '',
    SYDNEY_PRIMER_BLOCK,
  ].join('\n');

  // Stage 4 budget: thinkingBudget=16384 + max_output_tokens=16000.
  // Cost-cap-friendly even at $1.20-ish per call.
  const req: VisionRequest = {
    vendor: cfg.vendor,
    model: cfg.model,
    tool_name: STAGE4_TOOL_NAME,
    tool_input_schema: STAGE4_TOOL_SCHEMA,
    system: sysText,
    user_text: userText,
    images: validPreviews.map((p) => ({
      source_type: 'base64',
      media_type: p.media_type,
      data: p.data,
    })),
    max_output_tokens: 16000,
    temperature: 0,
    thinking_budget: 16384,
    timeout_ms: 240_000, // 4 min — Stage 4 takes 60-90s on Gemini Pro
  };

  let resp: VisionResponse | null = null;
  let err: string | undefined;
  try {
    resp = await callVisionAdapter(req);
  } catch (e) {
    if (e instanceof MissingVendorCredential) err = e.message;
    else if (e instanceof VendorCallError) err = `${e.vendor}/${e.model} ${e.status ?? ''}: ${e.message}`;
    else err = e instanceof Error ? e.message : String(e);
  }

  // Persist to vendor_shadow_runs with pass_kind='stage4', group_id=NULL.
  // Strip base64 from the persisted request_payload — same pattern as Stage 1.
  const safe_request: Record<string, unknown> = {
    ...req,
    images: req.images.map((i) => ({
      source_type: i.source_type,
      media_type: i.media_type,
      data_length: i.data?.length ?? 0,
    })),
  };
  // Tag the prompt versions in the response for replay reproducibility.
  const enrichedOutput = resp
    ? { ...resp.output, _harness_meta: { ...stage4PromptVersions(), images_sent: validPreviews.length } }
    : null;

  const admin = getAdminClient();
  const insertRow: Record<string, unknown> = {
    round_id,
    pass_kind: 'stage4',
    vendor: cfg.vendor,
    model: cfg.model,
    label: cfg.label,
    group_id: null,
    request_payload: safe_request,
    response_output: enrichedOutput,
    response_usage: resp?.usage ?? null,
    vendor_meta: resp?.vendor_meta ?? null,
    error_message: err ?? null,
  };
  const { error: insErr } = await admin.from('vendor_shadow_runs').insert(insertRow);
  if (insErr) {
    console.warn(`[${GENERATOR}] Stage 4 vendor_shadow_runs insert failed: ${insErr.message}`);
  }

  return {
    ok: !!resp && !err,
    cost_usd: resp?.usage.estimated_cost_usd ?? 0,
    elapsed_ms: resp?.vendor_meta.elapsed_ms ?? (Date.now() - start),
    error: err,
  };
}

async function processComparison(args: ProcessComparisonArgs): Promise<void> {
  const { round_id, ctx, compositionsToRun, vendors_to_compare, pass_kinds, prompt, spec } = args;
  const startedAt = Date.now();

  const runs: Map<string, VendorRunSummary> = new Map();
  for (const cfg of vendors_to_compare) {
    runs.set(cfg.label, {
      label: cfg.label,
      vendor: cfg.vendor,
      model: cfg.model,
      total_cost_usd: 0,
      total_elapsed_ms: 0,
      composition_count: 0,
      failure_count: 0,
      results: [],
    });
  }

  const dropboxRoot = ctx.project.dropbox_root_path;
  if (!dropboxRoot) {
    console.warn(`[${GENERATOR}] project has no dropbox_root_path; nothing to fetch — abort`);
    return;
  }

  // Prime from existing successful shadow_runs so we don't re-pay for
  // already-classified (composition, vendor) combos. Hugely useful for
  // iterative debugging when one vendor's adapter fails most calls and
  // gets fixed — second run reuses the good vendor's data.
  const primed = await loadPrimedRuns(round_id, vendors_to_compare.map((v) => v.label));
  if (primed.size > 0) {
    console.log(`[${GENERATOR}] primed ${primed.size} cached results from prior shadow_runs (skipping those API calls)`);
  }

  // iter-5 stage4_only: skip Stage 1 entirely. Pre-populate `runs` with the
  // primed (already-completed) Stage 1 outputs so Stage 4 can run against them
  // directly. Used to recover from edge runtime wall-time deaths during the
  // long-running Stage 1 + Stage 4 chain.
  if (args.iter5_stage4_only) {
    console.log(`[${GENERATOR}] stage4_only mode: skipping Stage 1, using ${primed.size} primed results`);
    for (const cfg of vendors_to_compare) {
      const summary = runs.get(cfg.label);
      if (!summary) continue;
      for (const comp of compositionsToRun) {
        const key = `${comp.group_id}::${cfg.label}`;
        const p = primed.get(key);
        if (p) {
          summary.results.push({ group_id: comp.group_id, stem: comp.stem, output: p.output });
          summary.composition_count += 1;
          summary.total_cost_usd += p.cost_usd;
          summary.total_elapsed_ms += p.elapsed_ms;
        }
      }
      console.log(
        `[${GENERATOR}] stage4_only: ${cfg.label} loaded ${summary.results.length} primed Stage 1 results`,
      );
    }
  } else {
  // Process compositions in batches, fanning out vendors per composition.
  for (let i = 0; i < compositionsToRun.length; i += BATCH_SIZE) {
    const batch = compositionsToRun.slice(i, i + BATCH_SIZE);
    console.log(`[${GENERATOR}] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(compositionsToRun.length / BATCH_SIZE)} (compositions ${i + 1}..${Math.min(i + BATCH_SIZE, compositionsToRun.length)})`);
    const batchResults = await Promise.all(batch.map((comp) =>
      processOneComposition(comp, vendors_to_compare, prompt, pass_kinds, round_id, dropboxRoot, primed, spec)
        .catch((err) => {
          console.error(`[${GENERATOR}] composition ${comp.stem} failed: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Array<{
            cfg: VendorConfig;
            group_id: string;
            stem: string;
            resp: VisionResponse | null;
            elapsed_ms: number;
            cost_usd: number;
            err?: string;
            primed?: boolean;
          }>;
        })
    ));
    for (const compResults of batchResults) {
      for (const r of compResults) {
        const summary = runs.get(r.cfg.label)!;
        summary.composition_count += 1;
        summary.total_cost_usd += r.cost_usd;
        summary.total_elapsed_ms += r.elapsed_ms;
        if (r.resp) {
          summary.results.push({ group_id: r.group_id, stem: r.stem, output: r.resp.output });
        } else {
          summary.failure_count += 1;
        }
      }
    }
  }
  } // close stage4_only-or-stage1-sweep else

  // ─── iter-5 Stage 4: visual master synthesis ─────────────────────────────
  // Sequential after all Stage 1 batches complete. One call per vendor that
  // has a successful Stage 1 result set. Sees ALL preview images at once +
  // merged Stage 1 JSON as text context. Produces slot_decisions, master
  // listing, gallery_sequence, dedup_groups, missing_shot_recommendations,
  // narrative_arc_score, property_archetype_consensus, overall_property_score,
  // stage_4_overrides[], coverage_notes, quality_outliers.
  if (args.iter5_run_stage4 && args.iter5_voice) {
    for (const cfg of vendors_to_compare) {
      const stage1Summary = runs.get(cfg.label);
      if (!stage1Summary) continue;
      if (stage1Summary.results.length < 5) {
        console.warn(
          `[${GENERATOR}] Stage 4 skipped for ${cfg.label} — only ` +
          `${stage1Summary.results.length} successful Stage 1 results (need >=5)`,
        );
        continue;
      }
      try {
        const stage4Result = await runStage4(
          cfg,
          ctx,
          compositionsToRun,
          stage1Summary.results,
          args.iter5_voice,
          dropboxRoot,
          round_id,
          args.iter5_source_type ?? 'internal_raw',
        );
        // Roll Stage 4 cost + elapsed into the summary so the final report
        // surfaces the total bill correctly.
        stage1Summary.total_cost_usd += stage4Result.cost_usd;
        stage1Summary.total_elapsed_ms += stage4Result.elapsed_ms;
        console.log(
          `[${GENERATOR}] Stage 4 ${cfg.label}: $${stage4Result.cost_usd.toFixed(4)}, ` +
          `${stage4Result.elapsed_ms}ms, output=${stage4Result.ok ? 'ok' : 'fail'}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${GENERATOR}] Stage 4 ${cfg.label} failed: ${msg}`);
      }
    }
  }

  // Comparison metrics — pairwise (every vendor against the first).
  const labels = vendors_to_compare.map((v) => v.label);
  if (labels.length < 2) {
    console.log(`[${GENERATOR}] single-vendor mode — no pairwise comparison`);
    return;
  }

  const primary = runs.get(labels[0])!;
  const allComparisons = labels.slice(1).map((shadowLabel) => {
    const shadow = runs.get(shadowLabel)!;
    const agreement = computeAgreementMatrix(primary.results, shadow.results);
    const score = computeScoreDelta(primary.results, shadow.results);
    const obj = computeObjectOverlap(primary.results, shadow.results);
    const room = computeRoomTypeAgreement(primary.results, shadow.results);
    return { primary, shadow, agreement, score, obj, room };
  });

  const markdown = generateMarkdownReport(round_id, allComparisons);
  const dropbox_report_path = await uploadComparisonReport(dropboxRoot, round_id, markdown);

  const admin = getAdminClient();
  for (const c of allComparisons) {
    const summary_truncated = markdown.slice(0, 2000);
    const { error: insErr } = await admin.from('vendor_comparison_results').insert({
      round_id,
      primary_vendor: c.primary.vendor,
      primary_model: c.primary.model,
      primary_label: c.primary.label,
      shadow_vendor: c.shadow.vendor,
      shadow_model: c.shadow.model,
      shadow_label: c.shadow.label,
      slot_decision_agreement_rate: null,
      near_duplicate_agreement_rate: null,
      classification_agreement_rate: c.room.agreement_rate,
      combined_score_mean_abs_delta: c.score.mean_abs_delta,
      combined_score_correlation: c.score.correlation,
      observed_objects_overlap_rate: c.obj.jaccard,
      primary_cost_usd: Number(c.primary.total_cost_usd.toFixed(6)),
      shadow_cost_usd: Number(c.shadow.total_cost_usd.toFixed(6)),
      primary_elapsed_ms: c.primary.total_elapsed_ms,
      shadow_elapsed_ms: c.shadow.total_elapsed_ms,
      disagreement_summary: summary_truncated,
      dropbox_report_path,
    }).select('id').single();
    if (insErr) {
      console.warn(`[${GENERATOR}] vendor_comparison_results insert failed: ${insErr.message}`);
    }
  }

  const elapsed_total_s = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[${GENERATOR}] background sweep complete in ${elapsed_total_s}s — ${compositionsToRun.length} compositions × ${vendors_to_compare.length} vendors → ${dropbox_report_path ?? '(no report)'}`);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handler(req: Request): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method not allowed', 405);

  // Auth: master_admin only (or service-role).
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('unauthorized', 401);
  if (user.role !== 'master_admin') return errorResponse('forbidden — master_admin only', 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('invalid JSON body', 400);
  }
  const v = validateBody(body);
  if (!v.ok) return errorResponse(v.error, 400);
  const {
    round_id,
    vendors_to_compare,
    pass_kinds,
    cost_cap_usd,
    dry_run,
    max_groups,
    property_tier,
    property_voice_anchor_override,
    force_iter5,
    skip_stage4,
    stage4_only,
    source_type,
  } = v.req;
  // Default source_type to internal_raw — our primary workflow. The preamble
  // tells the model these are EV0 brackets, not finals; without it, Gemini
  // judges raw exposure characteristics as "technical failure".
  const sourceType: SourceType = source_type ?? 'internal_raw';

  // iter-5 mode activates when force_iter5=true OR any vendor label includes
  // "iter5". This keeps iter-4 the default path so legacy callers (e.g.
  // existing dashboards) continue to work unchanged.
  const iter5Active = !!force_iter5 || vendors_to_compare.some((cfg) => /iter5/i.test(cfg.label));
  const tier: 'premium' | 'standard' | 'approachable' = property_tier ?? 'standard';
  const voice = {
    tier,
    override: property_voice_anchor_override ?? null,
  };

  // Load round + project + composition_groups.
  let ctx: Awaited<ReturnType<typeof loadRoundContext>>;
  try {
    ctx = await loadRoundContext(round_id);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 404);
  }

  const total_compositions = max_groups
    ? Math.min(ctx.compositions.length, max_groups)
    : ctx.compositions.length;
  if (total_compositions === 0) {
    return errorResponse('round has no composition_groups', 400);
  }

  // Cost pre-flight.
  const preflight: Array<{ label: string; estimated_usd: number }> = [];
  let total_estimated = 0;
  for (const cfg of vendors_to_compare) {
    // stage4_only mode skips Stage 1 entirely → preflight only the single
    // Stage 4 call (~$1.50 envelope, conservative).
    const usd = stage4_only
      ? estimateCost(cfg.vendor, cfg.model, {
          input_tokens: 60_000,    // ~42 images * ~1.5K + prompt
          output_tokens: 16_000,   // master_listing + slot_decisions verbose
          cached_input_tokens: 0,
        })
      : preflightCost(cfg.vendor, cfg.model, total_compositions);
    preflight.push({ label: cfg.label, estimated_usd: Number(usd.toFixed(4)) });
    total_estimated += usd;
  }
  total_estimated = Number(total_estimated.toFixed(4));

  if (total_estimated > cost_cap_usd) {
    const detail = JSON.stringify({
      total_estimated_usd: total_estimated,
      cost_cap_usd,
      preflight,
    });
    return errorResponse(
      `pre-flight cost $${total_estimated.toFixed(4)} exceeds cap $${cost_cap_usd.toFixed(4)} | detail: ${detail}`,
      400,
    );
  }

  if (dry_run) {
    return jsonResponse({
      ok: true,
      mode: 'dry_run',
      round_id,
      total_compositions,
      preflight,
      total_estimated_usd: total_estimated,
      cost_cap_usd,
    });
  }

  // Build the prompt once. It's identical across vendors — only the call
  // changes. Pass 1 prompt has all the room/composition/vantage/clutter
  // taxonomy + scoring anchors per spec Section 5 step 3.
  const anchors = await getActiveStreamBAnchors();
  const prompt = buildPass1Prompt(anchors);
  const compositionsToRun = ctx.compositions.slice(0, total_compositions);

  // Spec selection — iter-5 when active, iter-4 default.
  // iter-5 differences:
  //   - schema enriched (per-image listing_copy, appeal/concern, retouch_priority,
  //     gallery_position_hint, style_archetype, era_hint, embedding_anchor_text,
  //     shot_intent, confidence_per_field, material_palette_summary)
  //   - thinkingBudget bumped to 2048 (Pro Stage 1)
  //   - max_output_tokens bumped to 6000 (more headroom for richer schema)
  //   - voice anchor + Sydney primer + self-critique injected into user_text
  //   - Stage 4 visual master synthesis fires after Stage 1 completes
  const spec: Stage1CallSpec = iter5Active
    ? {
        iter5: true,
        toolName: COMPARISON_TOOL_NAME_ITER5,
        toolSchema: COMPARISON_TOOL_SCHEMA_ITER5,
        thinkingBudget: 2048,
        maxOutputTokens: 6000,
      }
    : {
        iter5: false,
        toolName: COMPARISON_TOOL_NAME,
        toolSchema: COMPARISON_TOOL_SCHEMA,
        thinkingBudget: 1024,
        maxOutputTokens: 4000,
      };

  // Build the per-image (Stage 1) user prompt. iter-4 baseline = pass1
  // userPrefix + V2 taxonomy. iter-5 also injects voice anchor + Sydney
  // primer + self-critique block, all consistent with the W11.7 spec.
  // iter-5b: source-context preamble at the TOP so the model reads source
  // type (RAW/finals/external/floorplan) before any other instruction.
  const userPrefixBase = prompt.userPrefix + V2_TAXONOMY_AND_GRANULARITY_INSTRUCTION;
  const userPrefix = iter5Active
    ? [
        sourceContextBlock(sourceType),
        '',
        userPrefixBase,
        '',
        '── VOICE ANCHOR (drives per-image listing_copy register) ──',
        voiceAnchorBlock(voice),
        '',
        '── SELF-CRITIQUE ──',
        SELF_CRITIQUE_BLOCK,
      ].join('\n')
    : userPrefixBase;

  // System prompt: iter-5 layers the Sydney typology primer onto the iter-4
  // pass1 system prompt. Stage 4 receives the same primer — but Stage 1's
  // style_archetype + era_hint emissions come from each per-image call so the
  // primer goes into Stage 1 system text directly.
  const systemText = iter5Active
    ? [prompt.system, '', '', SYDNEY_PRIMER_BLOCK].join('\n')
    : prompt.system;

  // Kick off the heavy work in the background. The request returns
  // immediately with a "started" ack so the gateway doesn't time out.
  // Progress is observable via vendor_shadow_runs row count for round_id.
  const bgWork = processComparison({
    round_id,
    ctx,
    compositionsToRun,
    vendors_to_compare,
    pass_kinds,
    prompt: { system: systemText, userPrefix },
    spec,
    iter5_voice: iter5Active ? voice : undefined,
    iter5_run_stage4: iter5Active && !skip_stage4,
    iter5_stage4_only: iter5Active && !!stage4_only,
    iter5_source_type: sourceType,
  }).catch((err) => {
    console.error(`[${GENERATOR}] background sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse({
    ok: true,
    mode: 'background',
    round_id,
    total_compositions,
    vendors: vendors_to_compare.map((cfg) => ({ label: cfg.label, vendor: cfg.vendor, model: cfg.model })),
    preflight,
    total_estimated_usd: total_estimated,
    cost_cap_usd,
    iter5_active: iter5Active,
    property_tier: tier,
    will_run_stage4: iter5Active && !skip_stage4,
    progress_query: `SELECT vendor, label, pass_kind, count(*) FROM vendor_shadow_runs WHERE round_id = '${round_id}' GROUP BY vendor, label, pass_kind`,
    note: iter5Active
      ? `iter-5 sweep running in background. Stage 1: ${total_compositions} compositions × ${vendors_to_compare.length} vendors @ thinkingBudget=2048. ` +
        (skip_stage4 ? 'Stage 4 SKIPPED.' : `Stage 4 visual master synthesis follows (1 call/vendor seeing all ${total_compositions} images at thinkingBudget=16384).`)
      : `Sweep running in background. Expect ~${Math.ceil(total_compositions / BATCH_SIZE) * 30}s wall time at ${BATCH_SIZE}-composition batches × parallel vendors. Report will appear at Photos/_AUDIT/vendor_comparison_${round_id}.md`,
  });
}

serveWithAudit(GENERATOR, handler);

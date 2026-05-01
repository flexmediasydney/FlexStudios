/**
 * floorplanExtractor.ts — pure helpers for the W13c floorplan OCR extractor.
 *
 * Exported:
 *   - FLOORPLAN_EXTRACTOR_BLOCK_VERSION   (prompt block version stamp)
 *   - buildFloorplanRequest()             (assembles VisionRequest with W7.6 source-context block)
 *   - parseFloorplanOutput()              (validates + normalises model output to FloorplanModelOutput)
 *   - computeCrossCheckFlags()            (token list when extracted ≠ CRM)
 *   - computeUrlHash()                    (sha-256 hex of URL — idempotency key)
 *
 * Pure (no side effects, no Deno-runtime deps beyond crypto.subtle which works
 * everywhere we run). Unit-testable.
 */

import {
  sourceContextBlock,
  type SourceType,
} from '../_shared/visionPrompts/blocks/sourceContextBlock.ts';
import type { VisionRequest } from '../_shared/visionAdapter/index.ts';

export const FLOORPLAN_EXTRACTOR_BLOCK_VERSION = 'v1.0';

const SOURCE_TYPE: SourceType = 'floorplan_image';

// ─── Output shape ────────────────────────────────────────────────────────────

export type HomeArchetype =
  | 'open_plan' | 'traditional' | 'split_level'
  | 'townhouse' | 'duplex' | 'apartment'
  | 'unit' | 'studio' | 'unknown';

export type GarageType =
  | 'lock_up' | 'carport' | 'tandem'
  | 'double' | 'single' | 'none' | 'unknown';

export interface RoomDetected {
  room_label: string;
  count: number;
  dimensions_sqm?: number;
}

export interface FlowPath {
  from: string;
  to: string;
}

export interface FloorplanModelOutput {
  total_internal_sqm: number | null;
  total_land_sqm: number | null;
  rooms_detected: RoomDetected[];
  bedrooms_count: number | null;
  bathrooms_count: number | null;
  home_archetype: HomeArchetype;
  north_arrow_orientation: number | null;
  garage_type: GarageType;
  flow_paths: FlowPath[];
  legibility_score: number;
  extraction_confidence: number;
}

export interface FloorplanExtractRow extends FloorplanModelOutput {
  pulse_listing_id: string;
  floorplan_url: string;
  floorplan_url_hash: string;
  cross_check_flags: string[];
  vendor_used: 'google' | 'anthropic';
  model_used: string;
  cost_usd: number;
  elapsed_ms: number;
  prompt_block_versions: Record<string, string>;
  raw_response_excerpt: string;
}

// ─── System + user prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are a floorplan OCR + structural analysis engine.',
  'You are looking at architectural floorplan drawings (NOT photographs).',
  'Your job is to extract every legible textual + structural signal — room labels,',
  'dimensions, total areas, archetype, north arrow, garage type, and which rooms',
  'connect to which.',
  '',
  'Return STRICT JSON matching the response schema. Be conservative on confidence:',
  'if a label is hard to read, set extraction_confidence below 0.7 and lower the',
  'legibility_score. Never invent numbers. Use null when the floorplan does not',
  'show the value.',
  '',
  'Bedrooms vs studies/offices: count a room as a bedroom only when it is labelled',
  'BED, BEDROOM, MASTER, MAIN, or has a built-in robe icon. Studies/offices that',
  'COULD be a bedroom should NOT be counted as bedrooms — they go in rooms_detected',
  'with room_label="study" or "office".',
  '',
  'The CRM has its own bedroom/bathroom counts; we use yours independently. Do not',
  'try to match the CRM — report what you see in the drawing.',
].join('\n');

function buildUserPrompt(args: {
  crm_bedrooms: number | null;
  crm_bathrooms: number | null;
}): string {
  const parts: string[] = [];
  parts.push(sourceContextBlock(SOURCE_TYPE));
  parts.push('');
  parts.push('── EXTRACTION TASK ──');
  parts.push('');
  parts.push('Extract every signal you can read from this floorplan. Specifically:');
  parts.push('');
  parts.push('1. total_internal_sqm: the labelled internal floor area in square metres,');
  parts.push('   or null if not labelled.');
  parts.push('2. total_land_sqm: the labelled total land area, or null.');
  parts.push('3. rooms_detected[]: list every labelled room. For each, emit:');
  parts.push('   - room_label (lowercased noun, e.g. "master", "ensuite", "kitchen",');
  parts.push('     "dining", "lounge", "alfresco", "bath", "laundry", "garage",');
  parts.push('     "study", "office", "wic", "powder", "pantry")');
  parts.push('   - count (how many rooms of that type appear, e.g. 3 bedrooms)');
  parts.push('   - dimensions_sqm (numeric area when legibly drawn, omit if unclear)');
  parts.push('4. bedrooms_count: integer count of true bedrooms (BED/BEDROOM/MASTER labels).');
  parts.push('5. bathrooms_count: integer count of bathrooms + ensuites (NOT powder rooms).');
  parts.push('6. home_archetype: one of open_plan | traditional | split_level | townhouse |');
  parts.push('   duplex | apartment | unit | studio | unknown.');
  parts.push('7. north_arrow_orientation: degrees (0=N, 90=E, 180=S, 270=W) when a north');
  parts.push('   arrow is visible; else null.');
  parts.push('8. garage_type: lock_up | carport | tandem | double | single | none | unknown.');
  parts.push('9. flow_paths[]: room-to-room connections you can read from the drawing,');
  parts.push('   e.g. [{from:"kitchen",to:"dining"},{from:"living",to:"alfresco"}].');
  parts.push('   Only emit pairs you can clearly see (an open archway, doorway, or shared');
  parts.push('   wall opening). Skip if uncertain.');
  parts.push('10. legibility_score: 0-10 self-rating of how readable the drawing is');
  parts.push('    (10 = crisp CAD drawing with all labels; 4 = blurry or partially missing labels).');
  parts.push('11. extraction_confidence: 0-1 self-rating of overall confidence.');
  parts.push('');

  if (args.crm_bedrooms !== null || args.crm_bathrooms !== null) {
    parts.push('── CRM CONTEXT (informational only) ──');
    if (args.crm_bedrooms !== null) {
      parts.push(`The agency CRM lists this property with ${args.crm_bedrooms} bedroom(s).`);
    }
    if (args.crm_bathrooms !== null) {
      parts.push(`The agency CRM lists this property with ${args.crm_bathrooms} bathroom(s).`);
    }
    parts.push('Report what YOU see independently — do not match the CRM. Discrepancies are');
    parts.push('valuable signal (the agent may have under/over-stated; the floorplan may show');
    parts.push('a study labelled as a bedroom; etc.).');
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Response schema (JSON Schema subset that Gemini accepts) ───────────────

// NOTE: Gemini's responseSchema is OpenAPI-3.0 (subset, protobuf-backed) — it
// does NOT accept JSON-Schema-style `type: ["number", "null"]` arrays. Nullable
// fields must use OpenAPI's `nullable: true` flag. Keep this in mind if/when
// the schema evolves: switching the producer to a stricter JSON-Schema vendor
// (e.g. Anthropic tool-use) would need a small adapter.
const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    total_internal_sqm: { type: 'number', nullable: true },
    total_land_sqm: { type: 'number', nullable: true },
    rooms_detected: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          room_label: { type: 'string' },
          count: { type: 'integer' },
          dimensions_sqm: { type: 'number', nullable: true },
        },
        required: ['room_label', 'count'],
      },
    },
    bedrooms_count: { type: 'integer', nullable: true },
    bathrooms_count: { type: 'integer', nullable: true },
    home_archetype: {
      type: 'string',
      enum: [
        'open_plan', 'traditional', 'split_level',
        'townhouse', 'duplex', 'apartment',
        'unit', 'studio', 'unknown',
      ],
    },
    north_arrow_orientation: { type: 'number', nullable: true },
    garage_type: {
      type: 'string',
      enum: [
        'lock_up', 'carport', 'tandem',
        'double', 'single', 'none', 'unknown',
      ],
    },
    flow_paths: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
        required: ['from', 'to'],
      },
    },
    legibility_score: { type: 'number' },
    extraction_confidence: { type: 'number' },
  },
  required: [
    'rooms_detected',
    'home_archetype',
    'garage_type',
    'flow_paths',
    'legibility_score',
    'extraction_confidence',
  ],
};

// ─── Public builders ─────────────────────────────────────────────────────────

export function buildFloorplanRequest(args: {
  base64: string;
  mediaType: string;
  crm_bedrooms: number | null;
  crm_bathrooms: number | null;
  model: string;
  vendor: 'google' | 'anthropic';
  thinking_budget: number;
  max_output_tokens: number;
}): VisionRequest {
  return {
    vendor: args.vendor,
    model: args.model,
    tool_name: 'submit_floorplan_extract',
    tool_input_schema: RESPONSE_SCHEMA,
    system: SYSTEM_PROMPT,
    user_text: buildUserPrompt({
      crm_bedrooms: args.crm_bedrooms,
      crm_bathrooms: args.crm_bathrooms,
    }),
    images: [
      { source_type: 'base64', media_type: args.mediaType, data: args.base64 },
    ],
    max_output_tokens: args.max_output_tokens,
    temperature: 0,
    thinking_budget: args.thinking_budget,
    timeout_ms: 90_000,
  };
}

// ─── Output parsing ──────────────────────────────────────────────────────────

const ALLOWED_ARCHETYPES = new Set<HomeArchetype>([
  'open_plan', 'traditional', 'split_level',
  'townhouse', 'duplex', 'apartment',
  'unit', 'studio', 'unknown',
]);
const ALLOWED_GARAGE = new Set<GarageType>([
  'lock_up', 'carport', 'tandem', 'double', 'single', 'none', 'unknown',
]);

export function parseFloorplanOutput(raw: Record<string, unknown>): FloorplanModelOutput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('floorplan output is not an object');
  }
  const out: FloorplanModelOutput = {
    total_internal_sqm: numberOrNull(raw.total_internal_sqm),
    total_land_sqm: numberOrNull(raw.total_land_sqm),
    rooms_detected: parseRooms(raw.rooms_detected),
    bedrooms_count: integerOrNull(raw.bedrooms_count),
    bathrooms_count: integerOrNull(raw.bathrooms_count),
    home_archetype: parseArchetype(raw.home_archetype),
    north_arrow_orientation: parseOrientation(raw.north_arrow_orientation),
    garage_type: parseGarage(raw.garage_type),
    flow_paths: parseFlowPaths(raw.flow_paths),
    legibility_score: clamp(asNumber(raw.legibility_score, 0), 0, 10),
    extraction_confidence: clamp(asNumber(raw.extraction_confidence, 0), 0, 1),
  };
  return out;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function integerOrNull(v: unknown): number | null {
  const n = numberOrNull(v);
  if (n === null) return null;
  return Math.round(n);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function parseArchetype(v: unknown): HomeArchetype {
  if (typeof v === 'string' && ALLOWED_ARCHETYPES.has(v as HomeArchetype)) {
    return v as HomeArchetype;
  }
  return 'unknown';
}
function parseGarage(v: unknown): GarageType {
  if (typeof v === 'string' && ALLOWED_GARAGE.has(v as GarageType)) {
    return v as GarageType;
  }
  return 'unknown';
}
function parseOrientation(v: unknown): number | null {
  const n = numberOrNull(v);
  if (n === null) return null;
  // Normalise to [0, 360)
  let deg = n % 360;
  if (deg < 0) deg += 360;
  return Math.round(deg * 100) / 100;
}
function parseRooms(v: unknown): RoomDetected[] {
  if (!Array.isArray(v)) return [];
  const out: RoomDetected[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    const label = typeof obj.room_label === 'string' ? obj.room_label.trim().toLowerCase() : '';
    const count = integerOrNull(obj.count);
    if (!label || count === null || count <= 0) continue;
    const room: RoomDetected = { room_label: label, count };
    const dims = numberOrNull(obj.dimensions_sqm);
    if (dims !== null && dims > 0) room.dimensions_sqm = dims;
    out.push(room);
  }
  return out;
}
function parseFlowPaths(v: unknown): FlowPath[] {
  if (!Array.isArray(v)) return [];
  const out: FlowPath[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') continue;
    const obj = p as Record<string, unknown>;
    const from = typeof obj.from === 'string' ? obj.from.trim().toLowerCase() : '';
    const to = typeof obj.to === 'string' ? obj.to.trim().toLowerCase() : '';
    if (!from || !to) continue;
    out.push({ from, to });
  }
  return out;
}

// ─── Cross-check logic ───────────────────────────────────────────────────────

export function computeCrossCheckFlags(args: {
  extractedBedrooms: number | null;
  extractedBathrooms: number | null;
  crmBedrooms: number | null;
  crmBathrooms: number | null;
}): string[] {
  const flags: string[] = [];

  // Bedrooms
  if (args.extractedBedrooms === null) {
    // No extracted value → no flag (caller will treat as low-quality extract)
  } else if (args.crmBedrooms === null) {
    flags.push('no_crm_bedrooms_to_check');
  } else if (args.extractedBedrooms !== args.crmBedrooms) {
    flags.push(`bedrooms_mismatch_${args.extractedBedrooms}_vs_${args.crmBedrooms}`);
  }

  // Bathrooms
  if (args.extractedBathrooms === null) {
    // No extracted value → no flag
  } else if (args.crmBathrooms === null) {
    flags.push('no_crm_bathrooms_to_check');
  } else if (args.extractedBathrooms !== args.crmBathrooms) {
    flags.push(`bathrooms_mismatch_${args.extractedBathrooms}_vs_${args.crmBathrooms}`);
  }

  return flags;
}

// ─── URL hash (idempotency key) ──────────────────────────────────────────────

export async function computeUrlHash(url: string): Promise<string> {
  const enc = new TextEncoder().encode(url);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}

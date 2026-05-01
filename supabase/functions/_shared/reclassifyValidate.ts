/**
 * reclassifyValidate.ts — Wave 11.6.9 pure validation + normalisation helper
 * for the shortlisting-overrides "reclassify" action.
 *
 * Spec: docs/design-specs/W11-5-human-reclassification-capture.md
 *
 * The reclassify action lets operators correct Stage 1 / Stage 4 per-image
 * judgements (room_type, composition_type, vantage_point, combined_score, slot
 * eligibility) from inside the swimlane card's "Why?" expander. Each correction
 * lands as a row in `composition_classification_overrides` and feeds the
 * projectMemoryBlock on subsequent Stage 1 runs for the same project, closing
 * the loop on engine learning.
 *
 * This helper is pure (no DB, no Supabase clients, no env access) so the
 * validation branches can be tested without spinning up Supabase. The
 * shortlisting-overrides edge fn (index.ts) wires this to the DB upsert +
 * project-access guard + audit-event emission.
 *
 * ─── INPUT CONTRACT ──────────────────────────────────────────────────────────
 *
 *   POST /shortlisting-overrides
 *   body: { reclassify: {
 *     group_id: UUID,
 *     round_id: UUID,
 *     override_source?: 'stage1_correction' (default) | 'stage4_visual_override' | 'master_admin_correction',
 *     // At least ONE of the human_* fields must be present:
 *     human_room_type?: string,
 *     human_composition_type?: string,
 *     human_vantage_point?: 'interior_looking_out' | 'exterior_looking_in' | 'neutral',
 *     human_combined_score?: number (0-10),
 *     human_eligible_slot_ids?: string[] (multi-slot eligibility override),
 *     // Optional context:
 *     ai_room_type?: string,
 *     ai_composition_type?: string,
 *     ai_vantage_point?: string,
 *     ai_combined_score?: number,
 *     override_reason?: string (≤ 2000 chars; optional per W11.6.9 task spec —
 *                              an empty corrective note is fine, the field
 *                              changed value already encodes the signal),
 *   } }
 *
 * Note that this differs from `composition-override` (the original W11.5
 * backend) in two ways:
 *   1. Multi-field per row — operator can correct room_type AND vantage_point
 *      in one save (the existing fn requires one field per request).
 *   2. `override_reason` is OPTIONAL (the existing fn requires ≥ 5 chars).
 *      W11.6.9 task spec calls for inline-edit pencils with no required note.
 *
 * Both fns share the same target table + (group, round, source) UPSERT keying,
 * so they coexist cleanly. `composition-override` remains the single-field
 * dropdown API; `shortlisting-overrides.reclassify` is the multi-field swimlane
 * API.
 */

// ─── Canonical enums (mirrored from _shared/visionPrompts/blocks/...) ────────
//
// Kept inline rather than imported from the prompt-block files to:
//   (a) preserve the helper's purity (no transitive imports of prompt-assembly
//       code into a validator),
//   (b) avoid build-time coupling between the override API and prompt blocks,
//   (c) make the validator self-documenting at a glance.
//
// Cross-check on schema drift: every value here MUST exist in the corresponding
// prompt-block taxonomy. If a new room_type is added to roomTypeTaxonomy.ts,
// add it here too. The accompanying tests assert the canonical sets line up.

export const CANONICAL_ROOM_TYPES = new Set<string>([
  'interior_open_plan', 'kitchen_main', 'kitchen_scullery', 'living_room',
  'living_secondary', 'dining_room', 'master_bedroom', 'bedroom_secondary',
  'ensuite_primary', 'ensuite_secondary', 'bathroom', 'wir_wardrobe',
  'study_office', 'laundry', 'entry_foyer', 'staircase', 'hallway_corridor',
  'home_cinema', 'games_room', 'gymnasium', 'wine_cellar', 'garage_showcase',
  'garage_standard', 'alfresco', 'pool_area', 'outdoor_kitchen',
  'courtyard_internal', 'balcony_terrace', 'exterior_front', 'exterior_rear',
  'exterior_side', 'exterior_detail', 'drone_contextual', 'drone_nadir',
  'drone_oblique', 'floorplan', 'detail_material', 'detail_lighting',
  'lifestyle_vehicle', 'special_feature',
]);

export const CANONICAL_COMPOSITION_TYPES = new Set<string>([
  'hero_wide', 'corner_two_point', 'detail_closeup', 'corridor_leading',
  'straight_on', 'overhead', 'upward_void', 'threshold_transition',
  'drone_nadir', 'drone_oblique_contextual', 'architectural_abstract',
]);

export const CANONICAL_VANTAGE_POINTS = new Set<string>([
  'interior_looking_out', 'exterior_looking_in', 'neutral',
]);

// Per W11.7.1 hygiene — Stage 4 emits free-form slot_id strings; the persist
// layer normalises via the alias map. We accept either canonical or aliasable
// here; downstream (projectMemoryBlock + Stage 4) handles normalisation. We
// just enforce non-empty strings + reasonable length so a malicious payload
// can't write 10MB into the array.
const SLOT_ID_MAX_LEN = 64;
const SLOT_ID_REGEX = /^[a-z][a-z0-9_]{0,63}$/; // lowercase snake_case

const VALID_OVERRIDE_SOURCES = new Set<string>([
  'stage1_correction', 'stage4_visual_override', 'master_admin_correction',
]);

const REASON_MAX_CHARS = 2000;
const SCORE_MIN = 0;
const SCORE_MAX = 10;
const SLOT_IDS_MAX_COUNT = 10; // sane upper bound — no slot needs >10 eligibility tags

export interface ReclassifyInput {
  group_id?: unknown;
  round_id?: unknown;
  override_source?: unknown;
  ai_room_type?: unknown;
  ai_composition_type?: unknown;
  ai_vantage_point?: unknown;
  ai_combined_score?: unknown;
  human_room_type?: unknown;
  human_composition_type?: unknown;
  human_vantage_point?: unknown;
  human_combined_score?: unknown;
  human_eligible_slot_ids?: unknown;
  override_reason?: unknown;
}

export type ReclassifyValidationResult =
  | {
      ok: true;
      group_id: string;
      round_id: string;
      override_source: 'stage1_correction' | 'stage4_visual_override' | 'master_admin_correction';
      ai_room_type: string | null;
      ai_composition_type: string | null;
      ai_vantage_point: string | null;
      ai_combined_score: number | null;
      human_room_type: string | null;
      human_composition_type: string | null;
      human_vantage_point: string | null;
      human_combined_score: number | null;
      human_eligible_slot_ids: string[] | null;
      override_reason: string | null;
      // Convenience: list of fields the operator actually corrected, used by
      // the audit-event payload so the W11.6 dashboard can group corrections
      // by field without reparsing the human_* columns.
      changed_fields: string[];
    }
  | {
      ok: false;
      error_code:
        | 'RECLASSIFY_NOT_OBJECT'
        | 'RECLASSIFY_GROUP_ID_REQUIRED'
        | 'RECLASSIFY_ROUND_ID_REQUIRED'
        | 'RECLASSIFY_OVERRIDE_SOURCE_INVALID'
        | 'RECLASSIFY_NO_FIELDS_TO_CHANGE'
        | 'RECLASSIFY_ROOM_TYPE_INVALID'
        | 'RECLASSIFY_COMPOSITION_TYPE_INVALID'
        | 'RECLASSIFY_VANTAGE_POINT_INVALID'
        | 'RECLASSIFY_SCORE_INVALID'
        | 'RECLASSIFY_SLOT_IDS_INVALID'
        | 'RECLASSIFY_REASON_TOO_LONG'
        | 'RECLASSIFY_AI_FIELD_INVALID';
      message: string;
    };

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asTrimmedNonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function asNumberInRange(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/**
 * Validate + normalise a reclassify body.
 *
 * Returns either a fully-typed validated payload (caller can hand directly to
 * the DB upsert) or a structured error with a stable error_code that the UI
 * can map to a user-friendly toast.
 */
export function validateReclassify(body: unknown): ReclassifyValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_NOT_OBJECT',
      message: 'reclassify must be a non-array object',
    };
  }
  const r = body as ReclassifyInput;

  // ── group_id / round_id ────────────────────────────────────────────────────
  const group_id = asString(r.group_id);
  if (!group_id || group_id.length === 0) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_GROUP_ID_REQUIRED',
      message: 'reclassify.group_id required (string UUID)',
    };
  }
  const round_id = asString(r.round_id);
  if (!round_id || round_id.length === 0) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_ROUND_ID_REQUIRED',
      message: 'reclassify.round_id required (string UUID)',
    };
  }

  // ── override_source ────────────────────────────────────────────────────────
  // Default 'stage1_correction' per W11.5 spec §"Section 4". Validate the
  // closed set even when defaulted (no dynamic dispatch); RLS guard for
  // master_admin_correction lives in the edge fn — this validator just
  // enforces the literal-set membership.
  const override_source_raw = r.override_source ?? 'stage1_correction';
  if (typeof override_source_raw !== 'string'
    || !VALID_OVERRIDE_SOURCES.has(override_source_raw)) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_OVERRIDE_SOURCE_INVALID',
      message: `reclassify.override_source must be one of: ${[...VALID_OVERRIDE_SOURCES].join(', ')}`,
    };
  }
  const override_source = override_source_raw as
    | 'stage1_correction'
    | 'stage4_visual_override'
    | 'master_admin_correction';

  // ── human_* fields (each optional; at least ONE required) ──────────────────
  const changed_fields: string[] = [];

  // human_room_type
  let human_room_type: string | null = null;
  if (r.human_room_type !== undefined && r.human_room_type !== null) {
    const v = asTrimmedNonEmpty(r.human_room_type);
    if (!v || !CANONICAL_ROOM_TYPES.has(v)) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_ROOM_TYPE_INVALID',
        message: 'reclassify.human_room_type must be a canonical room_type value',
      };
    }
    human_room_type = v;
    changed_fields.push('room_type');
  }

  // human_composition_type
  let human_composition_type: string | null = null;
  if (r.human_composition_type !== undefined && r.human_composition_type !== null) {
    const v = asTrimmedNonEmpty(r.human_composition_type);
    if (!v || !CANONICAL_COMPOSITION_TYPES.has(v)) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_COMPOSITION_TYPE_INVALID',
        message: 'reclassify.human_composition_type must be a canonical composition_type value',
      };
    }
    human_composition_type = v;
    changed_fields.push('composition_type');
  }

  // human_vantage_point
  let human_vantage_point: string | null = null;
  if (r.human_vantage_point !== undefined && r.human_vantage_point !== null) {
    const v = asTrimmedNonEmpty(r.human_vantage_point);
    if (!v || !CANONICAL_VANTAGE_POINTS.has(v)) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_VANTAGE_POINT_INVALID',
        message: `reclassify.human_vantage_point must be one of: ${[...CANONICAL_VANTAGE_POINTS].join(', ')}`,
      };
    }
    human_vantage_point = v;
    changed_fields.push('vantage_point');
  }

  // human_combined_score
  let human_combined_score: number | null = null;
  if (r.human_combined_score !== undefined && r.human_combined_score !== null) {
    const v = asNumberInRange(r.human_combined_score, SCORE_MIN, SCORE_MAX);
    if (v === null) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_SCORE_INVALID',
        message: `reclassify.human_combined_score must be a number in [${SCORE_MIN}, ${SCORE_MAX}]`,
      };
    }
    // Round to 0.5 step per task spec ("number 0-10 with .5 step"). The DB
    // column is NUMERIC(4,2) so we could persist any decimal; we snap here
    // for UI consistency. Editors who want finer-grained scores can use the
    // composition-override fn directly.
    human_combined_score = Math.round(v * 2) / 2;
    changed_fields.push('combined_score');
  }

  // human_eligible_slot_ids
  let human_eligible_slot_ids: string[] | null = null;
  if (r.human_eligible_slot_ids !== undefined && r.human_eligible_slot_ids !== null) {
    if (!Array.isArray(r.human_eligible_slot_ids)) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_SLOT_IDS_INVALID',
        message: 'reclassify.human_eligible_slot_ids must be an array of slot_id strings',
      };
    }
    if (r.human_eligible_slot_ids.length > SLOT_IDS_MAX_COUNT) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_SLOT_IDS_INVALID',
        message: `reclassify.human_eligible_slot_ids supports at most ${SLOT_IDS_MAX_COUNT} entries`,
      };
    }
    const cleaned: string[] = [];
    for (const raw of r.human_eligible_slot_ids) {
      if (typeof raw !== 'string') {
        return {
          ok: false,
          error_code: 'RECLASSIFY_SLOT_IDS_INVALID',
          message: 'reclassify.human_eligible_slot_ids entries must be strings',
        };
      }
      const t = raw.trim().toLowerCase();
      if (t.length === 0) continue; // drop empties
      if (t.length > SLOT_ID_MAX_LEN || !SLOT_ID_REGEX.test(t)) {
        return {
          ok: false,
          error_code: 'RECLASSIFY_SLOT_IDS_INVALID',
          message: `reclassify.human_eligible_slot_ids entries must be lowercase snake_case ≤${SLOT_ID_MAX_LEN} chars`,
        };
      }
      // Dedupe — operator may have selected the same slot twice through
      // multi-select UI bugs. Cheap O(N²) since the cap is 10.
      if (!cleaned.includes(t)) cleaned.push(t);
    }
    // Empty array == "no slot eligibility override" rather than "explicitly
    // make this group eligible for nothing" — that's a destructive operation
    // we don't want operators triggering by accident. Skip the change in that
    // case; the caller can pass `null` to clear an existing override (handled
    // elsewhere).
    if (cleaned.length === 0) {
      human_eligible_slot_ids = null;
    } else {
      human_eligible_slot_ids = cleaned;
      changed_fields.push('eligible_slot_ids');
    }
  }

  // At least one field must be changing.
  if (changed_fields.length === 0) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_NO_FIELDS_TO_CHANGE',
      message: 'reclassify must include at least one human_* field to change',
    };
  }

  // ── ai_* fields (optional baseline; preserved for replay/audit) ────────────
  const ai_room_type = asTrimmedNonEmpty(r.ai_room_type);
  if (r.ai_room_type !== undefined && r.ai_room_type !== null
      && (typeof r.ai_room_type !== 'string')) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_AI_FIELD_INVALID',
      message: 'reclassify.ai_room_type must be a string when provided',
    };
  }
  const ai_composition_type = asTrimmedNonEmpty(r.ai_composition_type);
  if (r.ai_composition_type !== undefined && r.ai_composition_type !== null
      && (typeof r.ai_composition_type !== 'string')) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_AI_FIELD_INVALID',
      message: 'reclassify.ai_composition_type must be a string when provided',
    };
  }
  const ai_vantage_point = asTrimmedNonEmpty(r.ai_vantage_point);
  if (r.ai_vantage_point !== undefined && r.ai_vantage_point !== null
      && (typeof r.ai_vantage_point !== 'string')) {
    return {
      ok: false,
      error_code: 'RECLASSIFY_AI_FIELD_INVALID',
      message: 'reclassify.ai_vantage_point must be a string when provided',
    };
  }

  let ai_combined_score: number | null = null;
  if (r.ai_combined_score !== undefined && r.ai_combined_score !== null) {
    const v = asNumberInRange(r.ai_combined_score, SCORE_MIN, SCORE_MAX);
    if (v === null) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_AI_FIELD_INVALID',
        message: `reclassify.ai_combined_score must be a number in [${SCORE_MIN}, ${SCORE_MAX}]`,
      };
    }
    ai_combined_score = v;
  }

  // ── override_reason (optional per W11.6.9 task spec) ───────────────────────
  let override_reason: string | null = null;
  if (r.override_reason !== undefined && r.override_reason !== null) {
    if (typeof r.override_reason !== 'string') {
      return {
        ok: false,
        error_code: 'RECLASSIFY_REASON_TOO_LONG',
        message: 'reclassify.override_reason must be a string when provided',
      };
    }
    const trimmed = r.override_reason.trim();
    if (trimmed.length > REASON_MAX_CHARS) {
      return {
        ok: false,
        error_code: 'RECLASSIFY_REASON_TOO_LONG',
        message: `reclassify.override_reason must be ≤${REASON_MAX_CHARS} chars`,
      };
    }
    // Empty-after-trim → null (consistent with overrideAnnotate's NULL-vs-""
    // collapse). The field stays NULL in the DB which means "no reason given".
    override_reason = trimmed.length === 0 ? null : trimmed;
  }

  return {
    ok: true,
    group_id,
    round_id,
    override_source,
    ai_room_type,
    ai_composition_type,
    ai_vantage_point,
    ai_combined_score,
    human_room_type,
    human_composition_type,
    human_vantage_point,
    human_combined_score,
    human_eligible_slot_ids,
    override_reason,
    changed_fields,
  };
}

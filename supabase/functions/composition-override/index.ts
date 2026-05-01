/**
 * composition-override
 * ────────────────────
 * Wave 11.5 backend — operator reclassification capture API.
 *
 * Spec: docs/design-specs/W11-5-human-reclassification-capture.md
 *
 * This is the BACKEND for the operator reclassification UI (Agent 4 builds the
 * frontend). The frontend invokes this fn whenever an operator corrects a
 * Stage 1 mislabel from the swimlane card menu (e.g. "this is exterior_rear,
 * not exterior_front; clearly Hills Hoist visible"). The override row lands
 * in `composition_classification_overrides` and feeds the projectMemoryBlock
 * on the next Stage 1 run for the same project.
 *
 * Closed-loop wiring (W11.7 §"Project memory + canonical registry hooks"):
 *
 *   operator override here
 *     ─→ composition_classification_overrides row (override_source='stage1_correction')
 *     ─→ projectMemoryBlock loads it on the next round of the same project
 *     ─→ Stage 1 prompt sees authoritative prior correction
 *     ─→ engine grows
 *
 * Cross-project graduation to engine_fewshot_examples is master_admin-only
 * and lives in approve-stage4-override (NOT this fn). Raw operator overrides
 * here stay project-scoped until master_admin curates them.
 *
 * ─── INPUT ────────────────────────────────────────────────────────────────────
 *
 *   POST {
 *     round_id: UUID,
 *     group_id: UUID,
 *     field: 'room_type' | 'composition_type' | 'vantage_point' | 'combined_score',
 *     ai_value: string | number,        // what the engine emitted
 *     human_value: string | number,     // what the operator wants instead
 *     reason: string,                    // free-text explanation (≥ 5 chars)
 *     evidence_keywords?: string[]       // optional: ['hills_hoist', 'hot_water_system']
 *                                         // not currently persisted but accepted
 *                                         // forward-compat for W12 canonical rollup
 *   }
 *
 *   POST { _health_check: true } → 200 with version stamp.
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────────
 *
 * master_admin / admin / manager / service_role. Matches the W11.5 spec
 * §"Section 4 — Edge fn `reclassify-composition`" auth contract.
 *
 * ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 *
 * Composite uniqueness on (group_id, round_id, override_source) is enforced
 * by mig 373 (`composition_classification_overrides_grp_rnd_src_uniq`). When
 * the same operator (or a different operator) re-overrides the same field on
 * the same group in the same round, we UPDATE the existing row rather than
 * INSERT a duplicate. The actor_user_id and actor_at fields move to the
 * latest editor.
 *
 * ─── RESPONSE ─────────────────────────────────────────────────────────────────
 *
 *   200 { ok: true, override: <row>, action: 'inserted' | 'updated' }
 *   400 invalid input (missing field, invalid field name, etc.)
 *   401 not authenticated
 *   403 not authorised (wrong role / no access to project)
 *   500 DB error
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  callerHasProjectAccess,
} from '../_shared/supabase.ts';

const GENERATOR = 'composition-override';

const VALID_FIELDS = new Set([
  'room_type',
  'composition_type',
  'vantage_point',
  'combined_score',
]);

const VALID_VANTAGE_POINTS = new Set([
  'interior_looking_out',
  'exterior_looking_in',
  'neutral',
]);

const REASON_MIN_CHARS = 5;
const REASON_MAX_CHARS = 2000;

interface OverrideRequest {
  round_id?: string;
  group_id?: string;
  field?: string;
  ai_value?: string | number | null;
  human_value?: string | number | null;
  reason?: string;
  evidence_keywords?: string[];
  override_source?: 'stage1_correction' | 'stage4_visual_override' | 'master_admin_correction';
  /**
   * Optional override of the actor recorded on the row. Only respected for
   * service_role callers — non-service callers always use their own user.id.
   * Used by approve-stage4-override and other server-side consumers that
   * cross-write through this fn but want to attribute the action to a real
   * operator (e.g. an automation triggered by master_admin in the UI).
   */
  acting_user_id?: string;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ── Auth ─────────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden — only master_admin/admin/manager can record overrides', 403, req);
    }
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let body: OverrideRequest = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const validation = validateOverrideRequest(body);
  if (!validation.ok) {
    return errorResponse(validation.message, 400, req);
  }
  const {
    round_id, group_id, field,
    aiValueStr, humanValueStr,
    aiScoreNum, humanScoreNum,
    reason, override_source,
  } = validation;

  const admin = getAdminClient();

  // ── Round + project resolution (for project-access guard) ────────────────
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id')
    .eq('id', round_id)
    .maybeSingle();
  if (roundErr) {
    return errorResponse(`round lookup failed: ${roundErr.message}`, 500, req);
  }
  if (!round) {
    return errorResponse(`round ${round_id} not found`, 404, req);
  }
  const projectId = round.project_id as string;

  // Project-access guard for non-service callers (matches the pattern in
  // shortlisting-shape-d). Service role bypasses (used by approve-stage4-override
  // when it cross-writes through this fn's logic).
  if (!isService) {
    const allowed = await callerHasProjectAccess(user!, projectId);
    if (!allowed) {
      return errorResponse(`Forbidden — caller has no access to project ${projectId}`, 403, req);
    }
  }

  // ── Confirm the group_id belongs to the round (cheap consistency check) ──
  const { data: group, error: groupErr } = await admin
    .from('composition_groups')
    .select('id, round_id')
    .eq('id', group_id)
    .maybeSingle();
  if (groupErr) {
    return errorResponse(`group lookup failed: ${groupErr.message}`, 500, req);
  }
  if (!group) {
    return errorResponse(`group ${group_id} not found`, 404, req);
  }
  if (group.round_id !== round_id) {
    return errorResponse(
      `group ${group_id} is not part of round ${round_id} (it belongs to ${group.round_id})`,
      400,
      req,
    );
  }

  // ── Read existing override (idempotency) ─────────────────────────────────
  // Composite key: (group_id, round_id, override_source). One row per stage
  // per group per round.
  const { data: existing, error: existingErr } = await admin
    .from('composition_classification_overrides')
    .select('*')
    .eq('group_id', group_id)
    .eq('round_id', round_id)
    .eq('override_source', override_source)
    .maybeSingle();
  if (existingErr) {
    return errorResponse(`existing-override lookup failed: ${existingErr.message}`, 500, req);
  }

  // ── Resolve actor_user_id ────────────────────────────────────────────────
  // The CHECK constraint composition_classification_overrides_actor_required_chk
  // requires actor_user_id IS NOT NULL for override_source IN
  // ('stage1_correction', 'master_admin_correction') — only stage4_visual_override
  // can be NULL (because Stage 4 override rows are emitted by the engine, not
  // operators). For non-service callers we use user.id directly. For service
  // callers, the request must supply acting_user_id (typically the human
  // operator who triggered the automation that's calling us).
  let actorUserId: string | null;
  if (!isService) {
    actorUserId = user!.id;
  } else if (typeof body.acting_user_id === 'string' && body.acting_user_id.length > 0) {
    actorUserId = body.acting_user_id;
  } else {
    actorUserId = null;
  }
  if (actorUserId === null && override_source !== 'stage4_visual_override') {
    return errorResponse(
      `actor_user_id required for override_source='${override_source}'. ` +
      `Service-role callers must supply 'acting_user_id' field; non-service ` +
      `callers are auto-attributed to their auth.user.id.`,
      400,
      req,
    );
  }

  // ── Build the row ────────────────────────────────────────────────────────
  // Per W11.5 schema: ai_* + human_* fields per correctable column. We only
  // populate the ai_/human_ pair the operator actually corrected; the rest
  // stay NULL ("accept AI").
  //
  // master_admin reclassifications get human_combined_score_authoritative=TRUE
  // per W11.5 Q2 recommendation (only when override_source='master_admin_correction'
  // OR the actor's role is master_admin AND the field is combined_score).
  const isMasterAdminOverride = !isService && user?.role === 'master_admin';
  const scoreAuthoritative = field === 'combined_score'
    && (override_source === 'master_admin_correction' || isMasterAdminOverride);

  const row: Record<string, unknown> = {
    group_id,
    round_id,
    override_source,
    override_reason: reason,
    actor_user_id: actorUserId,
    actor_at: new Date().toISOString(),
  };
  switch (field) {
    case 'room_type':
      row.ai_room_type = aiValueStr;
      row.human_room_type = humanValueStr;
      break;
    case 'composition_type':
      row.ai_composition_type = aiValueStr;
      row.human_composition_type = humanValueStr;
      break;
    case 'vantage_point':
      row.ai_vantage_point = aiValueStr;
      row.human_vantage_point = humanValueStr;
      break;
    case 'combined_score':
      row.ai_combined_score = aiScoreNum;
      row.human_combined_score = humanScoreNum;
      row.human_combined_score_authoritative = scoreAuthoritative;
      break;
  }

  // ── INSERT or UPDATE ─────────────────────────────────────────────────────
  if (existing) {
    // UPDATE: don't overwrite fields the new request didn't touch (e.g. an
    // earlier override set human_room_type, this one sets human_composition_type).
    // We accumulate all human_* fields per (group, round, source) row.
    const updateRow: Record<string, unknown> = {
      override_reason: reason,
      actor_user_id: row.actor_user_id,
      actor_at: row.actor_at,
    };
    // Replay only the field-specific updates from `row`:
    for (const k of Object.keys(row)) {
      if (k.startsWith('ai_') || k.startsWith('human_')) {
        updateRow[k] = row[k];
      }
    }
    const { data: updated, error: updateErr } = await admin
      .from('composition_classification_overrides')
      .update(updateRow)
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();
    if (updateErr) {
      return errorResponse(`override update failed: ${updateErr.message}`, 500, req);
    }
    return jsonResponse({ ok: true, override: updated, action: 'updated' }, 200, req);
  }

  // INSERT
  const { data: inserted, error: insertErr } = await admin
    .from('composition_classification_overrides')
    .insert(row)
    .select('*')
    .maybeSingle();
  if (insertErr) {
    return errorResponse(`override insert failed: ${insertErr.message}`, 500, req);
  }

  // Emit a shortlisting_events row for audit trail / W11.6 dashboard. Soft
  // failure: we don't block the override on event-insert error.
  const { error: evErr } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: projectId,
      round_id,
      event_type: 'human_reclassification',
      // actor_type reflects the call origin (service vs human session).
      // actor_user_id is the resolved actor (matches the row's actor_user_id).
      actor_type: isService ? 'system' : 'human',
      actor_user_id: actorUserId,
      payload: {
        override_id: inserted?.id,
        group_id,
        field,
        ai_value: field === 'combined_score' ? aiScoreNum : aiValueStr,
        human_value: field === 'combined_score' ? humanScoreNum : humanValueStr,
        reason,
        evidence_keywords: body.evidence_keywords ?? [],
        override_source,
      },
    });
  if (evErr) {
    console.warn(`[${GENERATOR}] event insert failed (non-fatal): ${evErr.message}`);
  }

  return jsonResponse({ ok: true, override: inserted, action: 'inserted' }, 200, req);
});

// ─── Validation ──────────────────────────────────────────────────────────────

interface ValidationOk {
  ok: true;
  round_id: string;
  group_id: string;
  field: 'room_type' | 'composition_type' | 'vantage_point' | 'combined_score';
  override_source: 'stage1_correction' | 'stage4_visual_override' | 'master_admin_correction';
  // For string-valued fields (room_type / composition_type / vantage_point):
  aiValueStr: string | null;
  humanValueStr: string | null;
  // For numeric-valued fields (combined_score):
  aiScoreNum: number | null;
  humanScoreNum: number | null;
  reason: string;
}
interface ValidationErr { ok: false; message: string; }

function validateOverrideRequest(body: OverrideRequest): ValidationOk | ValidationErr {
  if (!body.round_id || typeof body.round_id !== 'string') {
    return { ok: false, message: 'round_id (UUID string) required' };
  }
  if (!body.group_id || typeof body.group_id !== 'string') {
    return { ok: false, message: 'group_id (UUID string) required' };
  }
  if (!body.field || !VALID_FIELDS.has(body.field)) {
    return {
      ok: false,
      message: `field required, one of: ${[...VALID_FIELDS].join(', ')}`,
    };
  }
  if (typeof body.reason !== 'string') {
    return { ok: false, message: 'reason (string) required' };
  }
  const reason = body.reason.trim();
  if (reason.length < REASON_MIN_CHARS || reason.length > REASON_MAX_CHARS) {
    return {
      ok: false,
      message: `reason must be ${REASON_MIN_CHARS}-${REASON_MAX_CHARS} chars (got ${reason.length})`,
    };
  }

  // override_source: default 'stage1_correction'.
  const override_source = body.override_source ?? 'stage1_correction';
  if (!['stage1_correction', 'stage4_visual_override', 'master_admin_correction']
    .includes(override_source)) {
    return {
      ok: false,
      message: `override_source must be one of: stage1_correction | stage4_visual_override | master_admin_correction`,
    };
  }

  const field = body.field as ValidationOk['field'];

  // Field-specific value validation.
  let aiValueStr: string | null = null;
  let humanValueStr: string | null = null;
  let aiScoreNum: number | null = null;
  let humanScoreNum: number | null = null;

  if (field === 'combined_score') {
    const aiRaw = body.ai_value;
    const humanRaw = body.human_value;
    if (aiRaw == null || humanRaw == null) {
      return { ok: false, message: 'combined_score requires both ai_value and human_value' };
    }
    const aiN = typeof aiRaw === 'number' ? aiRaw : Number(aiRaw);
    const humanN = typeof humanRaw === 'number' ? humanRaw : Number(humanRaw);
    if (Number.isNaN(aiN) || Number.isNaN(humanN)) {
      return { ok: false, message: 'combined_score values must be numeric' };
    }
    if (aiN < 0 || aiN > 10 || humanN < 0 || humanN > 10) {
      return { ok: false, message: 'combined_score values must be in [0, 10]' };
    }
    aiScoreNum = aiN;
    humanScoreNum = humanN;
  } else {
    // Stringy fields. ai_value optional (engine may not have emitted; stage4
    // overrides may have null AI baseline). human_value required.
    if (typeof body.human_value !== 'string' || body.human_value.length === 0) {
      return { ok: false, message: `${field} requires non-empty human_value (string)` };
    }
    humanValueStr = body.human_value;
    aiValueStr = typeof body.ai_value === 'string' ? body.ai_value : null;

    if (field === 'vantage_point' && !VALID_VANTAGE_POINTS.has(humanValueStr)) {
      return {
        ok: false,
        message: `vantage_point human_value must be one of: ${[...VALID_VANTAGE_POINTS].join(', ')}`,
      };
    }
  }

  return {
    ok: true,
    round_id: body.round_id,
    group_id: body.group_id,
    field,
    override_source,
    aiValueStr,
    humanValueStr,
    aiScoreNum,
    humanScoreNum,
    reason,
  };
}

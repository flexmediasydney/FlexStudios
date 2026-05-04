/**
 * override-stage4-override
 * ────────────────────────
 * Mig 469 — Stage 4 override review queue: third terminal action.
 *
 * Sibling to `approve-stage4-override`. Used when neither Stage 1 nor Stage 4
 * was right and the operator types the correct value. Graduates the row into
 * engine_fewshot_examples with `human_value = override_value` (instead of
 * stage_4_value, as approve does).
 *
 * Sibling rather than a flag on approve to keep the audit trail clean —
 * `review_status='override'` is a distinct dashboard state from 'approved',
 * and `engine_run_audit` events emit a different event_type so we can
 * separate "Stage 4 trusted" from "human had to step in fully" in analytics.
 *
 * ─── INPUT ────────────────────────────────────────────────────────────────────
 *
 * POST {
 *   override_id: <shortlisting_stage4_overrides.id>,
 *   override_value: <string — operator's typed correct value>,
 *   review_notes?: <string>,
 *   property_tier?: 'premium' | 'standard' | 'approachable' | null,
 *   image_type?: 'interior' | 'exterior' | 'detail' | null,
 *   evidence_keywords?: string[]
 * }
 *
 * POST { _health_check: true } → 200 with version stamp.
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────────
 *
 * master_admin / service_role only. Cross-project pollution risk demands
 * single-role gating (same as approve).
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'override-stage4-override';

const VALID_TIERS = new Set(['premium', 'standard', 'approachable']);
const VALID_IMAGE_TYPES = new Set(['interior', 'exterior', 'detail']);

const STAGE4_FIELD_TO_EXAMPLE_KIND: Record<string, string> = {
  room_type: 'room_type_correction',
  composition_type: 'composition_correction',
  vantage: 'composition_correction',
  vantage_point: 'composition_correction',
  combined_score: 'reject_pattern',
};

interface OverrideRequest {
  override_id?: string;
  override_value?: string;
  review_notes?: string;
  property_tier?: string | null;
  image_type?: string | null;
  evidence_keywords?: string[];
  description?: string;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse(
        'Forbidden — only master_admin can override Stage 4 corrections (cross-project few-shot graduation)',
        403,
        req,
      );
    }
  }

  let body: OverrideRequest = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  if (!body.override_id || typeof body.override_id !== 'string') {
    return errorResponse('override_id (UUID string) required', 400, req);
  }
  const overrideValue = (body.override_value ?? '').trim();
  if (!overrideValue) {
    return errorResponse('override_value (non-empty string) required', 400, req);
  }
  if (overrideValue.length > 500) {
    return errorResponse('override_value too long (max 500 chars)', 400, req);
  }

  if (body.property_tier && !VALID_TIERS.has(body.property_tier)) {
    return errorResponse(
      `property_tier must be one of: ${[...VALID_TIERS].join(', ')} or omitted/null`,
      400,
      req,
    );
  }
  if (body.image_type && !VALID_IMAGE_TYPES.has(body.image_type)) {
    return errorResponse(
      `image_type must be one of: ${[...VALID_IMAGE_TYPES].join(', ')} or omitted/null`,
      400,
      req,
    );
  }

  const admin = getAdminClient();
  const stage4AuditId = body.override_id;

  // Load the source audit row.
  const { data: audit, error: auditErr } = await admin
    .from('shortlisting_stage4_overrides')
    .select('id, round_id, group_id, stem, field, stage_1_value, stage_4_value, reason, review_status')
    .eq('id', stage4AuditId)
    .maybeSingle();
  if (auditErr) {
    return errorResponse(`stage4 audit lookup failed: ${auditErr.message}`, 500, req);
  }
  if (!audit) {
    return errorResponse(`override ${stage4AuditId} not found`, 404, req);
  }
  if (audit.review_status === 'approved' || audit.review_status === 'override') {
    return errorResponse(
      `Stage 4 override ${stage4AuditId} already in terminal state '${audit.review_status}'`,
      409,
      req,
    );
  }

  const fieldKey = String(audit.field ?? '');
  const exampleKind = STAGE4_FIELD_TO_EXAMPLE_KIND[fieldKey] ?? null;
  const stage1Value = (audit.stage_1_value as string | null) ?? null;
  const canGraduate = exampleKind !== null && stage1Value !== null;

  const reviewerUid = isService ? null : user!.id;
  const reviewerIso = new Date().toISOString();

  const propertyTier = body.property_tier ?? null;
  const imageType = body.image_type ?? null;

  let action: 'inserted' | 'updated' | 'flipped_only' = 'flipped_only';
  let resultRow: Record<string, unknown> | null = null;
  let evidence: string[] = [];

  // ── Few-shot graduation ─────────────────────────────────────────────────
  // We teach the engine: "AI labelled <stage_1_value> → human says <override_value>".
  // Stage 1 is the upstream classifier; correcting Stage 1 directly is the
  // most useful lesson. Stage 4 reads the same library (mig 469) so it sees
  // these patterns too.
  if (canGraduate && exampleKind) {
    if (Array.isArray(body.evidence_keywords) && body.evidence_keywords.length > 0) {
      evidence = body.evidence_keywords.map(String).filter((s) => s.length > 0);
    } else if (audit.group_id) {
      const { data: classification } = await admin
        .from('composition_classifications')
        .select('key_elements')
        .eq('group_id', audit.group_id as string)
        .maybeSingle();
      const ke = classification?.key_elements;
      if (Array.isArray(ke)) {
        evidence = (ke as unknown[]).map(String).filter((s) => s.length > 0);
      }
    }

    const description = body.description?.trim() && body.description.trim().length > 0
      ? body.description.trim()
      : autoDescription({
          field: fieldKey,
          stage1: stage1Value,
          stage4: (audit.stage_4_value as string | null) ?? null,
          override: overrideValue,
          reason: (audit.reason as string | null) ?? null,
        });

    // Dedup on (kind, ai_value, human_value, tier, image_type).
    let dedupQuery = admin
      .from('engine_fewshot_examples')
      .select('id, observation_count')
      .eq('example_kind', exampleKind)
      .eq('ai_value', stage1Value)
      .eq('human_value', overrideValue);
    dedupQuery = propertyTier === null
      ? dedupQuery.is('property_tier', null)
      : dedupQuery.eq('property_tier', propertyTier);
    dedupQuery = imageType === null
      ? dedupQuery.is('image_type', null)
      : dedupQuery.eq('image_type', imageType);
    const { data: existing, error: dedupErr } = await dedupQuery.limit(1);
    if (dedupErr) {
      return errorResponse(`fewshot dedup lookup failed: ${dedupErr.message}`, 500, req);
    }

    if (existing && existing.length > 0) {
      const newCount = (typeof existing[0].observation_count === 'number'
        ? existing[0].observation_count
        : 0) + 1;
      const { data: updated, error: updErr } = await admin
        .from('engine_fewshot_examples')
        .update({
          observation_count: newCount,
          curated_by: reviewerUid,
          curated_at: reviewerIso,
          ...(body.evidence_keywords ? { evidence_keywords: evidence } : {}),
          ...(body.description ? { description } : {}),
        })
        .eq('id', existing[0].id as string)
        .select('*')
        .maybeSingle();
      if (updErr) {
        return errorResponse(`fewshot update failed: ${updErr.message}`, 500, req);
      }
      resultRow = updated as Record<string, unknown>;
      action = 'updated';
    } else {
      const { data: inserted, error: insErr } = await admin
        .from('engine_fewshot_examples')
        .insert({
          example_kind: exampleKind,
          property_tier: propertyTier,
          image_type: imageType,
          ai_value: stage1Value,
          human_value: overrideValue,
          evidence_keywords: evidence,
          description,
          in_active_prompt: true,
          observation_count: 1,
          source_session_id: audit.round_id,
          curated_by: reviewerUid,
          curated_at: reviewerIso,
        })
        .select('*')
        .maybeSingle();
      if (insErr) {
        return errorResponse(`fewshot insert failed: ${insErr.message}`, 500, req);
      }
      resultRow = inserted as Record<string, unknown>;
      action = 'inserted';
    }
  }

  // ── Flip the audit row to 'override' ───────────────────────────────────
  // SOURCE OF TRUTH for "did this commit?" — same hardening as approve fn.
  const { data: updatedRows, error: statusErr } = await admin
    .from('shortlisting_stage4_overrides')
    .update({
      review_status: 'override',
      override_value: overrideValue,
      reviewed_by: reviewerUid,
      reviewed_at: reviewerIso,
      review_notes: body.review_notes ?? null,
    })
    .eq('id', stage4AuditId)
    .select('id');
  if (statusErr) {
    return errorResponse(
      `Override write failed: ${statusErr.message}. ` +
        (resultRow?.id
          ? `A fewshot example was created (id=${resultRow.id}) but the audit ` +
            `row was not flipped — manual cleanup may be required.`
          : ''),
      500,
      req,
    );
  }
  if (!updatedRows || updatedRows.length === 0) {
    return errorResponse(
      `Override write affected 0 rows for override id=${stage4AuditId}. ` +
        `The row may have been deleted by a concurrent Stage 4 re-run, or ` +
        `RLS silently filtered the update.`,
      500,
      req,
    );
  }

  // ── Audit event ────────────────────────────────────────────────────────
  try {
    const { data: rd } = await admin
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', audit.round_id as string)
      .maybeSingle();
    if (rd?.project_id) {
      await admin.from('shortlisting_events').insert({
        project_id: rd.project_id,
        round_id: audit.round_id,
        event_type: 'stage4_override_overridden',
        actor_type: isService ? 'system' : 'human',
        actor_user_id: reviewerUid,
        payload: {
          stage4_audit_id: stage4AuditId,
          fewshot_id: resultRow?.id ?? null,
          example_kind: exampleKind,
          field: fieldKey,
          stage_1_value: stage1Value,
          stage_4_value: audit.stage_4_value ?? null,
          override_value: overrideValue,
          evidence_keywords: evidence,
          action,
          graduated_to_fewshot: canGraduate,
        },
      });
    }
  } catch (e) {
    console.warn(`[${GENERATOR}] event insert failed (non-fatal): ${e}`);
  }

  return jsonResponse(
    {
      ok: true,
      fewshot_example: resultRow,
      action,
      stage4_audit_id: stage4AuditId,
      override_value: overrideValue,
      graduated_to_fewshot: canGraduate,
    },
    200,
    req,
  );
});

function autoDescription(opts: {
  field: string;
  stage1: string | null;
  stage4: string | null;
  override: string;
  reason: string | null;
}): string {
  const base =
    `Operator override on field=${opts.field}: Stage 1=${opts.stage1 ?? '<none>'}, ` +
    `Stage 4=${opts.stage4 ?? '<none>'} → human typed "${opts.override}" ` +
    `(neither AI stage was correct).`;
  if (opts.reason && opts.reason.trim().length > 0) {
    const trimmed = opts.reason.trim();
    const capped = trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
    return `${base} Stage 4 reason: "${capped}"`;
  }
  return base;
}

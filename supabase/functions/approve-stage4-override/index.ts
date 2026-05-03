/**
 * approve-stage4-override
 * ───────────────────────
 * Wave 11.5 / W11.7 / W14 / W11.6.x — graduate an operator-approved Stage 4
 * visual cross-correction into the cross-project few-shot library AND mark
 * the source `shortlisting_stage4_overrides` audit row as approved so it
 * disappears from the in-context review lane.
 *
 * Spec: docs/design-specs/W11-5-human-reclassification-capture.md §"Section 6
 *       — Few-shot library for Stage 1 (Wave 14 hook)"
 *       docs/design-specs/W11-7-unified-shortlisting-architecture.md
 *       §"Few-shot library (W14)"
 *
 * ─── INPUT ────────────────────────────────────────────────────────────────────
 *
 * Two accepted shapes (W11.6.x — backwards compat):
 *
 *   A) NEW (preferred — the in-context lane):
 *      POST { override_id: <shortlisting_stage4_overrides.id>, ... }
 *
 *      The fn detects the row in `shortlisting_stage4_overrides`, locates the
 *      mirrored `composition_classification_overrides` row (matched by
 *      round_id + group_id + override_source='stage4_visual_override'), runs
 *      the graduation, and flips `review_status='approved'` on the source.
 *
 *   B) LEGACY (the old standalone /Stage4Overrides queue):
 *      POST { override_id: <composition_classification_overrides.id>, ... }
 *
 *      Pre-existing behaviour. The fn graduates the row directly. No status
 *      flip on `shortlisting_stage4_overrides` (the row may not even have an
 *      audit twin if the old queue surfaced it from before the dual-write).
 *
 * Optional fields apply to both shapes:
 *   example_kind?, property_tier?, image_type?, description?, evidence_keywords?
 *
 * POST { _health_check: true } → 200 with version stamp.
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────────
 *
 * master_admin / service_role ONLY. Cross-project pollution risk demands
 * single-role gating.
 *
 * ─── DUPLICATE HANDLING ───────────────────────────────────────────────────────
 *
 * If a similar few-shot example already exists (same example_kind + ai_value
 * + human_value + property_tier + image_type), we UPDATE its
 * `observation_count = observation_count + 1` and refresh `curated_at` /
 * `curated_by`.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'approve-stage4-override';

const VALID_EXAMPLE_KINDS = new Set([
  'room_type_correction',
  'composition_correction',
  'reject_pattern',
  'voice_exemplar',
]);
const VALID_TIERS = new Set(['premium', 'standard', 'approachable']);
const VALID_IMAGE_TYPES = new Set(['interior', 'exterior', 'detail']);

// W11.6.x — fields written into shortlisting_stage4_overrides.field that
// graduate cleanly into the few-shot library. The Stage 4 emitter uses
// `vantage` (not `vantage_point`); we normalise here so both names work.
const STAGE4_FIELD_TO_OVERRIDE_FIELD: Record<string, string> = {
  room_type: 'room_type',
  composition_type: 'composition_type',
  vantage: 'vantage_point',
  vantage_point: 'vantage_point',
  combined_score: 'combined_score',
};

interface ApprovalRequest {
  override_id?: string;
  example_kind?: string;
  property_tier?: string | null;
  image_type?: string | null;
  description?: string;
  evidence_keywords?: string[];
  review_notes?: string;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ── Auth: master_admin only ──────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse(
        'Forbidden — only master_admin can approve cross-project few-shot graduation',
        403,
        req,
      );
    }
  }

  let body: ApprovalRequest = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.1', _fn: GENERATOR }, 200, req);
  }

  if (!body.override_id || typeof body.override_id !== 'string') {
    return errorResponse('override_id (UUID string) required', 400, req);
  }

  // Optional filter fields:
  if (body.example_kind && !VALID_EXAMPLE_KINDS.has(body.example_kind)) {
    return errorResponse(
      `example_kind must be one of: ${[...VALID_EXAMPLE_KINDS].join(', ')}`,
      400,
      req,
    );
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

  // ── W11.6.x: detect input shape ──────────────────────────────────────────
  // The in-context lane (W11.6.x) sends shortlisting_stage4_overrides.id;
  // the legacy /Stage4Overrides page sends composition_classification_
  // overrides.id. We try the new shape first (more recent + Joseph's main
  // path) and fall back to the legacy direct lookup.
  const stage4AuditId = body.override_id;
  let stage4Audit: Record<string, unknown> | null = null;
  let override: Record<string, unknown> | null = null;
  let inputShape: 'stage4_audit' | 'legacy_override' = 'legacy_override';

  // Try shape A — shortlisting_stage4_overrides.id
  {
    const { data: row, error: stage4Err } = await admin
      .from('shortlisting_stage4_overrides')
      .select('id, round_id, group_id, stem, field, stage_1_value, stage_4_value, reason, review_status')
      .eq('id', stage4AuditId)
      .maybeSingle();
    if (stage4Err) {
      return errorResponse(`stage4_audit lookup failed: ${stage4Err.message}`, 500, req);
    }
    if (row) {
      stage4Audit = row;
      inputShape = 'stage4_audit';
    }
  }

  // Shape A path: locate the mirrored composition_classification_overrides row.
  if (inputShape === 'stage4_audit' && stage4Audit) {
    if (stage4Audit.review_status === 'approved') {
      return errorResponse(
        `Stage 4 override ${stage4AuditId} already approved`,
        409,
        req,
      );
    }
    const groupId = stage4Audit.group_id as string | null;
    const roundId = stage4Audit.round_id as string;
    if (groupId) {
      const { data: mirrorRow, error: mirrorErr } = await admin
        .from('composition_classification_overrides')
        .select('*')
        .eq('round_id', roundId)
        .eq('group_id', groupId)
        .eq('override_source', 'stage4_visual_override')
        .maybeSingle();
      if (mirrorErr) {
        return errorResponse(`mirror lookup failed: ${mirrorErr.message}`, 500, req);
      }
      override = mirrorRow ?? null;
    }
  }

  // Shape B path (or shape A fallback when no mirror exists): direct override
  // lookup. For shape A with no mirror, we synthesise a minimal pseudo-row
  // from the stage4 audit so graduation can still proceed (e.g. when the
  // Stage 4 emitter wrote an unsupported field like `vantage` that didn't
  // mirror).
  if (!override) {
    if (inputShape === 'legacy_override') {
      const { data: legacyRow, error: legacyErr } = await admin
        .from('composition_classification_overrides')
        .select('*')
        .eq('id', stage4AuditId)
        .maybeSingle();
      if (legacyErr) {
        return errorResponse(`override lookup failed: ${legacyErr.message}`, 500, req);
      }
      override = legacyRow ?? null;
    } else if (stage4Audit) {
      // Synthesise a pseudo-override row from the stage4 audit so the
      // existing graduation path works without a mirror. Only the fields
      // the picker reads are populated.
      const fieldKey = String(stage4Audit.field ?? '');
      const normalisedField = STAGE4_FIELD_TO_OVERRIDE_FIELD[fieldKey] ?? fieldKey;
      const stage1 = stage4Audit.stage_1_value as string | null;
      const stage4 = stage4Audit.stage_4_value as string | null;
      const pseudo: Record<string, unknown> = {
        id: null, // synthetic — no DB id
        round_id: stage4Audit.round_id,
        group_id: stage4Audit.group_id,
        override_reason: stage4Audit.reason,
        ai_room_type: null,
        human_room_type: null,
        ai_composition_type: null,
        human_composition_type: null,
        ai_vantage_point: null,
        human_vantage_point: null,
        ai_combined_score: null,
        human_combined_score: null,
      };
      if (normalisedField === 'room_type') {
        pseudo.ai_room_type = stage1;
        pseudo.human_room_type = stage4;
      } else if (normalisedField === 'composition_type') {
        pseudo.ai_composition_type = stage1;
        pseudo.human_composition_type = stage4;
      } else if (normalisedField === 'vantage_point') {
        pseudo.ai_vantage_point = stage1;
        pseudo.human_vantage_point = stage4;
      } else if (normalisedField === 'combined_score') {
        const aiScore = stage1 != null ? Number(stage1) : NaN;
        const humanScore = stage4 != null ? Number(stage4) : NaN;
        if (!Number.isNaN(aiScore)) pseudo.ai_combined_score = aiScore;
        if (!Number.isNaN(humanScore)) pseudo.human_combined_score = humanScore;
      }
      override = pseudo;
    }
  }

  if (!override) {
    return errorResponse(
      `override ${body.override_id} not found (tried shortlisting_stage4_overrides + composition_classification_overrides)`,
      404,
      req,
    );
  }

  // Determine the field that was overridden. Pick the first non-null human_*
  // field — same priority order as projectMemoryBlock for consistency.
  const fieldShape = pickOverriddenField(override);
  if (!fieldShape) {
    return errorResponse(
      'override row has no human_* field set — nothing to graduate',
      400,
      req,
    );
  }

  // Auto-derive example_kind if not supplied. Mapping:
  //   room_type → room_type_correction
  //   composition_type → composition_correction
  //   vantage_point → composition_correction (composition family)
  //   combined_score → reject_pattern (low-score corrections imply rejection signal)
  let exampleKind = body.example_kind;
  if (!exampleKind) {
    if (fieldShape.field === 'room_type') exampleKind = 'room_type_correction';
    else if (fieldShape.field === 'composition_type' || fieldShape.field === 'vantage_point') {
      exampleKind = 'composition_correction';
    } else if (fieldShape.field === 'combined_score') {
      exampleKind = 'reject_pattern';
    } else {
      exampleKind = 'room_type_correction';
    }
  }

  // ── Fetch evidence keywords from the round's key_elements ────────────────
  let evidence: string[] = [];
  if (Array.isArray(body.evidence_keywords) && body.evidence_keywords.length > 0) {
    evidence = body.evidence_keywords.map(String).filter((s) => s.length > 0);
  } else if (override.group_id) {
    const { data: classification } = await admin
      .from('composition_classifications')
      .select('key_elements')
      .eq('group_id', override.group_id as string)
      .maybeSingle();
    const ke = classification?.key_elements;
    if (Array.isArray(ke)) {
      evidence = (ke as unknown[]).map(String).filter((s) => s.length > 0);
    }
  }

  // ── Derive the description (auto-generated unless supplied) ──────────────
  const description = body.description?.trim() && body.description.trim().length > 0
    ? body.description.trim()
    : autoDescription({
        field: fieldShape.field,
        ai_value: fieldShape.ai_value,
        human_value: fieldShape.human_value,
        reason: (override.override_reason as string | null) ?? null,
      });

  // ── Look for an existing similar example (dedup) ─────────────────────────
  const propertyTier = body.property_tier ?? null;
  const imageType = body.image_type ?? null;

  let dedupQuery = admin
    .from('engine_fewshot_examples')
    .select('id, observation_count')
    .eq('example_kind', exampleKind)
    .eq('ai_value', fieldShape.ai_value)
    .eq('human_value', fieldShape.human_value);
  dedupQuery = propertyTier === null
    ? dedupQuery.is('property_tier', null)
    : dedupQuery.eq('property_tier', propertyTier);
  dedupQuery = imageType === null
    ? dedupQuery.is('image_type', null)
    : dedupQuery.eq('image_type', imageType);
  const { data: existingExamples, error: dedupErr } = await dedupQuery.limit(1);
  if (dedupErr) {
    return errorResponse(`fewshot dedup lookup failed: ${dedupErr.message}`, 500, req);
  }

  const approverUid = isService ? null : user!.id;
  const approverIso = new Date().toISOString();

  let action: 'inserted' | 'updated';
  let resultRow: Record<string, unknown> | null = null;

  if (existingExamples && existingExamples.length > 0) {
    const existing = existingExamples[0];
    const newCount = (typeof existing.observation_count === 'number' ? existing.observation_count : 0) + 1;
    const { data: updated, error: updateErr } = await admin
      .from('engine_fewshot_examples')
      .update({
        observation_count: newCount,
        curated_by: approverUid,
        curated_at: approverIso,
        ...(body.evidence_keywords ? { evidence_keywords: evidence } : {}),
        ...(body.description ? { description } : {}),
      })
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();
    if (updateErr) {
      return errorResponse(`fewshot update failed: ${updateErr.message}`, 500, req);
    }
    resultRow = updated as Record<string, unknown>;
    action = 'updated';
  } else {
    const insertRow: Record<string, unknown> = {
      example_kind: exampleKind,
      property_tier: propertyTier,
      image_type: imageType,
      ai_value: fieldShape.ai_value,
      human_value: fieldShape.human_value,
      evidence_keywords: evidence,
      description,
      in_active_prompt: true,
      observation_count: 1,
      source_session_id: override.round_id, // useful audit trail back to the round
      curated_by: approverUid,
      curated_at: approverIso,
    };
    const { data: inserted, error: insErr } = await admin
      .from('engine_fewshot_examples')
      .insert(insertRow)
      .select('*')
      .maybeSingle();
    if (insErr) {
      return errorResponse(`fewshot insert failed: ${insErr.message}`, 500, req);
    }
    resultRow = inserted as Record<string, unknown>;
    action = 'inserted';
  }

  // ── Mark the source override row's actor_at / actor_user_id ──────────────
  // Only when we have a real composition_classification_overrides row (shape
  // A with mirror, or shape B). Synthesised pseudo rows have id=null.
  if (override.id) {
    const { error: markErr } = await admin
      .from('composition_classification_overrides')
      .update({
        actor_user_id: approverUid ?? override.actor_user_id,
        actor_at: approverIso,
      })
      .eq('id', override.id as string);
    if (markErr) {
      console.warn(`[${GENERATOR}] override actor mark failed (non-fatal): ${markErr.message}`);
    }
  }

  // W11.6.x — Shape A: flip the source shortlisting_stage4_overrides row to
  // approved so the in-context lane filters it out. This is the bug Joseph
  // reported: previously the UI invoked approve-stage4-override with the
  // wrong id shape, so the row stayed pending forever. Now the audit row's
  // status mirrors the curation decision.
  //
  // 2026-05-03 (Rainbow QA hotfix) — this update is the SOURCE OF TRUTH for
  // "did this approval commit?". Previously the failure was treated as
  // non-fatal, which silently swallowed RLS rejections, transient lock
  // timeouts, and "row was deleted by a Stage 4 re-run" errors — the Edge
  // fn returned 200 OK to the UI, the optimistic cache removed the card,
  // then the next refetch fetched the still-pending row from DB and the
  // approval "reverted" hours later in the user's perception. Now we
  // (a) chain `.select('id')` so we can detect 0-rows-updated (RLS or
  // missing-row case), and (b) return 500 on any failure so the UI's
  // mutation onError fires, the cache rolls back cleanly, and the user
  // sees a real error toast instead of phantom revert.
  if (inputShape === 'stage4_audit' && stage4Audit) {
    const { data: updatedRows, error: statusErr } = await admin
      .from('shortlisting_stage4_overrides')
      .update({
        review_status: 'approved',
        reviewed_by: approverUid,
        reviewed_at: approverIso,
        review_notes: body.review_notes ?? null,
      })
      .eq('id', stage4AuditId)
      .select('id');
    if (statusErr) {
      console.error(
        `[${GENERATOR}] stage4_overrides review_status update failed for ` +
          `id=${stage4AuditId}: ${statusErr.message}`,
      );
      return errorResponse(
        `Approval write failed: ${statusErr.message}. ` +
          `A fewshot example was created at id=${resultRow?.id ?? 'unknown'} ` +
          `but the audit row was not flipped to approved — manual cleanup ` +
          `may be required.`,
        500,
        req,
      );
    }
    if (!updatedRows || updatedRows.length === 0) {
      // Most likely cause: the row was deleted by a concurrent Stage 4
      // re-run between our read at line ~165 and this update.  Less
      // likely: an RLS policy silently filtered the update.  Either
      // way the user's intent did NOT commit — surface as 500 so the
      // UI rolls back cleanly.
      console.error(
        `[${GENERATOR}] stage4_overrides UPDATE matched 0 rows for ` +
          `id=${stage4AuditId} — row may have been deleted by a Stage 4 ` +
          `re-run, or RLS silently filtered.`,
      );
      return errorResponse(
        `Approval write affected 0 rows for override id=${stage4AuditId}. ` +
          `The row may have been deleted by a concurrent Stage 4 re-run. ` +
          `A fewshot example was created (id=${resultRow?.id ?? 'unknown'}) ` +
          `but the audit row could not be flipped to approved.`,
        500,
        req,
      );
    }
  }

  // Emit a shortlisting_events row for audit. Use override.round_id +
  // (resolve project_id from override.round_id → shortlisting_rounds).
  try {
    const { data: rd } = await admin
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', override.round_id as string)
      .maybeSingle();
    if (rd?.project_id) {
      await admin
        .from('shortlisting_events')
        .insert({
          project_id: rd.project_id,
          round_id: override.round_id,
          event_type: 'fewshot_graduation',
          actor_type: isService ? 'system' : 'human',
          actor_user_id: approverUid,
          payload: {
            override_id: body.override_id,
            input_shape: inputShape,
            stage4_audit_id: inputShape === 'stage4_audit' ? stage4AuditId : null,
            mirror_id: override.id ?? null,
            fewshot_id: resultRow?.id,
            example_kind: exampleKind,
            ai_value: fieldShape.ai_value,
            human_value: fieldShape.human_value,
            evidence_keywords: evidence,
            action,
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
      input_shape: inputShape,
      source_override_id: body.override_id,
      stage4_audit_id: inputShape === 'stage4_audit' ? stage4AuditId : null,
    },
    200,
    req,
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FieldShape {
  field: 'room_type' | 'composition_type' | 'vantage_point' | 'combined_score';
  ai_value: string;
  human_value: string;
}

/**
 * Pick the first non-null human_* field on the override row. Priority matches
 * projectMemoryBlock for consistency: room_type > composition_type >
 * vantage_point > combined_score.
 */
function pickOverriddenField(row: Record<string, unknown>): FieldShape | null {
  if (row.human_room_type) {
    return {
      field: 'room_type',
      ai_value: (row.ai_room_type as string | null) ?? '<unknown>',
      human_value: row.human_room_type as string,
    };
  }
  if (row.human_composition_type) {
    return {
      field: 'composition_type',
      ai_value: (row.ai_composition_type as string | null) ?? '<unknown>',
      human_value: row.human_composition_type as string,
    };
  }
  if (row.human_vantage_point) {
    return {
      field: 'vantage_point',
      ai_value: (row.ai_vantage_point as string | null) ?? '<unknown>',
      human_value: row.human_vantage_point as string,
    };
  }
  if (row.human_combined_score != null) {
    return {
      field: 'combined_score',
      ai_value: row.ai_combined_score != null ? String(row.ai_combined_score) : '<unknown>',
      human_value: String(row.human_combined_score),
    };
  }
  return null;
}

/**
 * Auto-generate a description for the few-shot example when the approver
 * doesn't supply one.
 */
function autoDescription(opts: {
  field: string;
  ai_value: string;
  human_value: string;
  reason: string | null;
}): string {
  const verb = opts.field === 'combined_score' ? 'set to' : 'corrected to';
  const base = `Operator override on field=${opts.field}: AI=${opts.ai_value} → ${verb} ${opts.human_value}.`;
  if (opts.reason && opts.reason.trim().length > 0) {
    const trimmed = opts.reason.trim();
    const capped = trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
    return `${base} Operator reason: "${capped}"`;
  }
  return base;
}

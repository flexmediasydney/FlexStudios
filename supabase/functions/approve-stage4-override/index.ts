/**
 * approve-stage4-override
 * ───────────────────────
 * Wave 11.5 / W11.7 / W14 — graduate an operator-approved override into the
 * cross-project few-shot library.
 *
 * Spec: docs/design-specs/W11-5-human-reclassification-capture.md §"Section 6
 *       — Few-shot library for Stage 1 (Wave 14 hook)"
 *       docs/design-specs/W11-7-unified-shortlisting-architecture.md
 *       §"Few-shot library (W14)"
 *
 * This is the curation graduation hook: an operator's project-scoped override
 * (lives in `composition_classification_overrides`) becomes a cross-project
 * pattern (lives in `engine_fewshot_examples` with `in_active_prompt=TRUE`)
 * via master_admin approval.
 *
 * Closed-loop wiring (W11.7 §"Project memory + canonical registry hooks"):
 *
 *   project A operator override
 *     ─→ composition_classification_overrides row
 *     ─→ master_admin reviews via the W11.6 dashboard / W11.5 review queue
 *     ─→ master_admin invokes this fn with override_id
 *     ─→ engine_fewshot_examples row inserted (in_active_prompt=TRUE)
 *     ─→ projects B, C, D... see the pattern in fewShotLibraryBlock
 *
 * Why master_admin only:
 *   The few-shot library is the cross-project knowledge base. A wrong
 *   pattern there pollutes EVERY future shoot. Raw observation does not
 *   auto-graduate; only deliberate master_admin curation.
 *
 * ─── INPUT ────────────────────────────────────────────────────────────────────
 *
 *   POST {
 *     override_id: UUID,                          // composition_classification_overrides.id
 *     example_kind?: 'room_type_correction'       // optional override; auto-derived from
 *                  | 'composition_correction'     // the override row's first non-null
 *                  | 'reject_pattern',            // human_* field
 *     property_tier?: 'premium' | 'standard'      // optional; default NULL = applies all tiers
 *                  | 'approachable',
 *     image_type?: 'interior' | 'exterior'        // optional; default NULL = applies all types
 *                | 'detail',
 *     description?: string,                        // optional override; default auto-generated
 *     evidence_keywords?: string[]                 // optional override; default sourced from
 *                                                   // the round's key_elements
 *   }
 *
 *   POST { _health_check: true } → 200 with version stamp.
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────────
 *
 * master_admin / service_role ONLY. Cross-project pollution risk demands
 * single-role gating. (admin/manager can submit overrides via composition-
 * override; only master_admin promotes them to cross-project status.)
 *
 * ─── DUPLICATE HANDLING ───────────────────────────────────────────────────────
 *
 * If a similar few-shot example already exists (same example_kind + ai_value
 * + human_value + property_tier + image_type), we UPDATE its
 * `observation_count = observation_count + 1` and refresh `curated_at` /
 * `curated_by` to reflect the latest endorsement. Keeps the example library
 * dedup'd while strengthening empirical confidence per approval.
 *
 * ─── ALSO MARKS THE OVERRIDE ──────────────────────────────────────────────────
 *
 * The source override row gets its `actor_user_id` and `actor_at` updated to
 * the approving master_admin (per W11.5 schema — the actor field captures
 * the latest reviewer). This is harmless if the operator who originally
 * submitted is the same master_admin who approves; it captures the moment
 * of graduation.
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

interface ApprovalRequest {
  override_id?: string;
  example_kind?: string;
  property_tier?: string | null;
  image_type?: string | null;
  description?: string;
  evidence_keywords?: string[];
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
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
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

  // ── Load the source override row ─────────────────────────────────────────
  const { data: override, error: overrideErr } = await admin
    .from('composition_classification_overrides')
    .select('*')
    .eq('id', body.override_id)
    .maybeSingle();
  if (overrideErr) {
    return errorResponse(`override lookup failed: ${overrideErr.message}`, 500, req);
  }
  if (!override) {
    return errorResponse(`override ${body.override_id} not found`, 404, req);
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
  // Unless the caller supplied them explicitly, we derive them from the
  // composition_classifications.key_elements column for the same group.
  // This is a lightweight heuristic; W12 canonical rollup will refine it
  // further (mapping free-text key_elements → canonical_object_ids).
  let evidence: string[] = [];
  if (Array.isArray(body.evidence_keywords) && body.evidence_keywords.length > 0) {
    evidence = body.evidence_keywords.map(String).filter((s) => s.length > 0);
  } else {
    const { data: classification } = await admin
      .from('composition_classifications')
      .select('key_elements')
      .eq('group_id', override.group_id)
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
        reason: override.override_reason as string | null,
      });

  // ── Look for an existing similar example (dedup) ─────────────────────────
  // Same kind + ai_value + human_value + property_tier + image_type → bump
  // observation_count rather than insert a duplicate.
  const propertyTier = body.property_tier ?? null;
  const imageType = body.image_type ?? null;

  // Build the dedup query. Postgrest doesn't have a clean IS-NULL comparator
  // in chained eq calls so we use the .is() helper for null fields.
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
        // Refresh evidence + description with the latest snapshot when the
        // approver opted to override — leave existing values otherwise.
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
    // INSERT a new graduate row.
    const insertRow: Record<string, unknown> = {
      example_kind: exampleKind,
      property_tier: propertyTier,
      image_type: imageType,
      ai_value: fieldShape.ai_value,
      human_value: fieldShape.human_value,
      evidence_keywords: evidence,
      description,
      in_active_prompt: true,            // master_admin approval = active
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
  // Per the W11.5 schema, actor_user_id reflects the latest endorser. The
  // approval moment is captured here. Soft-fail: don't block the graduation
  // if this update fails.
  const { error: markErr } = await admin
    .from('composition_classification_overrides')
    .update({
      actor_user_id: approverUid ?? override.actor_user_id,
      actor_at: approverIso,
    })
    .eq('id', body.override_id);
  if (markErr) {
    console.warn(`[${GENERATOR}] override actor mark failed (non-fatal): ${markErr.message}`);
  }

  // Emit a shortlisting_events row for audit. Use override.round_id +
  // (resolve project_id from override.round_id → shortlisting_rounds).
  try {
    const { data: rd } = await admin
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', override.round_id)
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
    { ok: true, fewshot_example: resultRow, action, source_override_id: body.override_id },
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
 *
 * Returns null when no human_* field is set (the row is "accept AI" and has
 * nothing to graduate).
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
 * doesn't supply one. Format mirrors how fewShotLibraryBlock will render
 * the example so the description reads naturally in prompt context.
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

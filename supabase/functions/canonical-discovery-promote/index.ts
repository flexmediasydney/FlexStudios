/**
 * canonical-discovery-promote — Wave 12 / W11.6.11 promote / reject / defer
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Companion to `canonical-discovery-queue`. Resolves a single discovery row
 * (either a `pass2_slot_suggestion` event or an `object_registry_candidates`
 * row) into one of three terminal states: promoted, rejected, deferred.
 *
 * Endpoint contract:
 *
 *   POST {
 *     event_id: string,                    // either "slot:<bigint>" or "obj:<uuid>"
 *     action: 'promote' | 'reject' | 'defer',
 *
 *     // For promote:
 *     target_table?: 'object_registry' | 'attribute_registry',
 *     canonical_label?: string,            // required for promote
 *     display_name?: string,
 *     description?: string | null,
 *     parent_id?: string | null,           // parent_canonical_id for hierarchical objects
 *     level_0_class?: string | null,
 *     level_1_functional?: string | null,
 *     level_2_material?: string | null,
 *     level_3_specific?: string | null,
 *     level_4_detail?: string | null,
 *     aliases?: string[],
 *
 *     // W12.6 (service-role only):
 *     auto_promoted?: boolean,             // when true, sets object_registry.auto_promoted=TRUE
 *
 *     // For reject:
 *     reason?: string,
 *
 *     // For defer:
 *     defer_days?: number = 7
 *   }
 *
 *   →  { ok: true, ... } on success.
 *   →  { error: ... } with status 4xx/5xx on failure.
 *
 * Idempotency:
 *   - promote: if an object_registry row with the proposed canonical_label
 *     already exists, returns 409 + a no-op message. Source row's status is
 *     STILL flipped to 'promoted' and pointed at the existing canonical so
 *     the queue clears it from the pending list.
 *   - reject / defer: re-running on an already-resolved row returns 409.
 *
 * Auth: master_admin only — EXCEPT when `auto_promoted=true` is set in the
 *       payload, in which case ONLY service-role callers are accepted (the
 *       canonical-auto-suggest edge fn is the single legitimate caller; a
 *       master_admin who passed auto_promoted=true would be misrepresenting
 *       the audit trail). See W12.6 / mig 397.
 *
 * Note: the spec mentions `attribute_registry` as a separate target table,
 * but at v1 we surface attribute candidates through `attribute_values`
 * (a child of `object_registry`). Calls with target_table='attribute_registry'
 * return 501 until v2 — same posture as `object-registry-admin.approve_candidate`.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { embedText, formatVectorLiteral } from '../_shared/canonicalRegistry/embeddings.ts';

const FN_NAME = 'canonical-discovery-promote';
const FN_VERSION = 'v1.1'; // W12.6 — accepts auto_promoted flag (service-role only)

interface PromoteBody {
  event_id: string;
  action: 'promote' | 'reject' | 'defer';

  target_table?: 'object_registry' | 'attribute_registry';
  canonical_label?: string;
  display_name?: string;
  description?: string | null;
  parent_id?: string | null;
  level_0_class?: string | null;
  level_1_functional?: string | null;
  level_2_material?: string | null;
  level_3_specific?: string | null;
  level_4_detail?: string | null;
  aliases?: string[];

  reason?: string;
  defer_days?: number;

  /**
   * W12.6: when set TRUE, this promote was driven by the canonical-auto-suggest
   * edge fn rather than a human operator. Sets object_registry.auto_promoted=
   * TRUE + auto_promoted_at=now() instead of curated_by=user.id. ONLY service-
   * role callers may set this — non-service-role caller passing the flag is
   * rejected with 403 (would misrepresent the audit trail).
   */
  auto_promoted?: boolean;

  _health_check?: boolean;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ─── Auth ─────────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden: master_admin only', 403, req);
    }
  }
  const reviewerId = isServiceRole ? null : (user?.id || null);

  let body: PromoteBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: FN_NAME, ok: true }, 200, req);
  }

  if (!body.event_id) return errorResponse('event_id is required', 400, req);
  if (!body.action) return errorResponse('action is required', 400, req);

  // W12.6: auto_promoted flag is service-role only. A master_admin caller
  // passing auto_promoted=true would falsify the audit trail (the row would
  // appear AI-promoted when in fact a human curated it). Reject with 403.
  if (body.auto_promoted === true && !isServiceRole) {
    return errorResponse(
      'auto_promoted=true requires service-role auth (canonical-auto-suggest only)',
      403,
      req,
    );
  }

  const { kind, raw_id } = parseEventId(body.event_id);
  if (!kind) {
    return errorResponse('event_id must be prefixed "slot:<id>" or "obj:<uuid>"', 400, req);
  }

  const admin = getAdminClient();

  try {
    if (body.action === 'promote') {
      return await handlePromote(admin, kind, raw_id, body, reviewerId, req);
    } else if (body.action === 'reject') {
      return await handleReject(admin, kind, raw_id, body, reviewerId, req);
    } else if (body.action === 'defer') {
      return await handleDefer(admin, kind, raw_id, body, reviewerId, req);
    } else {
      return errorResponse(`Unknown action: ${body.action}`, 400, req);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${FN_NAME}] action ${body.action} failed: ${msg}`);
    return errorResponse(`${body.action} failed: ${msg}`, 500, req);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseEventId(eventId: string): { kind: 'slot' | 'obj' | null; raw_id: string } {
  if (eventId.startsWith('slot:')) {
    return { kind: 'slot', raw_id: eventId.slice(5) };
  }
  if (eventId.startsWith('obj:')) {
    return { kind: 'obj', raw_id: eventId.slice(4) };
  }
  return { kind: null, raw_id: eventId };
}

async function handlePromote(
  admin: ReturnType<typeof getAdminClient>,
  kind: 'slot' | 'obj',
  raw_id: string,
  body: PromoteBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  const target = body.target_table || 'object_registry';
  if (target === 'attribute_registry') {
    return errorResponse(
      'attribute_registry promotion is not yet supported (use object-registry-admin or wait for v2)',
      501,
      req,
    );
  }
  if (target !== 'object_registry') {
    return errorResponse(`Unknown target_table: ${target}`, 400, req);
  }

  const canonicalLabel = (body.canonical_label || '').trim();
  if (!canonicalLabel) {
    return errorResponse('canonical_label is required for promote', 400, req);
  }
  if (!/^[a-z0-9_]+$/.test(canonicalLabel)) {
    return errorResponse(
      'canonical_label must be snake_case lowercase ([a-z0-9_]+)',
      400,
      req,
    );
  }

  // ─── Idempotency check: does the canonical_label already exist? ──────────
  const { data: existing, error: existErr } = await admin
    .from('object_registry')
    .select('id, canonical_id, display_name, status')
    .eq('canonical_id', canonicalLabel)
    .maybeSingle();
  if (existErr) {
    return errorResponse(`canonical lookup failed: ${existErr.message}`, 500, req);
  }
  if (existing) {
    // Still mark the source row resolved so the queue clears it — but return
    // 409 so the caller knows we didn't insert a new row.
    await markSourceResolved(admin, kind, raw_id, {
      status: 'promoted',
      reviewerId,
      promotedIntoId: existing.id,
      canonical_label: canonicalLabel,
      target_table: target,
    });
    return jsonResponse({
      ok: false,
      idempotent: true,
      canonical_label: canonicalLabel,
      existing_id: existing.id,
      message: `canonical_label "${canonicalLabel}" already exists; source marked promoted (no new row inserted)`,
    }, 409, req);
  }

  // ─── Pull source data for embedding context ──────────────────────────────
  let displayName = (body.display_name || '').trim() || canonicalLabel;
  let description = body.description ?? null;
  const aliases = Array.isArray(body.aliases) ? body.aliases.filter((a) => typeof a === 'string') : [];
  let candidateEmbedding: string | null = null;
  let firstObservedAt: string | null = null;
  let observedCount = 1;

  if (kind === 'slot') {
    const eventBigint = Number(raw_id);
    if (!Number.isFinite(eventBigint)) {
      return errorResponse(`Invalid slot event_id: ${raw_id}`, 400, req);
    }
    const { data: ev, error: evErr } = await admin
      .from('shortlisting_events')
      .select('id, payload, created_at')
      .eq('id', eventBigint)
      .maybeSingle();
    if (evErr) return errorResponse(`event lookup failed: ${evErr.message}`, 500, req);
    if (!ev) return errorResponse('event not found', 404, req);
    if (ev.payload?.discovery_status && ev.payload.discovery_status !== 'pending' && ev.payload.discovery_status !== 'deferred') {
      return errorResponse(
        `event already in status='${ev.payload.discovery_status}'`,
        409,
        req,
      );
    }

    if (!description && ev.payload?.reasoning) description = String(ev.payload.reasoning).slice(0, 500);
    if (!body.display_name && ev.payload?.proposed_slot_id) {
      displayName = String(ev.payload.proposed_slot_id);
    }
    firstObservedAt = ev.created_at || null;
  } else {
    // obj kind: load object_registry_candidates row
    const { data: cand, error: candErr } = await admin
      .from('object_registry_candidates')
      .select('id, status, proposed_canonical_label, proposed_display_name, proposed_description, candidate_embedding, observed_count, first_proposed_at, sample_excerpts')
      .eq('id', raw_id)
      .maybeSingle();
    if (candErr) return errorResponse(`candidate lookup failed: ${candErr.message}`, 500, req);
    if (!cand) return errorResponse('candidate not found', 404, req);
    if (cand.status !== 'pending' && cand.status !== 'deferred') {
      return errorResponse(`candidate already in status='${cand.status}'`, 409, req);
    }

    if (!body.display_name) displayName = cand.proposed_display_name || canonicalLabel;
    if (!body.description) description = cand.proposed_description;
    candidateEmbedding = cand.candidate_embedding || null;
    observedCount = cand.observed_count || 1;
    firstObservedAt = cand.first_proposed_at;
  }

  // ─── Compute embedding if we don't have one cached on the candidate ──────
  if (!candidateEmbedding) {
    try {
      const composed = [displayName, description, aliases.join(', ')].filter(Boolean).join(' — ');
      const vec = await embedText(composed || canonicalLabel);
      candidateEmbedding = formatVectorLiteral(vec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${FN_NAME}] embed failed (continuing with NULL embedding): ${msg}`);
    }
  }

  // ─── Insert the canonical row ────────────────────────────────────────────
  const insertPayload: Record<string, unknown> = {
    canonical_id: canonicalLabel,
    display_name: displayName,
    description,
    level_0_class: body.level_0_class ?? null,
    level_1_functional: body.level_1_functional ?? null,
    level_2_material: body.level_2_material ?? null,
    level_3_specific: body.level_3_specific ?? null,
    level_4_detail: body.level_4_detail ?? null,
    parent_canonical_id: body.parent_id ?? null,
    aliases,
    embedding_vector: candidateEmbedding,
    market_frequency: observedCount,
    status: 'canonical',
    is_active: true,
    // W12.6: AI auto-promotions clear curated_by + set auto_promoted instead.
    // Human promotions clear auto_promoted + set curated_by. The two paths are
    // mutually exclusive — see mig 397 doc-comment for the audit triplet rule.
    created_by: body.auto_promoted ? null : reviewerId,
    curated_by: body.auto_promoted ? null : reviewerId,
    curated_at: body.auto_promoted ? null : new Date().toISOString(),
    auto_promoted: body.auto_promoted === true,
    auto_promoted_at: body.auto_promoted ? new Date().toISOString() : null,
    first_observed_at: firstObservedAt || new Date().toISOString(),
    last_observed_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await admin
    .from('object_registry')
    .insert(insertPayload)
    .select('id, canonical_id')
    .single();

  if (insertErr) {
    return errorResponse(`object_registry insert failed: ${insertErr.message}`, 500, req);
  }

  // ─── Mark the source row resolved ────────────────────────────────────────
  await markSourceResolved(admin, kind, raw_id, {
    status: 'promoted',
    reviewerId,
    promotedIntoId: inserted.id,
    canonical_label: canonicalLabel,
    target_table: target,
  });

  return jsonResponse({
    ok: true,
    event_id: body.event_id,
    promoted_into_id: inserted.id,
    canonical_label: inserted.canonical_id,
    target_table: target,
    auto_promoted: body.auto_promoted === true,
    message: body.auto_promoted
      ? `AI auto-promoted into object_registry as ${inserted.canonical_id}`
      : `Promoted into object_registry as ${inserted.canonical_id}`,
  }, 200, req);
}

async function handleReject(
  admin: ReturnType<typeof getAdminClient>,
  kind: 'slot' | 'obj',
  raw_id: string,
  body: PromoteBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  const reason = (body.reason || '').trim() || '[no reason supplied]';

  const ok = await markSourceResolved(admin, kind, raw_id, {
    status: 'rejected',
    reviewerId,
    reason,
  });
  if (!ok.success) return errorResponse(ok.error || 'reject failed', ok.statusCode || 500, req);

  return jsonResponse({
    ok: true,
    event_id: body.event_id,
    status: 'rejected',
    reason,
    message: 'Source row marked rejected',
  }, 200, req);
}

async function handleDefer(
  admin: ReturnType<typeof getAdminClient>,
  kind: 'slot' | 'obj',
  raw_id: string,
  body: PromoteBody,
  reviewerId: string | null,
  req: Request,
): Promise<Response> {
  const days = Math.max(1, Math.min(Number(body.defer_days) || 7, 90));
  const reviewAfter = new Date(Date.now() + days * 86400 * 1000).toISOString();

  const ok = await markSourceResolved(admin, kind, raw_id, {
    status: 'deferred',
    reviewerId,
    deferred_until: reviewAfter,
  });
  if (!ok.success) return errorResponse(ok.error || 'defer failed', ok.statusCode || 500, req);

  return jsonResponse({
    ok: true,
    event_id: body.event_id,
    status: 'deferred',
    review_after_at: reviewAfter,
    message: `Deferred for ${days} day(s)`,
  }, 200, req);
}

interface ResolveContext {
  status: 'promoted' | 'rejected' | 'deferred';
  reviewerId: string | null;
  promotedIntoId?: string;
  canonical_label?: string;
  target_table?: string;
  reason?: string;
  deferred_until?: string;
}

async function markSourceResolved(
  admin: ReturnType<typeof getAdminClient>,
  kind: 'slot' | 'obj',
  raw_id: string,
  ctx: ResolveContext,
): Promise<{ success: boolean; error?: string; statusCode?: number }> {
  const nowIso = new Date().toISOString();

  if (kind === 'slot') {
    const eventBigint = Number(raw_id);
    if (!Number.isFinite(eventBigint)) {
      return { success: false, error: 'Invalid slot event id', statusCode: 400 };
    }

    // Read-modify-write the JSONB payload.
    const { data: ev, error: loadErr } = await admin
      .from('shortlisting_events')
      .select('id, payload')
      .eq('id', eventBigint)
      .maybeSingle();
    if (loadErr) return { success: false, error: loadErr.message, statusCode: 500 };
    if (!ev) return { success: false, error: 'event not found', statusCode: 404 };

    const newPayload: Record<string, unknown> = {
      ...(ev.payload || {}),
      discovery_status: ctx.status,
      discovery_resolved_at: nowIso,
      discovery_resolved_by: ctx.reviewerId,
    };
    if (ctx.promotedIntoId) {
      newPayload.discovery_promoted_into_id = ctx.promotedIntoId;
      newPayload.discovery_target_table = ctx.target_table;
      newPayload.discovery_canonical_label = ctx.canonical_label;
    }
    if (ctx.reason) newPayload.discovery_reject_reason = ctx.reason;
    if (ctx.deferred_until) newPayload.discovery_deferred_until = ctx.deferred_until;

    const { error: upErr } = await admin
      .from('shortlisting_events')
      .update({ payload: newPayload })
      .eq('id', eventBigint);
    if (upErr) return { success: false, error: upErr.message, statusCode: 500 };
    return { success: true };
  }

  // obj kind: update object_registry_candidates row
  const { data: cand, error: loadErr } = await admin
    .from('object_registry_candidates')
    .select('id, status')
    .eq('id', raw_id)
    .maybeSingle();
  if (loadErr) return { success: false, error: loadErr.message, statusCode: 500 };
  if (!cand) return { success: false, error: 'candidate not found', statusCode: 404 };
  if (cand.status !== 'pending' && cand.status !== 'deferred') {
    return { success: false, error: `candidate already in status='${cand.status}'`, statusCode: 409 };
  }

  const dbStatus =
    ctx.status === 'promoted' ? 'approved'
    : ctx.status === 'rejected' ? 'rejected'
    : 'deferred';

  const update: Record<string, unknown> = {
    status: dbStatus,
    reviewed_by: ctx.reviewerId,
    reviewed_at: nowIso,
  };
  if (ctx.status === 'promoted' && ctx.promotedIntoId) {
    update.approved_object_id = ctx.promotedIntoId;
  }
  if (ctx.reason) update.reviewer_notes = ctx.reason;
  if (ctx.deferred_until) update.review_after_at = ctx.deferred_until;

  const { error: upErr } = await admin
    .from('object_registry_candidates')
    .update(update)
    .eq('id', raw_id);
  if (upErr) return { success: false, error: upErr.message, statusCode: 500 };

  return { success: true };
}

/**
 * update-stage4-override-review
 * ─────────────────────────────
 * Wave 11.7.7 / W11.6 — operator action endpoint for the Stage 4 override
 * review queue. Handles "reject" and "defer" status transitions.
 *
 * Approval is intentionally NOT handled here — approval has graduation
 * side-effects (e.g. promoting the override to engine_fewshot_examples)
 * which Agent 2 implements in `approve-stage4-override`. Keeping reject/defer
 * here keeps the agents' surface areas clean.
 *
 * Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md §F
 *       docs/design-specs/W11-7-7-master-listing-copy.md §"Stage 4 override
 *       review queue"
 *
 * Auth: master_admin or admin.
 *
 * POST body (single override):
 *   { override_id: string, action: 'reject' | 'defer',
 *     review_notes?: string }
 *
 * POST body (batch):
 *   { override_ids: string[], action: 'reject' | 'defer',
 *     review_notes?: string }
 *
 * Response:
 *   { ok: true, updated: number }
 *
 * Errors:
 *   400 → bad request
 *   401 → unauthenticated
 *   403 → not master_admin/admin
 *   404 → override_id not found
 *   500 → DB error
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'update-stage4-override-review';

const ALLOWED_ACTIONS = new Set(['reject', 'defer']);

interface ReqBody {
  override_id?: string;
  override_ids?: string[];
  action?: string;
  review_notes?: string;
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
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden — master_admin or admin only', 403, req);
    }
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('JSON body required', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  if (!body.action || !ALLOWED_ACTIONS.has(body.action)) {
    return errorResponse(
      `action must be one of: ${Array.from(ALLOWED_ACTIONS).join(', ')} (use approve-stage4-override for approve)`,
      400,
      req,
    );
  }

  // Normalise to batch.
  let ids: string[];
  if (Array.isArray(body.override_ids)) {
    ids = body.override_ids;
  } else if (typeof body.override_id === 'string') {
    ids = [body.override_id];
  } else {
    return errorResponse('override_id (string) or override_ids (array) required', 400, req);
  }
  if (ids.length === 0) {
    return errorResponse('At least one override_id required', 400, req);
  }
  if (ids.length > 100) {
    return errorResponse('Max 100 override_ids per request', 400, req);
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id.length < 8) {
      return errorResponse(`Invalid override_id: ${JSON.stringify(id)}`, 400, req);
    }
  }

  const reviewerId = isService ? null : user!.id;
  const newStatus = body.action === 'reject' ? 'rejected' : 'deferred';
  const nowIso = new Date().toISOString();

  const admin = getAdminClient();

  const { data: updated, error: updErr } = await admin
    .from('shortlisting_stage4_overrides')
    .update({
      review_status: newStatus,
      reviewed_by: reviewerId,
      reviewed_at: nowIso,
      review_notes: body.review_notes ?? null,
    })
    .in('id', ids)
    // Allow re-deferring an already-deferred row (operator may want to
    // bump it back into pending later by passing action=pending, but
    // that path isn't implemented at v1). Block transitions away from
    // 'approved' — once approved, the row should be locked from these
    // actions; if an approval was wrong, the operator can re-approve
    // the corrected value via approve-stage4-override.
    .neq('review_status', 'approved')
    .select('id, review_status, reviewed_at');
  if (updErr) {
    return errorResponse(`update failed: ${updErr.message}`, 500, req);
  }

  // 2026-05-03 (Rainbow QA hotfix) — surface the case where 0 rows were
  // actually updated.  Previously the fn returned `{ ok: true, updated: 0 }`
  // and the UI treated that as success, optimistically removed the card,
  // then on refetch saw the still-pending row and the user observed a
  // phantom revert.  Now we hard-fail when nothing landed (RLS filter,
  // row deleted by a concurrent Stage 4 re-run, or all rows already
  // approved).  Partial successes (some rows updated, some skipped)
  // still return 200 with the count so the UI can show "updated N/M".
  const updatedRows = updated ?? [];
  if (updatedRows.length === 0 && ids.length > 0) {
    return errorResponse(
      `${body.action} affected 0 of ${ids.length} requested rows. ` +
        `Possible causes: rows already approved (this endpoint cannot ` +
        `transition FROM approved — re-approve via approve-stage4-override ` +
        `if needed), rows deleted by a concurrent Stage 4 re-run, or RLS ` +
        `silently filtered the update.`,
      409,
      req,
    );
  }
  if (updatedRows.length < ids.length) {
    console.warn(
      `[${GENERATOR}] partial update: ${updatedRows.length}/${ids.length} ` +
        `rows transitioned to ${newStatus}.  Remaining ${ids.length - updatedRows.length} ` +
        `were skipped (likely already approved or no longer exist).`,
    );
  }

  return jsonResponse(
    {
      ok: true,
      updated: updatedRows.length,
      requested: ids.length,
      new_status: newStatus,
      rows: updatedRows,
    },
    200,
    req,
  );
});

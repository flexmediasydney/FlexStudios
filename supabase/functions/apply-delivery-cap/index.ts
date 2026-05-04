/**
 * apply-delivery-cap
 * ──────────────────
 * Mig 470 — sets a client-driven delivery cap on a shortlisting round and
 * atomically re-trims the proposed set to match.
 *
 * Wraps the apply_delivery_cap RPC with auth + JSON contract. The RPC does
 * the heavy lifting (sort by combined_score, append override events for new
 * trims, append revert events when the cap is raised/cleared).
 *
 * ─── INPUT ────────────────────────────────────────────────────────────────────
 *
 *   POST { round_id: <UUID>, cap: <int | null> }
 *
 *   cap = null → clears the cap; reverts all prior 'delivery_cap' trims.
 *   cap > 0    → applies/updates the cap; emits trim/revert events as needed.
 *
 *   POST { _health_check: true } → 200 with version stamp.
 *
 * ─── AUTH ─────────────────────────────────────────────────────────────────────
 *
 * master_admin / admin only. The cap affects training signal (excludes the
 * trims from engine_fewshot_examples graduation), so we gate the same way
 * other training-affecting writes are gated.
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'apply-delivery-cap';

interface ReqBody {
  round_id?: string;
  cap?: number | null;
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

  let body: ReqBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  if (!body.round_id || typeof body.round_id !== 'string') {
    return errorResponse('round_id (UUID string) required', 400, req);
  }

  // cap accepts: null (clear), positive integer (apply). Reject 0/negative
  // explicitly so the operator can't accidentally send {cap: 0} and get a
  // round with everything trimmed.
  let capValue: number | null;
  if (body.cap === null || body.cap === undefined) {
    capValue = null;
  } else if (typeof body.cap === 'number' && Number.isInteger(body.cap) && body.cap > 0) {
    capValue = body.cap;
  } else {
    return errorResponse(
      'cap must be a positive integer or null (null clears the cap)',
      400,
      req,
    );
  }
  if (capValue !== null && capValue > 1000) {
    return errorResponse('cap exceeds max (1000) — sanity check', 400, req);
  }

  const admin = getAdminClient();

  // Resolve project_id for the audit event before we mutate state. Also
  // gives us a 404 path that's cleaner than letting the RPC raise.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, package_ceiling, delivery_cap_override')
    .eq('id', body.round_id)
    .maybeSingle();
  if (roundErr) {
    return errorResponse(`round lookup failed: ${roundErr.message}`, 500, req);
  }
  if (!round) {
    return errorResponse(`round ${body.round_id} not found`, 404, req);
  }
  if (round.status === 'locked' || round.status === 'delivered') {
    return errorResponse(
      `round is ${round.status} — unlock before changing the delivery cap`,
      409,
      req,
    );
  }

  // Call the RPC — it does the trim/revert atomically.
  const { data: rpcResult, error: rpcErr } = await admin.rpc('apply_delivery_cap', {
    p_round_id: body.round_id,
    p_cap: capValue,
  });
  if (rpcErr) {
    return errorResponse(`apply_delivery_cap RPC failed: ${rpcErr.message}`, 500, req);
  }

  // Audit event — useful in the round timeline so the operator can see
  // "cap was changed from X to Y at HH:MM by <user>".
  try {
    await admin.from('shortlisting_events').insert({
      project_id: round.project_id,
      round_id: body.round_id,
      event_type: capValue === null ? 'delivery_cap_cleared' : 'delivery_cap_applied',
      actor_type: isService ? 'system' : 'human',
      actor_user_id: isService ? null : user!.id,
      payload: {
        previous_cap: round.delivery_cap_override ?? null,
        new_cap: capValue,
        package_ceiling: round.package_ceiling ?? null,
        rpc_result: rpcResult,
      },
    });
  } catch (e) {
    console.warn(`[${GENERATOR}] event insert failed (non-fatal): ${e}`);
  }

  return jsonResponse(
    {
      ok: true,
      round_id: body.round_id,
      cap: capValue,
      ...(typeof rpcResult === 'object' && rpcResult !== null ? rpcResult : {}),
    },
    200,
    req,
  );
});

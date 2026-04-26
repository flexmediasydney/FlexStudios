/**
 * drone-job-fire-now — Wave 9 Stream 1
 * ─────────────────────────────────────
 * Operator-facing "Skip wait — fire now" action used by the Drone Pipeline
 * Stage HUD when an ingest (or any other) job is sitting in the debounce
 * window with `status='pending'` and `scheduled_for > NOW()`.
 *
 * Behaviour:
 *   1. Auth: master_admin / admin / manager. Reject employee/contractor.
 *   2. Locate the target row:
 *        - if body.job_id is supplied → use that row (must be status='pending')
 *        - else require body.kind + body.project_id (+ optional shoot_id) and
 *          pick the most-recent matching pending row.
 *   3. UPDATE drone_jobs SET scheduled_for = NOW(),
 *        payload = payload || { forced_at, forced_by }
 *      so the next dispatcher tick (≤ 60s) claims it. Returns the
 *      previous_scheduled_for so the UI can render an "X seconds skipped" toast.
 *   4. Invoke the dispatcher inline with a 5-second AbortController budget.
 *      Don't block on the response — best-effort kick so the operator doesn't
 *      have to wait for the next cron tick.
 *   5. Audit a drone_events row (event_type='operator_force_fire').
 *
 * Request body (one of):
 *   { job_id: "<uuid>" }
 *   { kind: "ingest", project_id: "<uuid>", shoot_id?: "<uuid>" }
 *
 * Response:
 *   { success, job_id, kind, previous_scheduled_for, dispatched }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'drone-job-fire-now';
const SUPABASE_URL =
  Deno.env.get('SUPABASE_URL') || 'https://rjzdznwkxnzfekgcdkei.supabase.co';
// Inline dispatcher kick — same JWT the dispatcher uses to call other Edge
// Functions. Falls back to SUPABASE_SERVICE_ROLE_KEY which is accepted by
// drone-job-dispatcher's getUserFromReq because of its sb_secret_* / direct-
// match shortcut, but the dedicated DRONE_DISPATCHER_JWT is preferred.
const DISPATCHER_JWT =
  Deno.env.get('DRONE_DISPATCHER_JWT') ||
  Deno.env.get('LEGACY_SERVICE_ROLE_JWT') ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  '';
const DISPATCHER_KICK_BUDGET_MS = 5_000;

interface FireNowBody {
  job_id?: string;
  kind?: string;
  project_id?: string;
  shoot_id?: string | null;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ── Auth gate ────────────────────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse(
        'Forbidden — only master_admin / admin / manager may force-fire drone jobs',
        403,
        req,
      );
    }
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let body: FireNowBody = {};
  try {
    body = (await req.json()) as FireNowBody;
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const admin = getAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const actorUserId = isService ? null : user?.id ?? null;

  // ── Resolve target row ───────────────────────────────────────────────────
  let targetId: string | null = null;
  let targetKind: string | null = null;
  let targetProject: string | null = null;
  let targetShoot: string | null = null;
  let previousScheduledFor: string | null = null;
  let existingPayload: Record<string, unknown> = {};

  if (body.job_id) {
    const { data, error } = await admin
      .from('drone_jobs')
      .select('id, kind, status, project_id, shoot_id, scheduled_for, payload')
      .eq('id', body.job_id)
      .maybeSingle();
    if (error) return errorResponse(`drone_jobs lookup failed: ${error.message}`, 500, req);
    if (!data) return errorResponse(`job ${body.job_id} not found`, 404, req);
    if (data.status !== 'pending') {
      return errorResponse(
        `job ${body.job_id} is not pending (status=${data.status}); cannot force-fire`,
        409,
        req,
      );
    }
    targetId = data.id;
    targetKind = data.kind;
    targetProject = data.project_id;
    targetShoot = data.shoot_id;
    previousScheduledFor = data.scheduled_for;
    existingPayload = (data.payload as Record<string, unknown>) || {};
  } else {
    if (!body.kind || !body.project_id) {
      return errorResponse(
        'Provide either {job_id} OR {kind, project_id} (with optional shoot_id)',
        400,
        req,
      );
    }
    let q = admin
      .from('drone_jobs')
      .select('id, kind, status, project_id, shoot_id, scheduled_for, payload')
      .eq('kind', body.kind)
      .eq('status', 'pending');
    if (body.shoot_id) {
      q = q.eq('shoot_id', body.shoot_id);
    } else {
      q = q.eq('project_id', body.project_id);
    }
    const { data, error } = await q
      .order('scheduled_for', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      return errorResponse(`drone_jobs lookup failed: ${error.message}`, 500, req);
    }
    if (!data) {
      return errorResponse(
        `no pending job of kind=${body.kind} found in scope (project=${body.project_id}, shoot=${body.shoot_id ?? 'any'})`,
        404,
        req,
      );
    }
    targetId = data.id;
    targetKind = data.kind;
    targetProject = data.project_id;
    targetShoot = data.shoot_id;
    previousScheduledFor = data.scheduled_for;
    existingPayload = (data.payload as Record<string, unknown>) || {};
  }

  // ── Apply force-fire update ──────────────────────────────────────────────
  const newPayload: Record<string, unknown> = {
    ...existingPayload,
    forced_at: nowIso,
    forced_by: actorUserId,
    forced_via: GENERATOR,
  };

  const { error: updErr } = await admin
    .from('drone_jobs')
    .update({
      scheduled_for: nowIso,
      payload: newPayload,
    })
    .eq('id', targetId!)
    .eq('status', 'pending'); // belt + braces: don't overwrite a row claimed mid-flight
  if (updErr) {
    return errorResponse(`drone_jobs update failed: ${updErr.message}`, 500, req);
  }

  // ── Best-effort dispatcher kick (5s budget; do not block on response) ────
  let dispatched = false;
  let dispatchError: string | null = null;
  if (DISPATCHER_JWT) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('dispatcher_kick_5s_budget'), DISPATCHER_KICK_BUDGET_MS);
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/drone-job-dispatcher`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DISPATCHER_JWT}`,
          'x-caller-context': `cross_fn:${GENERATOR}`,
        },
        body: '{}',
        signal: ctrl.signal,
      });
      dispatched = resp.ok;
      if (!resp.ok) {
        dispatchError = `dispatcher returned ${resp.status}`;
      }
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(t);
    }
  } else {
    dispatchError = 'DRONE_DISPATCHER_JWT / SUPABASE_SERVICE_ROLE_KEY not set — cron will pick up within 60s';
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  await admin.from('drone_events').insert({
    project_id: targetProject,
    shoot_id: targetShoot,
    event_type: 'operator_force_fire',
    actor_type: actorUserId ? 'user' : 'system',
    actor_id: actorUserId,
    payload: {
      job_id: targetId,
      kind: targetKind,
      previous_scheduled_for: previousScheduledFor,
      dispatched,
      dispatch_error: dispatchError,
    },
  }).then(({ error: auditErr }) => {
    if (auditErr) console.warn(`[${GENERATOR}] audit insert failed: ${auditErr.message}`);
  });

  return jsonResponse(
    {
      success: true,
      job_id: targetId,
      kind: targetKind,
      project_id: targetProject,
      shoot_id: targetShoot,
      previous_scheduled_for: previousScheduledFor,
      dispatched,
      dispatch_error: dispatchError,
    },
    200,
    req,
  );
});

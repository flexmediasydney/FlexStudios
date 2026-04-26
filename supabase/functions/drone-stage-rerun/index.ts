/**
 * drone-stage-rerun — Wave 9 Stream 1
 * ────────────────────────────────────
 * Operator action that explicitly enqueues a fresh drone_jobs row for a
 * specific pipeline stage. Used by the Drone Pipeline Stage HUD's per-stage
 * "Re-run" button when the operator wants to retry an SfM that hung, refresh
 * the POI cache, etc.
 *
 * Behaviour:
 *   1. Auth gate:
 *        - master_admin / admin / manager (operator+) for most stages.
 *        - admin+ for 'edited_render' (cascade is expensive — keep it gated).
 *   2. Map stage → drone_jobs.kind:
 *        ingest         → 'ingest'   (uses enqueue_drone_ingest_job RPC)
 *        sfm            → 'sfm'      (also flips drone_shoots.status='sfm_running')
 *        poi            → 'poi_fetch'
 *        cadastral      → 'cadastral_fetch'
 *        raw_render     → 'raw_preview_render'
 *        edited_render  → 'render_edited' OR 'boundary_save_render_cascade' if cascade=true
 *   3. Idempotency: if a pending OR running row of that kind already exists
 *      for the scope, RETURN { success:true, no_op:true, existing_job_id }
 *      and do NOT insert a duplicate. The dispatcher's per-row dedupe would
 *      catch it eventually but operators benefit from an explicit signal.
 *   4. INSERT new drone_jobs row with scheduled_for=NOW(), payload includes
 *      { forced_by, forced_reason:'operator_stage_rerun' }, pipeline='raw'
 *      or 'edited' as appropriate.
 *   5. For stage='sfm': UPDATE drone_shoots SET status='sfm_running' via the
 *      service-role admin client (bypasses the lifecycle trigger gate).
 *   6. Best-effort dispatcher kick with a 5s AbortController budget.
 *   7. Audit drone_events with event_type='operator_stage_rerun'.
 *
 * Request body:
 *   { stage: 'ingest'|'sfm'|'poi'|'cadastral'|'raw_render'|'edited_render',
 *     project_id: string,
 *     shoot_id?: string,
 *     cascade?: boolean   // only meaningful for edited_render
 *   }
 *
 * Response:
 *   { success, no_op?, job_id, kind, dispatched, dispatch_error?, existing_job_id? }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'drone-stage-rerun';
const SUPABASE_URL =
  Deno.env.get('SUPABASE_URL') || 'https://rjzdznwkxnzfekgcdkei.supabase.co';
const DISPATCHER_JWT =
  Deno.env.get('DRONE_DISPATCHER_JWT') ||
  Deno.env.get('LEGACY_SERVICE_ROLE_JWT') ||
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  '';
const DISPATCHER_KICK_BUDGET_MS = 5_000;

type StageKey =
  | 'ingest'
  | 'sfm'
  | 'poi'
  | 'cadastral'
  | 'raw_render'
  | 'edited_render';

interface RerunBody {
  stage?: StageKey;
  project_id?: string;
  shoot_id?: string | null;
  cascade?: boolean;
  _health_check?: boolean;
}

const STAGE_TO_KIND: Record<StageKey, string> = {
  ingest: 'ingest',
  sfm: 'sfm',
  poi: 'poi_fetch',
  cadastral: 'cadastral_fetch',
  raw_render: 'raw_preview_render',
  edited_render: 'render_edited',
};

const STAGE_TO_PIPELINE: Record<StageKey, 'raw' | 'edited' | null> = {
  ingest: null,
  sfm: null,
  poi: null,
  cadastral: null,
  raw_render: 'raw',
  edited_render: 'edited',
};

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
      return errorResponse(
        'Forbidden — only master_admin / admin / manager may re-run drone stages',
        403,
        req,
      );
    }
  }

  // ── Body parse ───────────────────────────────────────────────────────────
  let body: RerunBody = {};
  try {
    body = (await req.json()) as RerunBody;
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const stage = body.stage;
  const projectId = body.project_id;
  const shootId = body.shoot_id ?? null;
  const wantsCascade = body.cascade === true;

  if (!stage || !STAGE_TO_KIND[stage]) {
    return errorResponse(
      `stage required and must be one of: ${Object.keys(STAGE_TO_KIND).join(', ')}`,
      400,
      req,
    );
  }
  if (!projectId) return errorResponse('project_id required', 400, req);

  // edited_render cascade is destructive and project-wide → admin+ only
  if (stage === 'edited_render' && !isService) {
    if (!['master_admin', 'admin'].includes(user!.role || '')) {
      return errorResponse(
        'Forbidden — edited_render re-run requires master_admin or admin',
        403,
        req,
      );
    }
  }

  // Resolve final kind (cascade variant for edited_render)
  let kind = STAGE_TO_KIND[stage];
  if (stage === 'edited_render' && wantsCascade) {
    kind = 'boundary_save_render_cascade';
  }
  const pipeline = STAGE_TO_PIPELINE[stage];
  const actorUserId = isService ? null : user?.id ?? null;
  const admin = getAdminClient();
  const nowIso = new Date().toISOString();

  // ── Idempotency check ────────────────────────────────────────────────────
  // Look for an EXISTING pending/running row for the same kind in the same
  // scope so we don't pile duplicates onto the queue. For project-scope
  // cascades (boundary_save_render_cascade) the shoot_id is NULL and we
  // dedupe at the project level.
  let dedupQuery = admin
    .from('drone_jobs')
    .select('id, status, scheduled_for')
    .eq('kind', kind)
    .in('status', ['pending', 'running']);
  if (shootId) {
    dedupQuery = dedupQuery.eq('shoot_id', shootId);
  } else {
    dedupQuery = dedupQuery.eq('project_id', projectId).is('shoot_id', null);
  }
  const { data: existing, error: dedupErr } = await dedupQuery
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dedupErr) {
    return errorResponse(`drone_jobs dedupe lookup failed: ${dedupErr.message}`, 500, req);
  }
  if (existing) {
    // Audit even the no-op so the operator's intent is recorded.
    await admin.from('drone_events').insert({
      project_id: projectId,
      shoot_id: shootId,
      event_type: 'operator_stage_rerun',
      actor_type: actorUserId ? 'user' : 'system',
      actor_id: actorUserId,
      payload: {
        stage,
        kind,
        no_op: true,
        existing_job_id: existing.id,
        existing_status: existing.status,
      },
    });
    return jsonResponse(
      {
        success: true,
        no_op: true,
        existing_job_id: existing.id,
        existing_status: existing.status,
        existing_scheduled_for: existing.scheduled_for,
        kind,
        stage,
      },
      200,
      req,
    );
  }

  // ── Build the new row ────────────────────────────────────────────────────
  const insertPayload: Record<string, unknown> = {
    project_id: projectId,
    shoot_id: shootId,
    forced_by: actorUserId,
    forced_reason: 'operator_stage_rerun',
    forced_via: GENERATOR,
    forced_at: nowIso,
  };

  // Stage-specific payload extras so the dispatcher knows what to dispatch
  if (stage === 'sfm') {
    insertPayload.shoot_id = shootId;
  }
  if (stage === 'edited_render') {
    insertPayload.cascade = wantsCascade;
    insertPayload.kind = 'poi_plus_boundary';
    insertPayload.column_state = 'adjustments';
    insertPayload.reason = wantsCascade
      ? 'boundary_edit_cascade'
      : 'operator_stage_rerun_edited';
  }

  // Special path: ingest uses the canonical RPC for debounce semantics.
  if (stage === 'ingest') {
    // enqueue_drone_ingest_job sets scheduled_for=NOW()+120s by default; we
    // pass debounce_seconds=0 so the operator's "re-run ingest" actually
    // fires in the next dispatcher tick.
    const { data: jobIdData, error: rpcErr } = await admin.rpc(
      'enqueue_drone_ingest_job',
      { p_project_id: projectId, p_debounce_seconds: 0 },
    );
    if (rpcErr) {
      return errorResponse(`enqueue_drone_ingest_job RPC failed: ${rpcErr.message}`, 500, req);
    }
    const jobId = jobIdData as string | null;

    // Patch payload with operator metadata
    if (jobId) {
      await admin
        .from('drone_jobs')
        .update({
          payload: {
            project_id: projectId,
            forced_by: actorUserId,
            forced_reason: 'operator_stage_rerun',
            forced_via: GENERATOR,
            forced_at: nowIso,
          },
        })
        .eq('id', jobId);
    }

    return await finishAndAudit({
      admin,
      projectId,
      shootId,
      kind: 'ingest',
      stage,
      jobId,
      actorUserId,
      req,
    });
  }

  // ── INSERT new drone_jobs row ────────────────────────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from('drone_jobs')
    .insert({
      project_id: projectId,
      shoot_id: shootId,
      kind,
      status: 'pending',
      payload: insertPayload,
      scheduled_for: nowIso,
      pipeline,
    })
    .select('id')
    .single();
  if (insErr) {
    return errorResponse(`drone_jobs insert failed: ${insErr.message}`, 500, req);
  }
  const jobId = inserted.id as string;

  // ── For sfm: flip drone_shoots.status so the UI reflects the re-run ──────
  if (stage === 'sfm' && shootId) {
    const { error: shootErr } = await admin
      .from('drone_shoots')
      .update({ status: 'sfm_running' })
      .eq('id', shootId);
    if (shootErr) {
      // Non-fatal — the dispatcher will still pick up the job, but log it.
      console.warn(`[${GENERATOR}] failed to flip drone_shoots.status to sfm_running: ${shootErr.message}`);
    }
  }

  return await finishAndAudit({
    admin,
    projectId,
    shootId,
    kind,
    stage,
    jobId,
    actorUserId,
    req,
  });
});

/**
 * Best-effort dispatcher kick + audit insert + final response. Extracted so
 * both the ingest-RPC path and the direct-insert path use the same tail
 * sequence.
 */
async function finishAndAudit(args: {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  shootId: string | null;
  kind: string;
  stage: StageKey;
  jobId: string | null;
  actorUserId: string | null;
  req: Request;
}): Promise<Response> {
  const { admin, projectId, shootId, kind, stage, jobId, actorUserId, req } = args;

  // ── Best-effort dispatcher kick (5s budget) ──────────────────────────────
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
    dispatchError = 'no dispatcher JWT available — cron will pick up within 60s';
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  await admin.from('drone_events').insert({
    project_id: projectId,
    shoot_id: shootId,
    event_type: 'operator_stage_rerun',
    actor_type: actorUserId ? 'user' : 'system',
    actor_id: actorUserId,
    payload: {
      stage,
      kind,
      job_id: jobId,
      dispatched,
      dispatch_error: dispatchError,
    },
  }).then(({ error: auditErr }) => {
    if (auditErr) console.warn(`[drone-stage-rerun] audit insert failed: ${auditErr.message}`);
  });

  return jsonResponse(
    {
      success: true,
      job_id: jobId,
      kind,
      stage,
      project_id: projectId,
      shoot_id: shootId,
      dispatched,
      dispatch_error: dispatchError,
    },
    200,
    req,
  );
}

/**
 * force-run-now
 * ─────────────
 * Wave 11.6 / Wave 2B — operator override that pulls a pending shortlisting
 * job's `scheduled_for` to NOW(), so the next dispatcher tick (within ≤60s)
 * picks it up immediately.
 *
 * Why this exists: the failed-job backoff schedules retries 60s / 300s /
 * 1800s out (see shortlisting-job-dispatcher), and the ingest debounce
 * (Wave 6 P1.4) sets `scheduled_for` up to 2 hours in the future for
 * coalescing webhook fan-out. Operators staring at a "stuck" round have
 * no way to short-circuit either window without raw SQL access. This fn
 * gives them a controlled, audited button.
 *
 * Mechanics: UPDATE shortlisting_jobs SET
 *   scheduled_for = NOW(),
 *   error_message = NULL,
 *   attempt_count = 0,
 *   started_at    = NULL
 * WHERE id = $1 AND status = 'pending'
 *
 *   - We refuse to touch `running` jobs — that would risk double-dispatch.
 *     The dispatcher's stale-claim sweep (5min) is the right path for
 *     genuinely-stuck running rows.
 *   - Terminal statuses (succeeded/failed/dead_letter) are also refused —
 *     re-running a finished job is a different verb (re-enqueue) handled
 *     by the per-pass-kind retry endpoints.
 *
 * Auth: master_admin only. Defense-in-depth — the UI also gates the button.
 *
 * POST body: { job_id: string }
 *
 * Response (200):
 *   { ok: true, job: <updated row>, next_dispatcher_tick_iso: string }
 *
 * Response (4xx):
 *   400 — job_id missing or status not 'pending'
 *   401 — unauthenticated
 *   403 — non-master_admin
 *   404 — job not found
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'force-run-now';

interface ReqBody {
  job_id?: string;
  _health_check?: boolean;
}

interface JobRow {
  id: string;
  project_id: string;
  round_id: string | null;
  kind: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

function nextDispatcherTick(now: Date): Date {
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  return t;
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
      return errorResponse('Forbidden — master_admin only', 403, req);
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

  const jobId = body.job_id;
  if (!jobId || typeof jobId !== 'string') {
    return errorResponse('job_id required', 400, req);
  }

  const admin = getAdminClient();

  // First, fetch the row to validate status — gives us a precise 4xx instead
  // of "0 rows updated" which is ambiguous (not-found vs not-pending).
  const { data: existingRaw, error: fetchErr } = await admin
    .from('shortlisting_jobs')
    .select(
      'id, project_id, round_id, kind, status, attempt_count, max_attempts, ' +
        'scheduled_for, started_at, finished_at, error_message',
    )
    .eq('id', jobId)
    .maybeSingle();
  if (fetchErr) {
    return errorResponse(`job lookup failed: ${fetchErr.message}`, 500, req);
  }
  const existing = existingRaw as unknown as JobRow | null;
  if (!existing) {
    return errorResponse(`job ${jobId} not found`, 404, req);
  }
  if (existing.status !== 'pending') {
    return errorResponse(
      `job ${jobId} has status '${existing.status}' — only 'pending' jobs can be force-run`,
      400,
      req,
    );
  }

  // Atomic UPDATE with explicit status guard so a concurrent dispatcher
  // claim (status flip pending→running) doesn't get clobbered. PostgREST
  // applies the .eq() filters as part of the UPDATE WHERE clause.
  const nowIso = new Date().toISOString();
  const { data: updatedRaw, error: updErr } = await admin
    .from('shortlisting_jobs')
    .update({
      scheduled_for: nowIso,
      error_message: null,
      attempt_count: 0,
      started_at: null,
    })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select(
      'id, project_id, round_id, kind, status, attempt_count, max_attempts, ' +
        'scheduled_for, started_at, finished_at, error_message',
    )
    .maybeSingle();
  if (updErr) {
    return errorResponse(`force-run update failed: ${updErr.message}`, 500, req);
  }
  const updated = updatedRaw as unknown as JobRow | null;
  if (!updated) {
    // Race: dispatcher claimed it between the SELECT and UPDATE. Give the
    // operator a clear message — they'll see the row transition on the next
    // panel refresh.
    return errorResponse(
      `job ${jobId} was claimed by the dispatcher just now — refresh and retry if it still looks stuck`,
      409,
      req,
    );
  }

  // Best-effort domain audit event so this admin override leaves a trail.
  // Non-fatal if it fails (logging path may be down; the verb itself
  // succeeded and that's the operator-facing contract).
  try {
    await admin.from('shortlisting_events').insert({
      project_id: updated.project_id,
      round_id: updated.round_id,
      event_type: 'job_force_run',
      actor_type: 'user',
      actor_id: user?.id || null,
      payload: {
        job_id: updated.id,
        kind: updated.kind,
        prior_scheduled_for: existing.scheduled_for,
        prior_attempt_count: existing.attempt_count,
        forced_at: nowIso,
      },
    });
  } catch (eventErr) {
    console.warn(`[${GENERATOR}] audit event insert failed:`, (eventErr as Error)?.message);
  }

  const tick = nextDispatcherTick(new Date());

  return jsonResponse(
    {
      ok: true,
      job: updated,
      next_dispatcher_tick_iso: tick.toISOString(),
    },
    200,
    req,
  );
});

/**
 * list-project-jobs
 * ─────────────────
 * Wave 11.6 / Wave 2B — Dispatcher visibility panel backend.
 *
 * Returns a snapshot of `shortlisting_jobs` for an operator-facing dispatcher
 * panel: active rows (pending|running) + recent terminal rows (last N min)
 * plus a computed `next_dispatcher_tick_iso` so the frontend can render a
 * live countdown without a server roundtrip every second.
 *
 * Spec context:
 *   The shortlisting-job-dispatcher cron fires every minute (`* * * * *`,
 *   migration 292). Most operators have no visibility into:
 *     1. when the next tick will fire (the 0-60s gap is the source of "did
 *        my round stick?" anxiety)
 *     2. which jobs are actively in flight for THIS round
 *     3. how long a stage took (start/finish wall time)
 *   This fn powers the DispatcherPanel.jsx component which renders all three.
 *
 * Auth: master_admin / admin / manager. Lower roles aren't part of the
 * shortlisting operator surface.
 *
 * POST body:
 *   { project_id?: string,        // filter to one project (typical use)
 *     round_id?: string,          // optional narrower filter inside project
 *     since_minutes?: number      // recent-window for terminal rows; default 30, max 240
 *   }
 *
 *   At least one of project_id / round_id is required (we never want to
 *   return the global queue from this endpoint — that's a different surface).
 *
 * Response:
 *   { ok: true,
 *     jobs: Array<{
 *       id, kind, status, attempt_count, max_attempts,
 *       scheduled_for, started_at, finished_at,
 *       wall_seconds: number | null,    // (finished_at|now) − started_at, or null
 *       error_message_short: string | null,
 *     }>;
 *     next_dispatcher_tick_iso: string;   // top of next minute UTC
 *     active_count: number;               // pending + running
 *     succeeded_count: number;            // last since_minutes
 *     failed_count: number;               // last since_minutes (incl. dead_letter)
 *     pending_count: number;
 *     running_count: number;
 *     dead_letter_count: number;
 *     since_minutes: number;
 *     server_time_iso: string;            // for clock-skew correction
 *   }
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'list-project-jobs';

const ALLOWED_ROLES = new Set(['master_admin', 'admin', 'manager']);
const ERROR_MSG_MAX = 120;

interface ReqBody {
  project_id?: string;
  round_id?: string;
  since_minutes?: number;
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

/**
 * Round `now` to the next whole UTC minute. The dispatcher is on `* * * * *`
 * so the next tick lands on the next 00 seconds boundary (e.g. 14:23:42 →
 * 14:24:00). We add 1ms safety so when the call lands exactly on :00.000
 * we don't return the same instant.
 */
function nextDispatcherTick(now: Date): Date {
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  return t;
}

/** Compute wall_seconds from started_at + (finished_at | now). Null if no started_at. */
function computeWallSeconds(
  startedAt: string | null,
  finishedAt: string | null,
  now: Date,
): number | null {
  if (!startedAt) return null;
  const s = Date.parse(startedAt);
  if (!isFinite(s)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now.getTime();
  if (!isFinite(end) || end < s) return null;
  return Math.round((end - s) / 1000);
}

function shortenError(msg: string | null): string | null {
  if (!msg) return null;
  const cleaned = msg.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= ERROR_MSG_MAX) return cleaned;
  return cleaned.slice(0, ERROR_MSG_MAX - 1) + '…';
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!ALLOWED_ROLES.has(user.role || '')) {
      return errorResponse('Forbidden — master_admin, admin, or manager only', 403, req);
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

  const projectId = typeof body.project_id === 'string' ? body.project_id : null;
  const roundId = typeof body.round_id === 'string' ? body.round_id : null;
  if (!projectId && !roundId) {
    return errorResponse('project_id or round_id required', 400, req);
  }

  const sinceMinutesRaw = Number(body.since_minutes ?? 30);
  const sinceMinutes = Math.min(
    Math.max(isFinite(sinceMinutesRaw) ? sinceMinutesRaw : 30, 1),
    240,
  );

  const now = new Date();
  const sinceIso = new Date(now.getTime() - sinceMinutes * 60_000).toISOString();

  const admin = getAdminClient();

  // Active jobs: pending|running for the scope. No time filter — we always
  // want to see anything currently in flight regardless of age.
  let activeQuery = admin
    .from('shortlisting_jobs')
    .select(
      'id, project_id, round_id, kind, status, attempt_count, max_attempts, ' +
        'scheduled_for, started_at, finished_at, error_message',
    )
    .in('status', ['pending', 'running']);
  if (projectId) activeQuery = activeQuery.eq('project_id', projectId);
  if (roundId) activeQuery = activeQuery.eq('round_id', roundId);
  activeQuery = activeQuery.order('scheduled_for', { ascending: true }).limit(100);

  const { data: activeRows, error: activeErr } = await activeQuery;
  if (activeErr) {
    return errorResponse(`active jobs query failed: ${activeErr.message}`, 500, req);
  }

  // Recent terminal jobs: succeeded|failed|dead_letter within the window.
  // Order by finished_at DESC so the timeline is "newest first".
  let recentQuery = admin
    .from('shortlisting_jobs')
    .select(
      'id, project_id, round_id, kind, status, attempt_count, max_attempts, ' +
        'scheduled_for, started_at, finished_at, error_message',
    )
    .in('status', ['succeeded', 'failed', 'dead_letter'])
    .gte('finished_at', sinceIso);
  if (projectId) recentQuery = recentQuery.eq('project_id', projectId);
  if (roundId) recentQuery = recentQuery.eq('round_id', roundId);
  recentQuery = recentQuery.order('finished_at', { ascending: false }).limit(50);

  const { data: recentRows, error: recentErr } = await recentQuery;
  if (recentErr) {
    return errorResponse(`recent jobs query failed: ${recentErr.message}`, 500, req);
  }

  const activeJobRows = (activeRows as unknown as JobRow[] | null) ?? [];
  const recentJobRows = (recentRows as unknown as JobRow[] | null) ?? [];
  const allRows: JobRow[] = [...activeJobRows, ...recentJobRows];

  // Map to the response shape with computed fields.
  const jobs = allRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    attempt_count: r.attempt_count,
    max_attempts: r.max_attempts,
    scheduled_for: r.scheduled_for,
    started_at: r.started_at,
    finished_at: r.finished_at,
    wall_seconds: computeWallSeconds(r.started_at, r.finished_at, now),
    error_message_short: shortenError(r.error_message),
  }));

  // Tally counts. active_count = pending + running. succeeded_count and
  // failed_count are derived from the recent window only — hence "last
  // since_minutes" semantics in the UI.
  let pending = 0,
    running = 0,
    succeeded = 0,
    failed = 0,
    deadLetter = 0;
  for (const r of activeJobRows) {
    if (r.status === 'pending') pending += 1;
    else if (r.status === 'running') running += 1;
  }
  for (const r of recentJobRows) {
    if (r.status === 'succeeded') succeeded += 1;
    else if (r.status === 'failed') failed += 1;
    else if (r.status === 'dead_letter') deadLetter += 1;
  }

  const tick = nextDispatcherTick(now);

  return jsonResponse(
    {
      ok: true,
      jobs,
      next_dispatcher_tick_iso: tick.toISOString(),
      active_count: pending + running,
      pending_count: pending,
      running_count: running,
      succeeded_count: succeeded,
      failed_count: failed + deadLetter, // operator UX: dead_letter shown alongside failed
      dead_letter_count: deadLetter,
      since_minutes: sinceMinutes,
      server_time_iso: now.toISOString(),
    },
    200,
    req,
  );
});

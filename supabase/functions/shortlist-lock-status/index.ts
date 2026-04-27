/**
 * shortlist-lock-status
 * ─────────────────────
 * Wave 7 P0-1: status endpoint for the swimlane's LockProgressDialog.
 *
 * Returns the latest shortlisting_lock_progress row for a round so the
 * frontend can render a real progress bar while the background batch-move
 * poll runs in shortlist-lock. The dialog calls this every ~2.5s via
 * TanStack Query.
 *
 * Returns `progress: null` if no row exists for this round (round was never
 * lock-attempted, OR was locked under the old per-file path before
 * Wave 7 P0-1 shipped). Frontend treats null as "no in-flight lock".
 *
 * POST { round_id }
 *
 * Auth: master_admin / admin / manager OR service_role.
 *
 * Response:
 *   {
 *     ok: true,
 *     progress: {
 *       id, stage, async_job_id, total_moves, succeeded_moves,
 *       failed_moves, approved_count, rejected_count, last_polled_at,
 *       poll_attempt_count, error_message, errors_sample,
 *       started_at, completed_at,
 *       percent_complete: 0-100
 *     } | null
 *   }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'shortlist-lock-status';

interface StatusBody {
  round_id?: string;
  _health_check?: boolean;
}

interface ProgressRow {
  id: string;
  round_id: string;
  stage: string;
  async_job_id: string | null;
  total_moves: number;
  succeeded_moves: number;
  failed_moves: number;
  approved_count: number;
  rejected_count: number;
  last_polled_at: string | null;
  poll_attempt_count: number;
  error_message: string | null;
  errors_sample: unknown;
  started_at: string;
  completed_at: string | null;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden — only master_admin/admin/manager can read lock status', 403, req);
    }
  }

  let body: StatusBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id?.trim();
  if (!roundId) return errorResponse('round_id required', 400, req);

  const admin = getAdminClient();
  const { data, error } = await admin
    .from('shortlisting_lock_progress')
    .select(
      'id, round_id, stage, async_job_id, total_moves, succeeded_moves, failed_moves, approved_count, rejected_count, last_polled_at, poll_attempt_count, error_message, errors_sample, started_at, completed_at',
    )
    .eq('round_id', roundId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return errorResponse(`progress lookup failed: ${error.message}`, 500, req);
  }
  if (!data) {
    return jsonResponse({ ok: true, progress: null }, 200, req);
  }
  const row = data as ProgressRow;

  // Compute percent_complete. The semantics mirror what the frontend
  // displays: how many of the total moves have a definitive resolution.
  // For terminal states we return 100 (rounded to a clean number) — the UI
  // treats this as "done" regardless of how many actually succeeded vs
  // failed; the failed_moves counter is shown alongside.
  let percent_complete = 0;
  if (row.stage === 'complete') {
    percent_complete = 100;
  } else if (row.stage === 'failed') {
    // For failed, show how far we got at the time of failure. If we never
    // got moves resolved, that's 0. Don't pin to 100 — the UI distinguishes
    // failed-with-progress from failed-with-no-progress.
    percent_complete =
      row.total_moves > 0
        ? Math.min(100, Math.round(((row.succeeded_moves + row.failed_moves) / row.total_moves) * 100))
        : 0;
  } else if (row.total_moves > 0) {
    percent_complete = Math.min(
      99, // never report 100 for non-terminal stages
      Math.round(((row.succeeded_moves + row.failed_moves) / row.total_moves) * 100),
    );
  }

  return jsonResponse(
    {
      ok: true,
      progress: {
        id: row.id,
        stage: row.stage,
        async_job_id: row.async_job_id,
        total_moves: row.total_moves,
        succeeded_moves: row.succeeded_moves,
        failed_moves: row.failed_moves,
        approved_count: row.approved_count,
        rejected_count: row.rejected_count,
        last_polled_at: row.last_polled_at,
        poll_attempt_count: row.poll_attempt_count,
        error_message: row.error_message,
        errors_sample: row.errors_sample,
        started_at: row.started_at,
        completed_at: row.completed_at,
        percent_complete,
      },
    },
    200,
    req,
  );
});

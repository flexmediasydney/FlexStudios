/**
 * calibration-run-ai-batch — Wave 14 (W14) UI orchestrator wrapper.
 *
 * POST { calibration_session_id }
 *
 * Validates the calibration session + each round's lock state, then invokes
 * `shortlisting-benchmark-runner` with `trigger='calibration'` + the resolved
 * round_ids[]. Returns immediately (running=true) — the benchmark-runner does
 * the heavy lifting in parallel and writes calibration_decisions per-round
 * (see calibrationSessionMath.ts + benchmark-runner W14 extension).
 *
 * Per spec (W14-calibration-session.md §5 / R1-R12): v1 calibration sessions
 * draw from already-locked rounds. If a round in the session lacks
 * `confirmed_shortlist_group_ids`, return 422 with a helpful message ("round
 * X needs lock first — out of scope for v1, lock manually then retry").
 *
 * Auth: master_admin only (per spec R12 — gate session.create + run_ai_batch
 * to owner; admin can write inside a session via submit-shortlist /
 * submit-decisions, but kicking off the costly batch run is owner-only).
 *
 * Spec: docs/design-specs/W14-calibration-session.md
 * Migration: 407_w14_calibration_session.sql
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const FN_NAME = 'calibration-run-ai-batch';
const BENCHMARK_RUNNER_FN = 'shortlisting-benchmark-runner';

interface RequestBody {
  calibration_session_id?: string;
  _health_check?: boolean;
}

export interface SessionRow {
  id: string;
  status: string;
  selected_project_ids: string[] | null;
}

export interface RoundRow {
  id: string;
  project_id: string;
  status: string;
  confirmed_shortlist_group_ids: string[] | null;
  locked_at: string | null;
}

/**
 * Pure validation step shared by the handler + tests.
 * Returns one of:
 *   - { kind: 'ok', round_ids } — all selected projects have a locked round
 *     with confirmed_shortlist_group_ids populated.
 *   - { kind: 'missing_lock', project_ids } — at least one project has no
 *     locked round.
 *   - { kind: 'missing_confirmed', round_ids } — at least one locked round
 *     lacks confirmed_shortlist_group_ids.
 */
export type ValidationResult =
  | { kind: 'ok'; round_ids: string[] }
  | { kind: 'missing_lock'; project_ids: string[] }
  | { kind: 'missing_confirmed'; round_ids: string[] };

export function validateSessionRounds(
  selectedProjectIds: string[],
  rounds: RoundRow[],
): ValidationResult {
  // rounds expected pre-sorted desc by locked_at; pick most recent per project.
  const roundByProject = new Map<string, RoundRow>();
  for (const r of rounds) {
    if (!roundByProject.has(r.project_id)) {
      roundByProject.set(r.project_id, r);
    }
  }
  const missingLock: string[] = [];
  const missingConfirmed: string[] = [];
  const resolvedRoundIds: string[] = [];
  for (const pid of selectedProjectIds) {
    const row = roundByProject.get(pid);
    if (!row) {
      missingLock.push(pid);
      continue;
    }
    const cg = Array.isArray(row.confirmed_shortlist_group_ids)
      ? row.confirmed_shortlist_group_ids
      : [];
    if (cg.length === 0) {
      missingConfirmed.push(row.id);
      continue;
    }
    resolvedRoundIds.push(row.id);
  }
  if (missingLock.length > 0) {
    return { kind: 'missing_lock', project_ids: missingLock };
  }
  if (missingConfirmed.length > 0) {
    return { kind: 'missing_confirmed', round_ids: missingConfirmed };
  }
  return { kind: 'ok', round_ids: resolvedRoundIds };
}

export function formatMissingLockError(projectIds: string[]): string {
  const head = projectIds.slice(0, 5).join(', ');
  const tail =
    projectIds.length > 5 ? ` (+${projectIds.length - 5} more)` : '';
  return `Projects need locked rounds before AI batch (out of scope for v1, lock manually then retry): ${head}${tail}`;
}

export function formatMissingConfirmedError(roundIds: string[]): string {
  const head = roundIds.slice(0, 5).join(', ');
  const tail = roundIds.length > 5 ? ` (+${roundIds.length - 5} more)` : '';
  return `Round needs lock first — out of scope for v1, lock manually then retry: ${head}${tail}`;
}

serveWithAudit(FN_NAME, async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ── Auth: master_admin (or service_role) only ──────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse(
        'Forbidden — only master_admin can kick off a calibration AI batch',
        403,
        req,
      );
    }
  }

  // ── Body parse ─────────────────────────────────────────────────────────
  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body — fall through to validation */
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: FN_NAME }, 200, req);
  }

  const sessionId = body.calibration_session_id?.trim();
  if (!sessionId) {
    return errorResponse('calibration_session_id is required', 400, req);
  }

  const admin = getAdminClient();

  // ── Validate session exists ─────────────────────────────────────────────
  const { data: sess, error: sessErr } = await admin
    .from('calibration_sessions')
    .select('id, status, selected_project_ids')
    .eq('id', sessionId)
    .maybeSingle<SessionRow>();
  if (sessErr) {
    return errorResponse(`Session lookup failed: ${sessErr.message}`, 500, req);
  }
  if (!sess) {
    return errorResponse(
      `Calibration session ${sessionId} not found`,
      422,
      req,
    );
  }

  const projectIds = Array.isArray(sess.selected_project_ids)
    ? sess.selected_project_ids.filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      )
    : [];
  if (projectIds.length === 0) {
    return errorResponse(
      `Calibration session ${sessionId} has no selected_project_ids — add projects first`,
      422,
      req,
    );
  }

  // ── Resolve rounds: most recent locked round per project ────────────────
  const { data: rounds, error: rerr } = await admin
    .from('shortlisting_rounds')
    .select(
      'id, project_id, status, confirmed_shortlist_group_ids, locked_at',
    )
    .in('project_id', projectIds)
    .eq('status', 'locked')
    .order('locked_at', { ascending: false });
  if (rerr) {
    return errorResponse(`Round lookup failed: ${rerr.message}`, 500, req);
  }

  const validation = validateSessionRounds(
    projectIds,
    (rounds ?? []) as RoundRow[],
  );
  if (validation.kind === 'missing_lock') {
    return errorResponse(
      formatMissingLockError(validation.project_ids),
      422,
      req,
    );
  }
  if (validation.kind === 'missing_confirmed') {
    return errorResponse(
      formatMissingConfirmedError(validation.round_ids),
      422,
      req,
    );
  }
  const roundIds = validation.round_ids;

  // ── Flip session status → 'diff_phase' (best-effort; the next phase reads
  //    status to gate the diff-review tab). ─────────────────────────────
  await admin
    .from('calibration_sessions')
    .update({
      status: 'diff_phase',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);

  // ── Invoke benchmark-runner with calibration trigger ────────────────────
  // Fire-and-forget: the runner can take 60-95s for 50 rounds, well past the
  // 30s edge gateway hop on this wrapper. We invoke without awaiting the
  // body so this fn returns within ~1s and the runner continues server-side.
  // The runner writes calibration_decisions + stamps ai_run_completed_at on
  // each editor shortlist row as it goes (see benchmark-runner W14 block).
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    return errorResponse(
      'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing',
      500,
      req,
    );
  }

  const invokeUrl = `${supabaseUrl}/functions/v1/${BENCHMARK_RUNNER_FN}`;
  const invokeBody = {
    trigger: 'calibration',
    calibration_session_id: sessionId,
    round_ids: roundIds,
  };

  // Fire-and-forget — don't await response (runner is long-running). The
  // caller polls calibration_editor_shortlists.ai_run_completed_at + the
  // calibration_decisions row count to see progress.
  fetch(invokeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'x-caller-context': FN_NAME,
    },
    body: JSON.stringify(invokeBody),
  }).catch((err) => {
    console.error(`[${FN_NAME}] benchmark-runner invocation failed:`, err);
  });

  return jsonResponse(
    {
      ok: true,
      session_id: sessionId,
      status: 'running',
      rounds_dispatched: roundIds.length,
      round_ids: roundIds,
    },
    200,
    req,
  );
});

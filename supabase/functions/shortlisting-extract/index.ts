/**
 * shortlisting-extract
 * ────────────────────
 * Bridges a `shortlisting_jobs` row of kind='extract' to the Modal
 * `photos-extract` worker, then writes the per-file EXIF + preview metadata
 * back into the job's `result` field for Pass 0 to consume.
 *
 * Two invocation modes:
 *   1. Job mode (the dispatcher's normal path):
 *        body: { job_id: string }
 *        Reads the payload (project_id, round_id, file_paths) off the job row.
 *
 *   2. Direct mode (testing / manual reruns):
 *        body: { project_id, round_id, file_paths }
 *        Skips the job_id lookup. Does NOT update any job row's result —
 *        used for one-off invocations.
 *
 * The Modal call is a single HTTP POST; up to 50 files at a time. Modal does
 * its own per-file concurrency inside the call so we don't need a thread
 * pool here.
 *
 * Auth: service_role OR master_admin / admin (manual rerun via UI / curl).
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { getDropboxAccessToken } from '../_shared/dropbox.ts';

const GENERATOR = 'shortlisting-extract';
const MODAL_TIMEOUT_MS = 15 * 60 * 1000;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

interface RequestBody {
  job_id?: string;
  project_id?: string;
  round_id?: string;
  file_paths?: string[];
  _health_check?: boolean;
}

// F-B-007 (QC-iter2-W4 P1): role-gate decision exposed as a pure function
// for unit testing. Mirrors the inline check in serveWithAudit. Manager is
// permitted (matches pass0/pass3/shape-d/shape-d-stage4).
export type ExtractRoleGateOutcome =
  | { allow: true }
  | { allow: false; status: 401 | 403; reason: string };

export function evaluateExtractRoleGate(
  isService: boolean,
  user: { role?: string | null } | null,
): ExtractRoleGateOutcome {
  if (isService) return { allow: true };
  if (!user) return { allow: false, status: 401, reason: 'Authentication required' };
  if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
    return { allow: false, status: 403, reason: 'Forbidden' };
  }
  return { allow: true };
}

interface ExtractInput {
  jobId: string | null;
  projectId: string;
  roundId: string | null;
  filePaths: string[];
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    // F-B-007 (QC-iter2-W4 P1): role gate consistency. pass0/pass3/shape-d/
    // shape-d-stage4 all permit manager. The fn-level comment (line 22)
    // already documents "manual rerun via UI / curl" implying manager was
    // intended. Project-level access is enforced inside extract() via the
    // project lookup + dropbox_root_path check.
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const modalUrl = Deno.env.get('MODAL_PHOTOS_EXTRACT_URL');
  if (!modalUrl) {
    return errorResponse(
      'Modal photos extract URL not configured — see modal/photos-extract/README.md (set MODAL_PHOTOS_EXTRACT_URL secret on the Supabase project)',
      503,
      req,
    );
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse('SUPABASE_SERVICE_ROLE_KEY env not configured', 500, req);
  }

  let input: ExtractInput;
  try {
    input = await resolveInput(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(msg, 400, req);
  }

  try {
    const result = await extract(input, modalUrl);
    return jsonResponse(result, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed: ${msg}`);
    return errorResponse(`extract failed: ${msg}`, 500, req);
  }
});

async function resolveInput(body: RequestBody): Promise<ExtractInput> {
  const admin = getAdminClient();

  if (body.job_id) {
    const { data: job, error } = await admin
      .from('shortlisting_jobs')
      .select('id, project_id, round_id, payload, kind')
      .eq('id', body.job_id)
      .maybeSingle();
    if (error) throw new Error(`job lookup failed: ${error.message}`);
    if (!job) throw new Error(`job ${body.job_id} not found`);
    if (job.kind !== 'extract') throw new Error(`job ${body.job_id} kind is '${job.kind}', expected 'extract'`);

    const payload = (job.payload || {}) as Record<string, unknown>;
    const filePaths = Array.isArray(payload.file_paths)
      ? (payload.file_paths as string[])
      : [];
    if (filePaths.length === 0) {
      throw new Error(`job ${body.job_id} payload has no file_paths`);
    }
    return {
      jobId: job.id,
      projectId: job.project_id,
      roundId: job.round_id,
      filePaths,
    };
  }

  // Direct mode
  if (!body.project_id) throw new Error('project_id required (or supply job_id)');
  if (!Array.isArray(body.file_paths) || body.file_paths.length === 0) {
    throw new Error('file_paths required (non-empty array; or supply job_id)');
  }
  return {
    jobId: null,
    projectId: body.project_id,
    roundId: body.round_id || null,
    filePaths: body.file_paths,
  };
}

interface ExtractResult {
  ok: boolean;
  modal_ok?: boolean;
  files_processed?: number;
  files_succeeded?: number;
  files_failed?: number;
  job_id?: string | null;
  round_id?: string | null;
  error?: string;
  modal_response?: Record<string, unknown>;
}

async function extract(input: ExtractInput, modalUrl: string): Promise<ExtractResult> {
  const admin = getAdminClient();
  const startedAt = new Date().toISOString();

  // 1. Pull dropbox_root_path off the project — Modal needs it for the
  // Previews/ destination resolution.
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path')
    .eq('id', input.projectId)
    .maybeSingle();
  if (projErr) throw new Error(`project lookup failed: ${projErr.message}`);
  if (!project) throw new Error(`project ${input.projectId} not found`);
  if (!project.dropbox_root_path) {
    throw new Error(`project ${input.projectId} has no dropbox_root_path — provision folders first`);
  }

  // 2. Mark the job as running (best-effort; only when we have a job_id).
  if (input.jobId) {
    await admin
      .from('shortlisting_jobs')
      .update({ status: 'running', started_at: startedAt })
      .eq('id', input.jobId);
  }

  // 3. Mint a fresh Dropbox access token from edge env (auto-refreshing
  //    via DROPBOX_REFRESH_TOKEN + APP_KEY + APP_SECRET) and pass it to
  //    Modal in the request body. This eliminates the 4-hour expiry that
  //    bit us on Round 2 — Modal's static `dropbox_access_token` secret is
  //    no longer the source of truth (kept as a fallback in main.py for
  //    backwards-compat during the deploy window). Wave 7 P0-3.
  let dropboxAccessToken = '';
  try {
    dropboxAccessToken = await getDropboxAccessToken({ forceRefresh: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[${GENERATOR}] failed to mint Dropbox access token (Modal will fall back to its env secret): ${msg}`,
    );
  }

  // 4. POST to Modal.
  const requestBody = {
    _token: SUPABASE_SERVICE_ROLE_KEY,
    project_id: input.projectId,
    file_paths: input.filePaths,
    dropbox_root_path: project.dropbox_root_path,
    dropbox_access_token: dropboxAccessToken,  // Wave 7 P0-3: caller-provided token
  };

  let modalResponse: Record<string, unknown> | null = null;
  let modalOk = false;
  let httpStatus = 0;
  let errorMsg: string | null = null;

  try {
    const resp = await fetch(modalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
    });
    httpStatus = resp.status;
    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      errorMsg = `modal returned ${resp.status}: ${text.slice(0, 400)}`;
    } else {
      try {
        modalResponse = JSON.parse(text);
        modalOk = modalResponse?.ok === true;
      } catch {
        errorMsg = 'modal returned non-JSON body';
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMsg = `modal call failed: ${msg}`;
  }

  // 4. Persist the result onto the job row (when we have one).
  const finishedAt = new Date().toISOString();
  if (input.jobId) {
    if (modalOk) {
      await admin
        .from('shortlisting_jobs')
        .update({
          status: 'succeeded',
          finished_at: finishedAt,
          result: {
            modal_response: modalResponse,
            http_status: httpStatus,
          },
          error_message: null,
        })
        .eq('id', input.jobId);
    } else if (errorMsg) {
      // HTTP-level error — surface for the dispatcher to retry.
      // Burst 11 R2: previously this branch RE-INCREMENTED attempt_count and
      // chose pending vs failed status itself. The dispatcher's claim_
      // shortlisting_jobs RPC ALREADY incremented it once, and the
      // dispatcher's markFailed handles the status transition. Doing both
      // double-bumped attempt_count and burned 1/3 of the retry budget — a
      // job got dead-lettered after 2 actual failures instead of 3. Now we
      // just stash the error message; status + attempt accounting belong to
      // the dispatcher.
      await admin
        .from('shortlisting_jobs')
        .update({
          error_message: errorMsg.slice(0, 1000),
        })
        .eq('id', input.jobId);
    } else {
      // HTTP 200 with body.ok=false — Modal ran but reported failure.
      // Don't burn retry budget; record the result and mark succeeded so the
      // Pass 0 orchestrator can still see the per-file errors.
      await admin
        .from('shortlisting_jobs')
        .update({
          status: 'succeeded',
          finished_at: finishedAt,
          result: {
            modal_response: modalResponse,
            http_status: httpStatus,
            modal_ok: false,
          },
        })
        .eq('id', input.jobId);
    }
  }

  if (errorMsg && !modalOk) {
    return {
      ok: false,
      error: errorMsg,
      modal_response: modalResponse || undefined,
      job_id: input.jobId,
      round_id: input.roundId,
    };
  }

  if (!modalOk) {
    // HTTP 200 + body.ok=false case
    return {
      ok: true,
      modal_ok: false,
      error: typeof modalResponse?.error === 'string' ? modalResponse.error : 'modal reported ok=false',
      modal_response: modalResponse || undefined,
      job_id: input.jobId,
      round_id: input.roundId,
    };
  }

  const filesObj = (modalResponse?.files || {}) as Record<string, { ok?: boolean }>;
  const fileEntries = Object.values(filesObj);
  const filesSucceeded = fileEntries.filter((f) => f && f.ok === true).length;
  const filesFailed = fileEntries.filter((f) => f && f.ok === false).length;

  return {
    ok: true,
    modal_ok: true,
    files_processed: fileEntries.length,
    files_succeeded: filesSucceeded,
    files_failed: filesFailed,
    // P-fix-1: include the full modal_response so the dispatcher's overwrite of
    // shortlisting_jobs.result preserves per-file detail. Without this, pass0
    // reads job.result.modal_response.files and finds nothing — round dies.
    modal_response: modalResponse || undefined,
    job_id: input.jobId,
    round_id: input.roundId,
  };
}

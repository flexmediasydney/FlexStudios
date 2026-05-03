/**
 * shortlisting-preflight
 * ──────────────────────
 * Fail-fast pre-flight check run before a shortlisting Round is fired,
 * to catch transient external dependency outages (Dropbox rate-limits,
 * Modal cold-start failures, Gemini quota exhaustion, Storage outages)
 * BEFORE the engine creates 50+ extract jobs that would all silent-hang.
 *
 * Catastrophic failure modes this prevents:
 *   - Dropbox /files API bucket rate-limited → 30min of extract jobs all
 *     hang inside Modal's ThreadPoolExecutor (verified production incident,
 *     2026-05-03).
 *   - Modal cold-start fails (rare; tier outage) → every chunk dispatcher
 *     fires errors out simultaneously.
 *   - Gemini quota exhausted → every shape-d/pass3 job 429s.
 *   - Supabase Storage unreachable → preview uploads fail with retry-loop.
 *
 * A 3-second pre-flight catches all four. The dispatcher / engine should
 * call this once on Round-fire and refuse to start if any check fails.
 *
 * Probes (run in parallel via Promise.allSettled, 3s each, 10s wall):
 *   1. Dropbox /users API bucket  — GET /users/get_current_account
 *   2. Dropbox /files API bucket  — POST /files/list_folder limit:1
 *      (separate per-bucket rate limit; the bucket extract actually uses)
 *   3. Modal photos-extract       — POST {_health_check: true}
 *   4. Gemini Generative Language — GET /v1beta/models
 *   5. Supabase Storage           — GET bucket info on shortlisting-previews
 *
 * Returns:
 *   200 + { ok: true,  checks, ms } when all green
 *   503 + { ok: false, checks, ms } when any check fails
 *
 * Auth: same pattern as shortlisting-extract — `getUserFromReq` detects a
 * service-role JWT (id='__service_role__'), or master_admin / admin /
 * manager for manual UI / curl invocations. As a Modal-style fast-path,
 * an optional body `_token` matching SUPABASE_SERVICE_ROLE_KEY also
 * authorises (used by upstream non-JWT callers like the dispatcher
 * shell-out path).
 *
 * Body (all fields optional):
 *   { project_id?: string, _token?: string, _health_check?: boolean }
 *
 * project_id is currently informational — there is no project-scoped
 * Dropbox token; the env-level OAuth refresh flow services every project.
 * Reserved for future multi-tenant scoping.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { getDropboxAccessToken } from '../_shared/dropbox.ts';

const GENERATOR = 'shortlisting-preflight';

// Per-check timeout. 3s is generous for a healthy hop (median Dropbox
// /users round-trip is ~150ms, Modal warm-container HEAD is ~80ms,
// Gemini /models is ~200ms). A check exceeding 3s is itself a red flag —
// rate-limit hangs typically saturate the full 150s edge IDLE_TIMEOUT.
const PER_CHECK_TIMEOUT_MS = 3_000;

// Total wall budget for the pre-flight as a whole. We don't actually
// enforce this with an outer signal — all five checks are racing in
// parallel, each capped at PER_CHECK_TIMEOUT_MS, so worst-case is ~3s.
// The 10s value is the documented contract for the caller, not an
// internal cutoff.
const TOTAL_WALL_BUDGET_MS = 10_000;

const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';

interface RequestBody {
  project_id?: string;
  _token?: string;
  _health_check?: boolean;
}

interface CheckResult {
  ok: boolean;
  ms: number;
  status?: number;
  // 429 retry hints — we capture both header and body forms because they
  // sometimes diverge (Dropbox /users in particular). The larger value is
  // the real wait. See dropbox-auth-test for the prior art.
  retry_after_header?: string | null;
  x_dropbox_retry_after?: string | null;
  retry_after_body_s?: number;
  error?: string;
  // Free-form note for human reading in the dispatcher logs.
  detail?: string;
}

interface ChecksMap {
  dropbox_users: CheckResult;
  dropbox_files: CheckResult;
  modal: CheckResult;
  gemini: CheckResult;
  supabase_storage: CheckResult;
}

interface PreflightResponse {
  ok: boolean;
  checks: ChecksMap;
  ms: number;
  // The project_id from the request, echoed back for log correlation
  // when the dispatcher fans out checks per round.
  project_id?: string;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ── Auth ─────────────────────────────────────────────────────────────
  // Two valid auth forms (same as shortlisting-extract conceptually,
  // plus a Modal-style _token fast-path):
  //
  //   1. Authorization: Bearer <service-role JWT>  → user.id ='__service_role__'
  //   2. Authorization: Bearer <user JWT>          → user.role in {master_admin, admin, manager}
  //   3. Body { _token: SUPABASE_SERVICE_ROLE_KEY } → fast-path for non-JWT callers
  //
  // We parse the body up front so the _token path can short-circuit
  // before we burn a Supabase admin.auth.getUser() round-trip.
  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty / non-JSON body — treat as empty object */
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const tokenMatchesServiceRole =
    !!body._token && !!SUPABASE_SERVICE_ROLE_KEY && body._token === SUPABASE_SERVICE_ROLE_KEY;

  let isAuthorised = tokenMatchesServiceRole;
  if (!isAuthorised) {
    const user = await getUserFromReq(req).catch(() => null);
    const isService = user?.id === '__service_role__';
    if (isService) {
      isAuthorised = true;
    } else if (user && ['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      isAuthorised = true;
    }
  }
  if (!isAuthorised) {
    return errorResponse('Unauthorised', 401, req);
  }

  // ── Sanity-check critical env ────────────────────────────────────────
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse('SUPABASE_SERVICE_ROLE_KEY env not configured', 500, req);
  }
  if (!SUPABASE_URL) {
    return errorResponse('SUPABASE_URL env not configured', 500, req);
  }

  // ── Run all five probes in parallel ──────────────────────────────────
  const t0 = Date.now();

  // Mint a Dropbox token once; both Dropbox probes share it. If the
  // refresh itself fails, we synthesise failure verdicts for both
  // dropbox checks so the response reports the correct root cause
  // (auth, not the API endpoints themselves).
  let dropboxToken = '';
  let dropboxRefreshError: string | null = null;
  try {
    dropboxToken = await getDropboxAccessToken({ forceRefresh: false });
  } catch (err) {
    dropboxRefreshError = err instanceof Error ? err.message : String(err);
  }

  const checks = await runAllChecks({ dropboxToken, dropboxRefreshError, projectId: body.project_id });

  const ms = Date.now() - t0;
  const allOk =
    checks.dropbox_users.ok &&
    checks.dropbox_files.ok &&
    checks.modal.ok &&
    checks.gemini.ok &&
    checks.supabase_storage.ok;

  const response: PreflightResponse = {
    ok: allOk,
    checks,
    ms,
    project_id: body.project_id,
  };

  // 503 (Service Unavailable) on any-check-failed: standard retry-after
  // semantics, lets the dispatcher / cron back off rather than firing.
  // 200 on all-green so the caller can treat it as a simple boolean
  // health gate.
  return jsonResponse(response, allOk ? 200 : 503, req);
});

// ─── Probe runner ────────────────────────────────────────────────────────────

interface RunChecksInput {
  dropboxToken: string;
  dropboxRefreshError: string | null;
  projectId?: string;
}

async function runAllChecks(input: RunChecksInput): Promise<ChecksMap> {
  // Pre-failed Dropbox verdicts when the OAuth refresh itself died.
  // No point wasting 3s × 2 probing with an empty token.
  const dropboxAuthFailed = !input.dropboxToken || !!input.dropboxRefreshError;
  const dropboxAuthFailureVerdict = (endpoint: string): CheckResult => ({
    ok: false,
    ms: 0,
    error: input.dropboxRefreshError || 'Dropbox OAuth refresh produced empty token',
    detail: `dropbox auth failed before ${endpoint} probe could run`,
  });

  const probes: Promise<[keyof ChecksMap, CheckResult]>[] = [
    // 1. Dropbox /users API bucket — cheapest identity call
    (async (): Promise<[keyof ChecksMap, CheckResult]> => {
      if (dropboxAuthFailed) {
        return ['dropbox_users', dropboxAuthFailureVerdict('users/get_current_account')];
      }
      return ['dropbox_users', await probeDropbox(input.dropboxToken, 'users/get_current_account', null)];
    })(),

    // 2. Dropbox /files API bucket — separate per-bucket rate limit;
    //    this is the bucket extract actually consumes for downloads.
    (async (): Promise<[keyof ChecksMap, CheckResult]> => {
      if (dropboxAuthFailed) {
        return ['dropbox_files', dropboxAuthFailureVerdict('files/list_folder')];
      }
      return [
        'dropbox_files',
        await probeDropbox(input.dropboxToken, 'files/list_folder', { path: '', limit: 1, recursive: false }),
      ];
    })(),

    // 3. Modal photos-extract — _health_check fast-path
    (async (): Promise<[keyof ChecksMap, CheckResult]> => {
      return ['modal', await probeModal()];
    })(),

    // 4. Gemini Generative Language — list models is the cheapest authed call
    (async (): Promise<[keyof ChecksMap, CheckResult]> => {
      return ['gemini', await probeGemini()];
    })(),

    // 5. Supabase Storage — confirm shortlisting-previews bucket reachable
    (async (): Promise<[keyof ChecksMap, CheckResult]> => {
      return ['supabase_storage', await probeSupabaseStorage()];
    })(),
  ];

  const settled = await Promise.allSettled(probes);

  // Default skeleton — every probe reports either fulfilled or rejected.
  // A rejected probe (shouldn't happen given each helper catches) gets a
  // synthetic failed verdict so the response shape is always complete.
  const checks: ChecksMap = {
    dropbox_users: { ok: false, ms: 0, error: 'probe did not run' },
    dropbox_files: { ok: false, ms: 0, error: 'probe did not run' },
    modal: { ok: false, ms: 0, error: 'probe did not run' },
    gemini: { ok: false, ms: 0, error: 'probe did not run' },
    supabase_storage: { ok: false, ms: 0, error: 'probe did not run' },
  };

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      const [key, verdict] = result.value;
      checks[key] = verdict;
    } else {
      // Synthetic — a probe helper threw uncaught. Try to attach the
      // error to *some* slot if we can guess from the message; otherwise
      // it shows up as "probe did not run" above.
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`[${GENERATOR}] probe rejected (uncaught): ${msg}`);
    }
  }

  return checks;
}

// ─── Probe: Dropbox ──────────────────────────────────────────────────────────

/**
 * Probe a Dropbox API endpoint and return a structured verdict.
 * Mirrors the dropbox-auth-test pattern (rate-limit-aware) but with a
 * tighter timeout for pre-flight gating.
 */
async function probeDropbox(
  token: string,
  endpoint: string,
  bodyArg: unknown,
): Promise<CheckResult> {
  const t = Date.now();
  // Pass team-namespace header on /files calls — without it the call
  // hits the wrong root and returns spurious "not_found", which would
  // be a false-positive failure verdict. /users doesn't need it.
  const namespace = Deno.env.get('DROPBOX_TEAM_NAMESPACE_ID');
  const namespaceHeader: Record<string, string> =
    namespace && endpoint.startsWith('files/')
      ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: namespace }) }
      : {};

  try {
    const resp = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        ...namespaceHeader,
        ...(bodyArg !== null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: bodyArg !== null ? JSON.stringify(bodyArg) : undefined,
      signal: AbortSignal.timeout(PER_CHECK_TIMEOUT_MS),
    });
    const text = await resp.text().catch(() => '');
    const out: CheckResult = {
      ok: resp.ok,
      ms: Date.now() - t,
      status: resp.status,
      retry_after_header: resp.headers.get('Retry-After'),
      x_dropbox_retry_after:
        resp.headers.get('X-Dropbox-Retry-After') ?? resp.headers.get('x-ratelimit-retry-after'),
    };
    if (!resp.ok) {
      out.error = `dropbox ${endpoint} returned ${resp.status}: ${text.slice(0, 200)}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.retry_after !== undefined) {
          out.retry_after_body_s = parsed.error.retry_after;
        }
      } catch {
        /* ignore non-JSON body */
      }
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ms: Date.now() - t,
      error: `dropbox ${endpoint} probe failed: ${msg}`,
    };
  }
}

// ─── Probe: Modal ─────────────────────────────────────────────────────────────

/**
 * Probe Modal photos-extract via its standard _health_check fast-path.
 * Modal's extract_http already short-circuits on `_token` mismatch with
 * a 401, so a successful health probe needs the service-role token. We
 * accept either:
 *   - HTTP 200 with {ok: ...}              → fully healthy
 *   - HTTP 401 "invalid or missing _token" → endpoint reachable but auth
 *     failed; this still proves Modal is up. We treat this as ok=true
 *     with detail=auth_failed_but_reachable so the caller can distinguish
 *     "Modal is down" from "your secret is wrong."
 *
 * Why it matters: a Modal cold-start failure or app-deploy failure
 * returns a 5xx or hangs past PER_CHECK_TIMEOUT_MS — both are caught.
 * A 401 just means the secret rotated, which the engine should surface
 * separately rather than refusing to fire the round.
 */
async function probeModal(): Promise<CheckResult> {
  const t = Date.now();
  const modalUrl = Deno.env.get('MODAL_PHOTOS_EXTRACT_URL');
  if (!modalUrl) {
    return {
      ok: false,
      ms: 0,
      error: 'MODAL_PHOTOS_EXTRACT_URL env not configured',
    };
  }
  try {
    const resp = await fetch(modalUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      // Minimal body — Modal's extract_http validates project_id +
      // file_paths early. We send `_health_check: true` to align with
      // our edge-fn convention; if Modal doesn't honour it (currently it
      // doesn't have a special branch), it'll return a 400 about
      // missing project_id which still proves the endpoint is alive.
      body: JSON.stringify({
        _token: SUPABASE_SERVICE_ROLE_KEY,
        _health_check: true,
      }),
      signal: AbortSignal.timeout(PER_CHECK_TIMEOUT_MS),
    });
    const text = await resp.text().catch(() => '');
    const ms = Date.now() - t;

    // 200 = healthy. 400 (missing project_id) = endpoint reachable, app
    // is up — treat as healthy for pre-flight purposes. 401 = same
    // (secret mismatch is its own problem). 5xx or timeout = real
    // outage, fail.
    if (resp.status === 200) {
      return { ok: true, ms, status: resp.status };
    }
    if (resp.status === 400 || resp.status === 401) {
      return {
        ok: true,
        ms,
        status: resp.status,
        detail: 'modal endpoint reachable; non-200 response is expected for health-probe payload',
      };
    }
    return {
      ok: false,
      ms,
      status: resp.status,
      error: `modal returned ${resp.status}: ${text.slice(0, 200)}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ms: Date.now() - t,
      error: `modal probe failed: ${msg}`,
    };
  }
}

// ─── Probe: Gemini ────────────────────────────────────────────────────────────

/**
 * Probe the Gemini Generative Language API by listing models — cheapest
 * authed endpoint (no token billing, no rate-limit cost). 429 here means
 * quota exhausted, which is exactly the condition we want to fail-fast
 * on before shape-d / pass3 jobs blow out the round's retry budget.
 */
async function probeGemini(): Promise<CheckResult> {
  const t = Date.now();
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return {
      ok: false,
      ms: 0,
      error: 'GEMINI_API_KEY env not configured',
    };
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(PER_CHECK_TIMEOUT_MS),
    });
    const text = await resp.text().catch(() => '');
    const out: CheckResult = {
      ok: resp.ok,
      ms: Date.now() - t,
      status: resp.status,
      retry_after_header: resp.headers.get('Retry-After'),
    };
    if (!resp.ok) {
      out.error = `gemini /v1beta/models returned ${resp.status}: ${text.slice(0, 200)}`;
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ms: Date.now() - t,
      error: `gemini probe failed: ${msg}`,
    };
  }
}

// ─── Probe: Supabase Storage ─────────────────────────────────────────────────

/**
 * Probe Supabase Storage by hitting the bucket-info endpoint for
 * shortlisting-previews. We use the REST endpoint directly (rather than
 * the JS SDK) to keep the timeout strict and the response shape obvious.
 *
 * A 200 confirms:
 *   - storage gateway is up,
 *   - service-role key is valid,
 *   - bucket exists and is readable.
 *
 * Anything else (404 = bucket missing, 5xx = gateway issue, timeout =
 * outage) fails the verdict.
 */
async function probeSupabaseStorage(): Promise<CheckResult> {
  const t = Date.now();
  const bucket = 'shortlisting-previews';
  try {
    const resp = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${bucket}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
      },
      signal: AbortSignal.timeout(PER_CHECK_TIMEOUT_MS),
    });
    const text = await resp.text().catch(() => '');
    const out: CheckResult = {
      ok: resp.ok,
      ms: Date.now() - t,
      status: resp.status,
    };
    if (!resp.ok) {
      out.error = `supabase storage bucket lookup returned ${resp.status}: ${text.slice(0, 200)}`;
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ms: Date.now() - t,
      error: `supabase storage probe failed: ${msg}`,
    };
  }
}

// Re-export the constant so external smoke tests can pin the documented
// wall budget. Not used inside this module.
export const PREFLIGHT_TOTAL_WALL_BUDGET_MS = TOTAL_WALL_BUDGET_MS;

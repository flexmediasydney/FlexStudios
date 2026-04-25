/**
 * drone-job-dispatcher
 * ────────────────────
 * Pulls pending `drone_jobs` and dispatches them to the appropriate handler:
 *
 *   kind='ingest'           → POST to drone-ingest    payload: { project_id }
 *   kind='render'           → POST to drone-render    payload: { shoot_id, kind?, fallback? }
 *   kind='sfm' / 'sfm_run'  → POST to Modal sfm_http  payload: { _token, shoot_id }
 *
 *     On SfM success the dispatcher chains a follow-up `kind='render'` job
 *     (debounced ~10s) for the same shoot, so the next dispatcher tick will
 *     render with the now-valid sfm_pose values. Chained at the dispatcher
 *     layer rather than inside the Modal endpoint to keep all queue logic
 *     in one place (and so retries of the SfM job don't re-fan-out renders).
 *
 * Trigger: pg_cron every minute (migration 232).
 *
 * Per-invocation: pulls up to 10 pending jobs ordered by scheduled_for.
 * For each: marks status='running', dispatches via fetch, then updates to
 * 'succeeded' or 'failed' based on response. Failed jobs back off
 * exponentially (attempt 1: now+1min, 2: +5min, 3: +30min). After 3 failed
 * attempts a job is marked 'dead'.
 *
 * Auth: __service_role__ (cron) OR master_admin (manual trigger).
 * Deployed verify_jwt=false; auth via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from "../_shared/supabase.ts";

const GENERATOR = "drone-job-dispatcher";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "https://rjzdznwkxnzfekgcdkei.supabase.co";
const MODAL_SFM_URL =
  Deno.env.get("MODAL_SFM_URL") ||
  "https://joseph-89037--flexstudios-drone-sfm-sfm-http.modal.run";
const SFM_HTTP_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — matches Modal function timeout
const MAX_JOBS_PER_RUN = 10;
const MAX_ATTEMPTS = 3;

// Backoff seconds: attempt 1 fail → +60s, attempt 2 → +300s, attempt 3 → +1800s
const BACKOFF_SECONDS = [60, 300, 1800];

type DroneJob = {
  id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  scheduled_for: string;
  shoot_id: string | null;
};

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === "__service_role__";
  if (!isService) {
    if (!user) return errorResponse("Authentication required", 401, req);
    if (user.role !== "master_admin") return errorResponse("Forbidden", 403, req);
  }

  let body: { _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse({ _version: "v1.0", _fn: GENERATOR }, 200, req);
  }

  const admin = getAdminClient();
  const startedAt = Date.now();

  // ── Atomically claim up to N pending jobs ──────────────────────────────
  // Use a SELECT ... FOR UPDATE SKIP LOCKED via SQL to avoid double-dispatch.
  const { data: claimed, error: claimErr } = await admin.rpc("claim_drone_jobs", {
    p_limit: MAX_JOBS_PER_RUN,
  });

  if (claimErr) {
    return errorResponse(`claim_drone_jobs failed: ${claimErr.message}`, 500, req);
  }

  const jobs: DroneJob[] = claimed || [];
  if (jobs.length === 0) {
    return jsonResponse(
      { success: true, claimed: 0, dispatched: 0, failed: 0, elapsed_ms: Date.now() - startedAt },
      200,
      req,
    );
  }

  let dispatched = 0;
  let failed = 0;
  const results: Array<{ id: string; kind: string; ok: boolean; error?: string }> = [];

  for (const job of jobs) {
    try {
      const ok = await dispatchOne(admin, job);
      if (ok.ok) {
        await admin
          .from("drone_jobs")
          .update({
            status: "succeeded",
            finished_at: new Date().toISOString(),
            error_message: null,
            result: ok.result ?? null,
          })
          .eq("id", job.id);
        dispatched++;
        results.push({ id: job.id, kind: job.kind, ok: true });

        // Chain: on a successful SfM dispatch where Modal also reported a
        // valid reconstruction, enqueue a follow-up render job for the same
        // shoot. The next dispatcher tick will render with the now-populated
        // drone_shots.sfm_pose values. Shoots that exit cleanly with too few
        // images (Modal returns ok=false but HTTP 200) do NOT trigger a
        // chained render — they remain at status='sfm_failed' for review.
        if ((job.kind === "sfm_run" || job.kind === "sfm") && ok.sfm_ok === true) {
          const shootId =
            (job.payload?.shoot_id as string | undefined) || job.shoot_id;
          if (shootId) {
            const scheduled = new Date(Date.now() + 10_000).toISOString();
            const { error: enqErr } = await admin.from("drone_jobs").insert({
              project_id: (job.payload?.project_id as string | null) ?? null,
              shoot_id: shootId,
              kind: "render",
              status: "pending",
              payload: {
                shoot_id: shootId,
                kind: "poi_plus_boundary",
                chained_from: job.id,
              },
              scheduled_for: scheduled,
            });
            if (enqErr) {
              console.warn(
                `[${GENERATOR}] failed to chain render job after sfm ${job.id}: ${enqErr.message}`,
              );
            }
          }
        }
      } else {
        await markFailed(admin, job, ok.error || "unknown");
        failed++;
        results.push({ id: job.id, kind: job.kind, ok: false, error: ok.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(admin, job, msg);
      failed++;
      results.push({ id: job.id, kind: job.kind, ok: false, error: msg });
    }
  }

  return jsonResponse(
    {
      success: true,
      claimed: jobs.length,
      dispatched,
      failed,
      elapsed_ms: Date.now() - startedAt,
      results,
    },
    200,
    req,
  );
});

// ──────────────────────────────────────────────────────────────────────
// Result type carries optional `sfm_ok` (Modal-reported success) and `result`
// (small JSON blob persisted into drone_jobs.result for the SfM/render tick).
type DispatchResult = {
  ok: boolean;
  error?: string;
  sfm_ok?: boolean;
  result?: Record<string, unknown> | null;
};

async function dispatchOne(
  _admin: ReturnType<typeof getAdminClient>,
  job: DroneJob,
): Promise<DispatchResult> {
  switch (job.kind) {
    case "ingest":
      return await callEdgeFunction("drone-ingest", {
        project_id: job.payload?.project_id,
      });
    case "render":
      return await callEdgeFunction("drone-render", {
        shoot_id: job.payload?.shoot_id || job.shoot_id,
        kind: job.payload?.kind || "poi_plus_boundary",
        // Pass-through `reason` so drone-render can route Pin Editor saves
        // to the drone_renders_adjusted/ folder + adjustments column state.
        reason: job.payload?.reason,
      });
    // We accept both 'sfm_run' (legacy/dispatcher-canonical) and 'sfm' (the
    // value that drone-ingest enqueues per migration 225 CHECK constraint).
    case "sfm_run":
    case "sfm":
      return await callModalSfm({
        shoot_id: (job.payload?.shoot_id as string | undefined) || job.shoot_id,
      });
    default:
      return { ok: false, error: `unknown kind: ${job.kind}` };
  }
}

async function callModalSfm(args: {
  shoot_id: string | null | undefined;
}): Promise<DispatchResult> {
  if (!args.shoot_id) {
    return { ok: false, error: "callModalSfm: shoot_id missing on job" };
  }
  const renderToken = Deno.env.get("FLEXSTUDIOS_RENDER_TOKEN") || "";
  if (!renderToken) {
    return { ok: false, error: "FLEXSTUDIOS_RENDER_TOKEN not set" };
  }

  try {
    const resp = await fetch(MODAL_SFM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _token: renderToken, shoot_id: args.shoot_id }),
      // Long timeout — Modal pipeline can take several minutes for a real
      // nadir grid. The Edge Function's wall-clock cap (Deno) is enforced by
      // the platform; we set ours just in case.
      signal: AbortSignal.timeout(SFM_HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `sfm_http returned ${resp.status}: ${text.slice(0, 400)}`,
      };
    }
    let json: Record<string, unknown> = {};
    try {
      json = await resp.json();
    } catch {
      return { ok: false, error: "sfm_http returned non-JSON body" };
    }
    const sfmOk = json.ok === true;
    // We treat HTTP 200 with body.ok=false as a successful DISPATCH (we
    // talked to Modal cleanly), but the SfM run itself failed/skipped — the
    // Modal endpoint already wrote the failure to drone_sfm_runs and
    // drone_shoots.status. Don't retry the dispatcher; mark dispatcher
    // success but leave sfm_ok=false so chaining is suppressed.
    return { ok: true, sfm_ok: sfmOk, result: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `sfm_http call failed: ${msg}` };
  }
}

async function callEdgeFunction(
  fnName: string,
  body: Record<string, unknown>,
): Promise<DispatchResult> {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  // Prefer DRONE_DISPATCHER_JWT (a real Supabase JWT for service role).
  // SUPABASE_SERVICE_ROLE_KEY in this project's secrets store is a hashed
  // value, not a JWT, so it fails getUserFromReq's JWT-format check.
  const serviceKey =
    Deno.env.get("DRONE_DISPATCHER_JWT") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "";
  if (!serviceKey) {
    return { ok: false, error: "DRONE_DISPATCHER_JWT/SUPABASE_SERVICE_ROLE_KEY not set" };
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "x-caller-context": "drone-job-dispatcher",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `${fnName} returned ${resp.status}: ${text.slice(0, 300)}` };
    }

    // Body inspection: catch the case where the Edge Function returned 200
    // but its own work-unit-level result was a failure. drone-render and
    // drone-ingest both expose shots_total / shots_rendered (or similar)
    // in their response body — if shots_rendered === 0 with shots_total > 0,
    // that's a per-job failure even though HTTP was 200.
    try {
      const bodyJson = await resp.json();
      if (bodyJson && typeof bodyJson === "object") {
        if (
          typeof bodyJson.shots_total === "number" &&
          typeof bodyJson.shots_rendered === "number" &&
          bodyJson.shots_total > 0 &&
          bodyJson.shots_rendered === 0
        ) {
          // Pull a representative per-shot error if present.
          const firstErr = Array.isArray(bodyJson.results)
            ? bodyJson.results.find((r: { ok: boolean }) => r && r.ok === false)?.error
            : undefined;
          return {
            ok: false,
            error: `${fnName}: 0/${bodyJson.shots_total} shots rendered. ${
              firstErr ? `First error: ${String(firstErr).slice(0, 200)}` : ""
            }`.trim(),
          };
        }
        if (bodyJson.success === false) {
          return {
            ok: false,
            error: `${fnName}: success=false, error=${bodyJson.error || "unknown"}`,
          };
        }
      }
    } catch {
      // Not JSON — accept HTTP-200 as success.
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function markFailed(
  admin: ReturnType<typeof getAdminClient>,
  job: DroneJob,
  errMsg: string,
): Promise<void> {
  const nextAttempt = (job.attempt_count || 0) + 1;
  if (nextAttempt >= MAX_ATTEMPTS) {
    await admin
      .from("drone_jobs")
      .update({
        status: "dead",
        finished_at: new Date().toISOString(),
        error_message: errMsg.slice(0, 1000),
      })
      .eq("id", job.id);
  } else {
    const backoffSec = BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];
    const next = new Date(Date.now() + backoffSec * 1000).toISOString();
    await admin
      .from("drone_jobs")
      .update({
        status: "pending",
        scheduled_for: next,
        error_message: errMsg.slice(0, 1000),
      })
      .eq("id", job.id);
  }
}

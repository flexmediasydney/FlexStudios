/**
 * drone-job-dispatcher
 * ────────────────────
 * Pulls pending `drone_jobs` and dispatches them to the appropriate handler:
 *
 *   kind='ingest'   → POST to drone-ingest      payload: { project_id }
 *   kind='render'   → POST to drone-render      payload: { shoot_id, kind?, fallback? }
 *   kind='sfm_run'  → DEFERRED for now (Stream C SfM worker has no HTTP entry)
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
          .update({ status: "succeeded", finished_at: new Date().toISOString(), error_message: null })
          .eq("id", job.id);
        dispatched++;
        results.push({ id: job.id, kind: job.kind, ok: true });
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
async function dispatchOne(
  _admin: ReturnType<typeof getAdminClient>,
  job: DroneJob,
): Promise<{ ok: boolean; error?: string }> {
  switch (job.kind) {
    case "ingest":
      return await callEdgeFunction("drone-ingest", {
        project_id: job.payload?.project_id,
      });
    case "render":
      return await callEdgeFunction("drone-render", {
        shoot_id: job.payload?.shoot_id || job.shoot_id,
        kind: job.payload?.kind || "poi_plus_boundary",
      });
    case "sfm_run":
      // Deferred: SfM worker has no HTTP endpoint. Mark as 'deferred' and bail.
      // (Implementation note: add @modal.fastapi_endpoint to sfm_worker.py
      //  in a follow-up to enable dispatching here.)
      return {
        ok: false,
        error:
          "sfm_run dispatch not yet implemented (Modal SfM worker has no HTTP entry — deferred to follow-up)",
      };
    default:
      return { ok: false, error: `unknown kind: ${job.kind}` };
  }
}

async function callEdgeFunction(
  fnName: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceKey) {
    return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set" };
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

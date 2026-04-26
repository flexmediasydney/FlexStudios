/**
 * shortlisting-job-dispatcher
 * ───────────────────────────
 * Pulls pending `shortlisting_jobs` and dispatches them to the appropriate
 * Edge Function handler:
 *
 *   kind='ingest'  → POST shortlisting-ingest    payload: { job_id }
 *   kind='extract' → POST shortlisting-extract   payload: { job_id }
 *   kind='pass0'   → POST shortlisting-pass0     payload: { job_id }
 *   kind='pass1'   → POST shortlisting-pass1     payload: { job_id }
 *   kind='pass2'   → POST shortlisting-pass2     payload: { job_id }
 *   kind='pass3'   → POST shortlisting-pass3     payload: { job_id }
 *
 *     Chain: ingest → (ingest internally enqueues N×extract) → pass0 → pass1
 *            → pass2 → pass3 (terminal — pass3 fires the notification).
 *
 *     The dispatcher does NOT chain after `ingest`. shortlisting-ingest
 *     enqueues its own extract chunks (mig 284 §7) so the dispatcher would
 *     duplicate work.
 *
 *     `extract` is the only fan-out kind: a round can have N extract jobs
 *     (chunked at 50 files in shortlisting-ingest). The dispatcher only
 *     enqueues the round's `pass0` job once ALL extract jobs for the round
 *     are succeeded (no pending/running siblings remain). Without that gate,
 *     a 4-chunk round would enqueue pass0 four times.
 *
 *     pass0 → pass1 → pass2 → pass3 are 1:1 chains; each success enqueues
 *     the next kind for the same round_id (scheduled_for=NOW()).
 *
 * Trigger: pg_cron every minute (migration 292).
 *
 * Per-invocation: pulls up to 10 pending jobs ordered by scheduled_for. For
 * each: marks status='running' (via claim_shortlisting_jobs), dispatches via
 * fetch, then updates to 'succeeded' or 'failed' based on response. Failed
 * jobs back off exponentially (attempt 1: now+60s, 2: +300s, 3: +1800s).
 * After 3 failed attempts a job is marked 'dead_letter'.
 *
 * Stale-claim recovery: any job stuck in 'running' for >20 minutes is reset
 * to 'pending' with attempt_count refunded. Mirrors the drone dispatcher
 * fix for Edge-Function timeouts that would otherwise burn the retry budget.
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

const GENERATOR = "shortlisting-job-dispatcher";
const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") || "https://rjzdznwkxnzfekgcdkei.supabase.co";
const MAX_JOBS_PER_RUN = 10;
const MAX_ATTEMPTS = 3;

// Backoff seconds: attempt 1 fail → +60s, attempt 2 → +300s, attempt 3 → +1800s
const BACKOFF_SECONDS = [60, 300, 1800];

// Stale-claim sweep — any job stuck in 'running' for >20 minutes is reset.
const STALE_CLAIM_MIN = 20;

type ShortlistingJob = {
  id: string;
  // claim_shortlisting_jobs() (mig 288) returns project_id + round_id +
  // group_id directly so chain logic doesn't need per-claim lookups.
  project_id: string | null;
  round_id: string | null;
  group_id: string | null;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  scheduled_for: string;
};

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === "__service_role__";
  if (!isService) {
    if (!user) return errorResponse("Authentication required", 401, req);
    if (!["master_admin", "admin"].includes(user.role || "")) {
      return errorResponse("Forbidden", 403, req);
    }
  }

  let body: { _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK — cron sends no body */
  }
  if (body._health_check) {
    return jsonResponse({ _version: "v1.0", _fn: GENERATOR }, 200, req);
  }

  const admin = getAdminClient();
  const startedAt = Date.now();

  // ── Reset stale 'running' jobs back to 'pending'. Edge Function crashes
  // (panic, OOM, gateway timeout) leave claimed jobs stuck in 'running'
  // forever. Anything still 'running' after STALE_CLAIM_MIN minutes gets
  // requeued. claim_shortlisting_jobs() already incremented attempt_count
  // when it claimed the job, so the sweep refunds the attempt via the
  // shortlisting_jobs_decrement_attempts RPC (mig 292) so platform timeouts
  // don't burn the retry budget. Mirrors drone-job-dispatcher (audit #30).
  const { data: stale } = await admin
    .from("shortlisting_jobs")
    .update({ status: "pending", started_at: null })
    .eq("status", "running")
    .lt(
      "started_at",
      new Date(Date.now() - STALE_CLAIM_MIN * 60 * 1000).toISOString(),
    )
    .select("id");
  if ((stale?.length ?? 0) > 0) {
    const ids = stale!.map((r) => r.id);
    const { error: decErr } = await admin.rpc(
      "shortlisting_jobs_decrement_attempts",
      { p_ids: ids },
    );
    if (decErr) {
      console.warn(
        `[${GENERATOR}] reset ${stale!.length} stale-claim job(s) older than ${STALE_CLAIM_MIN}m, but attempt-decrement RPC failed: ${decErr.message}`,
      );
    } else {
      console.warn(
        `[${GENERATOR}] reset ${stale!.length} stale-claim job(s) older than ${STALE_CLAIM_MIN}m and refunded their attempt`,
      );
    }
  }

  // ── Atomically claim up to N pending jobs ─────────────────────────────────
  // claim_shortlisting_jobs (mig 288) does the FOR UPDATE SKIP LOCKED dance
  // and returns project_id/round_id/group_id alongside id/kind/payload so we
  // don't need per-claim follow-up lookups in the chain logic.
  const { data: claimed, error: claimErr } = await admin.rpc(
    "claim_shortlisting_jobs",
    { p_limit: MAX_JOBS_PER_RUN },
  );

  if (claimErr) {
    return errorResponse(`claim_shortlisting_jobs failed: ${claimErr.message}`, 500, req);
  }

  const jobs: ShortlistingJob[] = claimed || [];
  if (jobs.length === 0) {
    return jsonResponse(
      {
        success: true,
        claimed: 0,
        dispatched: 0,
        failed: 0,
        elapsed_ms: Date.now() - startedAt,
      },
      200,
      req,
    );
  }

  let dispatched = 0;
  let failed = 0;
  const results: Array<
    { id: string; kind: string; ok: boolean; error?: string }
  > = [];

  for (const job of jobs) {
    try {
      const ok = await dispatchOne(job);
      if (ok.ok) {
        await admin
          .from("shortlisting_jobs")
          .update({
            status: "succeeded",
            finished_at: new Date().toISOString(),
            error_message: null,
            result: ok.result ?? null,
          })
          .eq("id", job.id);
        dispatched++;
        results.push({ id: job.id, kind: job.kind, ok: true });

        // ── Job chaining (post-success) ───────────────────────────────────
        // Each pass-kind enqueues exactly one job for the next pass when it
        // succeeds. Extract is the only fan-out kind: pass0 only fires once
        // ALL of a round's extract jobs are 'succeeded' (no pending/running
        // siblings remain).
        try {
          await chainNextKind(admin, job);
        } catch (chainErr) {
          // A chain failure shouldn't fail the parent job (already marked
          // succeeded above). Just log and let the next dispatcher tick
          // notice the gap (or a manual re-run will re-evaluate).
          const msg =
            chainErr instanceof Error ? chainErr.message : String(chainErr);
          console.warn(
            `[${GENERATOR}] chain after ${job.kind} ${job.id} failed: ${msg}`,
          );
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

// ──────────────────────────────────────────────────────────────────────────
// Dispatch + result types
// ──────────────────────────────────────────────────────────────────────────

type DispatchResult = {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown> | null;
};

/**
 * Map kind → target Edge Function name. The 6 pass-kinds all accept
 * `{ job_id }` in their request body (see each function's RequestBody type)
 * and use it to look up round_id / payload server-side. Centralising the
 * mapping here means new kinds only need a single line added.
 */
const KIND_TO_FUNCTION: Record<string, string> = {
  ingest: "shortlisting-ingest",
  extract: "shortlisting-extract",
  pass0: "shortlisting-pass0",
  pass1: "shortlisting-pass1",
  pass2: "shortlisting-pass2",
  pass3: "shortlisting-pass3",
};

async function dispatchOne(job: ShortlistingJob): Promise<DispatchResult> {
  const fnName = KIND_TO_FUNCTION[job.kind];
  if (!fnName) {
    return { ok: false, error: `unknown kind: ${job.kind}` };
  }
  return await callEdgeFunction(fnName, { job_id: job.id });
}

// ──────────────────────────────────────────────────────────────────────────
// Chain logic — enqueue the next kind for the same round on success
// ──────────────────────────────────────────────────────────────────────────

async function chainNextKind(
  admin: ReturnType<typeof getAdminClient>,
  job: ShortlistingJob,
): Promise<void> {
  // ingest: NO chaining. shortlisting-ingest internally enqueues N extract
  // jobs (mig 284 §7) so the dispatcher would duplicate.
  if (job.kind === "ingest") return;

  // pass3 is terminal — it fires the notification itself.
  if (job.kind === "pass3") return;

  // extract → pass0, only when ALL extract jobs for this round are done.
  if (job.kind === "extract") {
    const roundId =
      job.round_id || (job.payload?.round_id as string | undefined) || null;
    if (!roundId) {
      console.warn(
        `[${GENERATOR}] extract ${job.id} succeeded but round_id missing — cannot chain pass0`,
      );
      return;
    }

    // Count siblings in pending/running. If any remain, this isn't the last
    // chunk — let the next-finishing chunk be the trigger.
    const { count: stillRunning, error: cntErr } = await admin
      .from("shortlisting_jobs")
      .select("id", { count: "exact", head: true })
      .eq("round_id", roundId)
      .eq("kind", "extract")
      .in("status", ["pending", "running"]);
    if (cntErr) {
      console.warn(
        `[${GENERATOR}] extract chain count failed for round ${roundId}: ${cntErr.message}`,
      );
      return;
    }
    if ((stillRunning ?? 0) > 0) return;

    // Sanity: at least one extract must have succeeded to proceed (filter
    // out the dead_letter-only / failed-only edge case).
    const { count: succeeded, error: okErr } = await admin
      .from("shortlisting_jobs")
      .select("id", { count: "exact", head: true })
      .eq("round_id", roundId)
      .eq("kind", "extract")
      .eq("status", "succeeded");
    if (okErr || (succeeded ?? 0) === 0) {
      console.warn(
        `[${GENERATOR}] round ${roundId} has no succeeded extract jobs — skipping pass0 chain`,
      );
      return;
    }

    // Idempotency: a pass0 job for this round may already exist if a prior
    // dispatcher tick lost the race or if the round was retried. Skip if
    // there's already a non-terminal one.
    const { count: existingPass0 } = await admin
      .from("shortlisting_jobs")
      .select("id", { count: "exact", head: true })
      .eq("round_id", roundId)
      .eq("kind", "pass0")
      .in("status", ["pending", "running", "succeeded"]);
    if ((existingPass0 ?? 0) > 0) {
      console.log(
        `[${GENERATOR}] extract ${job.id} chain skipped — pass0 already exists for round ${roundId}`,
      );
      return;
    }

    await enqueueNextPassJob(admin, {
      projectId: job.project_id,
      roundId,
      groupId: null,
      kind: "pass0",
      chainedFrom: job.id,
    });
    return;
  }

  // pass0 → pass1, pass1 → pass2, pass2 → pass3.
  const nextMap: Record<string, string> = {
    pass0: "pass1",
    pass1: "pass2",
    pass2: "pass3",
  };
  const nextKind = nextMap[job.kind];
  if (!nextKind) return;

  const roundId =
    job.round_id || (job.payload?.round_id as string | undefined) || null;
  if (!roundId) {
    console.warn(
      `[${GENERATOR}] ${job.kind} ${job.id} succeeded but round_id missing — cannot chain ${nextKind}`,
    );
    return;
  }

  // Idempotency guard — same as extract → pass0 above.
  const { count: existing } = await admin
    .from("shortlisting_jobs")
    .select("id", { count: "exact", head: true })
    .eq("round_id", roundId)
    .eq("kind", nextKind)
    .in("status", ["pending", "running", "succeeded"]);
  if ((existing ?? 0) > 0) {
    console.log(
      `[${GENERATOR}] ${job.kind} ${job.id} chain skipped — ${nextKind} already exists for round ${roundId}`,
    );
    return;
  }

  await enqueueNextPassJob(admin, {
    projectId: job.project_id,
    roundId,
    groupId: null,
    kind: nextKind,
    chainedFrom: job.id,
  });
}

async function enqueueNextPassJob(
  admin: ReturnType<typeof getAdminClient>,
  args: {
    projectId: string | null;
    roundId: string;
    groupId: string | null;
    kind: string;
    chainedFrom: string;
  },
): Promise<void> {
  if (!args.projectId) {
    // shortlisting_jobs.project_id is NOT NULL — without it we can't insert.
    console.warn(
      `[${GENERATOR}] cannot chain ${args.kind} for round ${args.roundId} — project_id missing on parent job`,
    );
    return;
  }
  const { error } = await admin.from("shortlisting_jobs").insert({
    project_id: args.projectId,
    round_id: args.roundId,
    group_id: args.groupId,
    kind: args.kind,
    status: "pending",
    payload: {
      project_id: args.projectId,
      round_id: args.roundId,
      chained_from: args.chainedFrom,
    },
    scheduled_for: new Date().toISOString(),
  });
  if (error) {
    // Audit defect #16: mig 326 added uniq_shortlisting_jobs_active_pass_per_round
    // which makes concurrent ticks racing on the same chain insert produce a
    // unique violation rather than a duplicate row. That's the desired outcome —
    // sibling tick already enqueued the next pass — so log at info level instead
    // of warn so it doesn't pollute the error stream.
    const isChainRaceLost =
      /uniq_shortlisting_jobs_active_pass_per_round/.test(error.message) ||
      /duplicate key value/i.test(error.message);
    if (isChainRaceLost) {
      console.log(
        `[${GENERATOR}] chain ${args.kind} for round ${args.roundId} skipped — sibling tick won the race (mig 326): ${error.message}`,
      );
    } else {
      console.warn(
        `[${GENERATOR}] failed to chain ${args.kind} for round ${args.roundId}: ${error.message}`,
      );
    }
  } else {
    console.log(
      `[${GENERATOR}] chained ${args.kind} for round ${args.roundId} (after ${args.chainedFrom})`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP plumbing
// ──────────────────────────────────────────────────────────────────────────

async function callEdgeFunction(
  fnName: string,
  body: Record<string, unknown>,
): Promise<DispatchResult> {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  // SHORTLISTING_DISPATCHER_JWT (preferred) or DRONE_DISPATCHER_JWT (legacy
  // shared secret) must be a real Supabase service-role JWT (HS256/ES256).
  // The new sb_secret_* env values fail getUserFromReq's JWT structure check
  // on verify_jwt=true gateways. Fail loud if neither is set. (Mirrors drone
  // dispatcher audit #29.)
  const serviceKey =
    Deno.env.get("SHORTLISTING_DISPATCHER_JWT") ||
    Deno.env.get("DRONE_DISPATCHER_JWT") ||
    "";
  if (!serviceKey) {
    return {
      ok: false,
      error:
        "SHORTLISTING_DISPATCHER_JWT (or fallback DRONE_DISPATCHER_JWT) not set — cannot dispatch. Set it to a real Supabase service-role JWT (not the sb_secret_* env value).",
    };
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "x-caller-context": GENERATOR,
      },
      body: JSON.stringify(body),
    });

    // Single-read body (mirrors drone dispatcher audit #35).
    const rawText = await resp.text().catch(() => "");

    if (!resp.ok) {
      return {
        ok: false,
        error: `${fnName} returned ${resp.status}: ${rawText.slice(0, 300)}`,
      };
    }

    let bodyJson: Record<string, unknown> | null = null;
    if (rawText.length > 0) {
      try {
        bodyJson = JSON.parse(rawText);
      } catch {
        bodyJson = null;
      }
    }
    if (bodyJson && typeof bodyJson === "object") {
      // The 6 shortlisting fns return either { ok: true, ... } or
      // { ok: false, error: ... } — and a few legacy paths return
      // { success: false } via errorResponse(). Treat any explicit false
      // as a dispatch failure so backoff kicks in.
      if (bodyJson.ok === false) {
        return {
          ok: false,
          error: `${fnName}: ok=false, error=${bodyJson.error || "unknown"}`,
        };
      }
      if (bodyJson.success === false) {
        return {
          ok: false,
          error: `${fnName}: success=false, error=${bodyJson.error || "unknown"}`,
        };
      }
    }
    return { ok: true, result: bodyJson };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

async function markFailed(
  admin: ReturnType<typeof getAdminClient>,
  job: ShortlistingJob,
  errMsg: string,
): Promise<void> {
  // claim_shortlisting_jobs already incremented attempt_count when it
  // claimed the job, so job.attempt_count IS the count of attempts made
  // (including this failed one). Mirrors drone dispatcher audit #31.
  const attemptsSoFar = job.attempt_count || 1;
  if (attemptsSoFar >= MAX_ATTEMPTS) {
    await admin
      .from("shortlisting_jobs")
      .update({
        status: "dead_letter",
        finished_at: new Date().toISOString(),
        error_message: errMsg.slice(0, 1000),
      })
      .eq("id", job.id);
  } else {
    const backoffSec =
      BACKOFF_SECONDS[Math.min(attemptsSoFar - 1, BACKOFF_SECONDS.length - 1)];
    const next = new Date(Date.now() + backoffSec * 1000).toISOString();
    await admin
      .from("shortlisting_jobs")
      .update({
        status: "pending",
        scheduled_for: next,
        error_message: errMsg.slice(0, 1000),
      })
      .eq("id", job.id);
  }
}

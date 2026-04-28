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
 * Per-invocation (claim-one-at-a-time, budget-bounded loop): claims a SINGLE
 * pending job ordered by scheduled_for, dispatches it via fetch, marks
 * succeeded/failed, then loops to claim the next one — until either no jobs
 * remain OR the wall-clock budget would be exceeded by another iteration.
 *
 * The previous design pre-claimed up to MAX_JOBS_PER_RUN=10 jobs upfront and
 * processed them serially. That ran fine for short pass jobs but broke for
 * extract chunks (~85s each on Modal): a 5-chunk round claimed all 5 as
 * 'running' on the first tick, processed only 3 before the Edge Function
 * wall-clock killed the invocation, then stranded chunks 4-5 in 'running'
 * until the 20-minute stale-claim sweep released them. Real-world hit on
 * 2026-04-28 (13 Saladine round 3ed54b53). Claim-one-at-a-time means at most
 * the currently-dispatching job is at risk if the invocation dies; siblings
 * stay 'pending' and the next cron tick picks one up immediately.
 *
 * Failed jobs back off exponentially (attempt 1: now+60s, 2: +300s, 3:
 * +1800s). After 3 failed attempts a job is marked 'dead_letter'.
 *
 * Stale-claim recovery: any job stuck in 'running' for >5 minutes is reset
 * to 'pending' with attempt_count refunded. (Was 20min — tightened
 * 2026-04-28 alongside the claim-one-at-a-time refactor: with at most one
 * in-flight job per tick, anything older than the slowest pass + buffer is
 * unambiguously stuck rather than legitimately running.) Mirrors the drone
 * dispatcher fix for Edge-Function timeouts that would otherwise burn the
 * retry budget.
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
import { validateDispatcherJwt } from "../_shared/dispatcherJwtValidator.ts";
import { tryAcquireMutex, releaseMutex } from "../_shared/dispatcherMutex.ts";

const GENERATOR = "shortlisting-job-dispatcher";
const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") || "https://rjzdznwkxnzfekgcdkei.supabase.co";
const MAX_ATTEMPTS = 3;

// Per-tick wall-clock budget. Supabase Pro Edge Functions have a ~400s wall
// timeout; we cap our processing window at 240s so the invocation has plenty
// of headroom to release the mutex and emit a clean response. The dispatcher
// loops claim→dispatch→loop and exits as soon as the next iteration would
// risk overshooting.
const TICK_BUDGET_MS = 240_000;
// Pessimistic ceiling on a single iteration. dispatchOne's fetch timeout is
// 120s (Pass 2 worst case). We add headroom for the post-call DB updates +
// chain logic + claim of the next job. If `TICK_BUDGET_MS - elapsed` is less
// than this, we exit gracefully so the mutex is released and the Edge
// Function gets to write its response before the gateway closes.
const TICK_LOOP_SAFETY_MS = 130_000;

// Audit defect #13 + Wave 7 P0-2: warn loudly at cold-start if the dispatcher
// JWT secret is missing OR present-but-malformed. Catches misconfiguration
// before the first dispatch tick. The shape check matches the runtime check in
// validateDispatcherJwt() so a deployment with a wrong-shaped value is loud at
// startup AND fails the health probe (see _health_check below).
const __startupJwt = Deno.env.get("SHORTLISTING_DISPATCHER_JWT") || "";
if (!__startupJwt) {
  console.error(
    `[${GENERATOR}] STARTUP WARNING: SHORTLISTING_DISPATCHER_JWT is not set. All dispatches will fail until this secret is configured. See docs/DEPLOYMENT_RUNBOOK.md.`,
  );
} else {
  const __startupCheck = validateDispatcherJwt(__startupJwt);
  if (!__startupCheck.ok) {
    console.warn(
      `[${GENERATOR}] STARTUP WARNING: SHORTLISTING_DISPATCHER_JWT is set but appears malformed: ${__startupCheck.error}. Dispatches will fail until a real service-role JWT is configured.`,
    );
  }
}

// Audit defect #12 + Wave 7 P1-11: single-flight enforcement. Cron schedule
// `* * * * *` plus a long wall-clock means two ticks can overlap. SKIP LOCKED
// on claim_shortlisting_jobs prevents row double-claim, but the chain logic
// (e.g. ingest → extract spawn) reads + writes that aren't claim-protected.
//
// W7.5 replaced the previous pg_advisory_lock pattern with a row-based mutex
// on the dispatcher_locks table (migration 336). Advisory locks are session-
// scoped; PostgREST's connection pool routes the unlock RPC to a different
// connection than the acquire RPC, so unlocks silently failed and stale
// locks accumulated until pool eviction (~10min). The row-based mutex is
// connection-pool agnostic — see _shared/dispatcherMutex.ts and the design
// spec at docs/design-specs/W7-5-pg-advisory-lock-fix.md.
const DISPATCHER_LOCK_NAME = "shortlisting-job-dispatcher";

// Backoff seconds: attempt 1 fail → +60s, attempt 2 → +300s, attempt 3 → +1800s
const BACKOFF_SECONDS = [60, 300, 1800];

// Stale-claim sweep — any job stuck in 'running' for >5 minutes is reset.
// Tightened 2026-04-28 from 20min after switching to claim-one-at-a-time:
// the previous batch-claim could legitimately leave 9 sibling jobs in
// 'running' waiting their turn for ~5min each, so 20min was the safe floor.
// Now there's only ever one in-flight job, and dispatchOne's fetch timeout
// is 120s — anything still 'running' past 5min is truly stranded.
const STALE_CLAIM_MIN = 5;

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
    // Wave 7 P0-2: fail-loud if the JWT secret is missing or malformed. The
    // dispatcher cannot chain-call extract/pass0/pass1/pass2/pass3 without a
    // valid service-role JWT, so a green health probe with a bad JWT was
    // dangerously misleading. Round 2 cost ~15 minutes debugging this exact
    // case — the function ran but every dispatch silently 401'd. Returning
    // 503 here surfaces the misconfiguration to ops dashboards immediately.
    const jwt = Deno.env.get("SHORTLISTING_DISPATCHER_JWT") || "";
    if (!jwt) {
      return jsonResponse(
        {
          ok: false,
          error:
            "SHORTLISTING_DISPATCHER_JWT not set — dispatcher cannot chain calls. See docs/DEPLOYMENT_RUNBOOK.md",
        },
        503,
        req,
      );
    }
    const validation = validateDispatcherJwt(jwt);
    if (!validation.ok) {
      return jsonResponse(
        {
          ok: false,
          error: "SHORTLISTING_DISPATCHER_JWT is malformed (not a service-role JWT)",
        },
        503,
        req,
      );
    }
    return jsonResponse(
      { _version: "v1.0", _fn: GENERATOR, secrets_ok: true },
      200,
      req,
    );
  }

  const admin = getAdminClient();
  const startedAt = Date.now();

  // ── Audit defect #12 + Wave 7 P1-11: Single-flight row-based mutex ──────
  // Try to acquire the dispatcher lock. If another invocation already holds
  // it, exit cleanly (200) without touching the queue. The mutex sits on
  // the dispatcher_locks table (mig 336) instead of pg_advisory_lock so it
  // isn't sensitive to PostgREST's cross-connection pool routing.
  const tickId = crypto.randomUUID();
  let lockAcquired = false;
  try {
    lockAcquired = await tryAcquireMutex(admin, DISPATCHER_LOCK_NAME, tickId);
    if (!lockAcquired) {
      console.info(
        `[${GENERATOR}] concurrent dispatch detected — returning early`,
      );
      return jsonResponse(
        {
          success: true,
          claimed: 0,
          dispatched: 0,
          failed: 0,
          skipped: "concurrent_dispatch",
          elapsed_ms: Date.now() - startedAt,
        },
        200,
        req,
      );
    }
    return await runDispatcherTick(admin, req, startedAt);
  } finally {
    if (lockAcquired) {
      // Stale-lock pre-clear on the next tick covers the case where this
      // release fails silently — log and keep moving so a release error
      // can never wedge subsequent ticks.
      await releaseMutex(admin, DISPATCHER_LOCK_NAME, tickId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[${GENERATOR}] mutex release failed (will be cleaned up by stale-lock sweep): ${msg}`,
        );
      });
    }
  }
});

async function runDispatcherTick(
  admin: ReturnType<typeof getAdminClient>,
  req: Request,
  startedAt: number,
): Promise<Response> {
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

  // ── Claim-one-at-a-time, budget-bounded loop ──────────────────────────────
  // Each iteration atomically claims a single pending job (FOR UPDATE SKIP
  // LOCKED via mig 288), dispatches it, marks succeeded/failed, then loops.
  // Exits when:
  //   (a) claim_shortlisting_jobs returns no rows (queue drained), OR
  //   (b) remaining wall-clock budget is too small for another iteration to
  //       finish + emit a response cleanly.
  //
  // Why one-at-a-time: pre-claiming a batch of N marks all N as 'running' on
  // the first iteration. If the Edge Function wall-clock kills the invocation
  // before all N are processed, the unprocessed siblings sit in 'running'
  // until the stale-claim sweep (5min). With one-at-a-time, only the
  // currently-dispatching job is at risk; the rest stay 'pending' and the
  // next cron tick (≤60s away) picks the next one up.
  let claimedTotal = 0;
  let dispatched = 0;
  let failed = 0;
  let exitReason: "drained" | "budget_exhausted" = "drained";
  const results: Array<
    { id: string; kind: string; ok: boolean; error?: string }
  > = [];

  while (true) {
    if (Date.now() - startedAt + TICK_LOOP_SAFETY_MS >= TICK_BUDGET_MS) {
      exitReason = "budget_exhausted";
      console.info(
        `[${GENERATOR}] tick budget exhausted after ${claimedTotal} job(s); ` +
          `next cron tick will pick up remaining work`,
      );
      break;
    }

    const { data: claimed, error: claimErr } = await admin.rpc(
      "claim_shortlisting_jobs",
      { p_limit: 1 },
    );
    if (claimErr) {
      return errorResponse(
        `claim_shortlisting_jobs failed: ${claimErr.message}`,
        500,
        req,
      );
    }
    const jobs: ShortlistingJob[] = claimed || [];
    if (jobs.length === 0) break;
    const job = jobs[0];
    claimedTotal++;

    try {
      const ok = await dispatchOne(job);
      if (ok.ok) {
        // Audit defect #1 (contract): the dispatched edge function's full
        // HTTP response body is persisted into shortlisting_jobs.result. Any
        // pass function MUST include its complete result payload (cost,
        // counts, warnings, etc.) in the JSON it returns — Pass 3 reads
        // job.result during retries to compute pass3_run_count, and ops
        // queries `result` for cost rollups. Fan-out kinds (e.g. extract)
        // also expect result to be readable by the chain logic below.
        // Changing this to a synthesised summary would silently break those
        // consumers; we keep the verbatim-body contract.
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
      claimed: claimedTotal,
      dispatched,
      failed,
      exit_reason: exitReason,
      elapsed_ms: Date.now() - startedAt,
      results,
    },
    200,
    req,
  );
}

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
  // Audit defect #13: SHORTLISTING_DISPATCHER_JWT is the ONLY accepted secret
  // here; the prior DRONE_DISPATCHER_JWT fallback was fragile (a rotation in
  // the drone module would silently break shortlisting). The secret must be a
  // real Supabase service-role JWT (HS256/ES256); sb_secret_* values fail
  // getUserFromReq's JWT structure check on verify_jwt=true gateways.
  const serviceKey = Deno.env.get("SHORTLISTING_DISPATCHER_JWT") || "";
  if (!serviceKey) {
    const errMsg =
      "SHORTLISTING_DISPATCHER_JWT not set — cannot dispatch. Set it via " +
      "`supabase secrets set SHORTLISTING_DISPATCHER_JWT=<service-role-jwt>` to a real " +
      "Supabase service-role JWT (not the sb_secret_* env value).";
    console.error(`[${GENERATOR}] ${errMsg}`);
    return { ok: false, error: errMsg };
  }
  try {
    // Burst 17 GG1: bound the per-call wait so a hanging downstream function
    // doesn't burn the dispatcher's entire wall budget. 120s gives Pass 2
    // (the slowest, with 8192-token output + Stream B universe) headroom
    // while leaving the dispatcher ~30s to cleanly mark the timed-out job
    // and exit. Pairs with TICK_LOOP_SAFETY_MS (130s) so the loop can always
    // close the in-flight call before the per-tick wall budget closes.
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "x-caller-context": GENERATOR,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120 * 1000),
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

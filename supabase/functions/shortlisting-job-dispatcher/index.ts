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

// Wave 11.7.1 background-mode kinds: shortlisting-shape-d returns a fast
// HTTP ack and runs Stage 1 inside EdgeRuntime.waitUntil for 3-5 minutes
// (200-angle shoot, 4 batches × ~50s, plus Dropbox preview fetches +
// classification persistence). The ordinary 5-minute stale sweep would
// reset the row mid-run and trigger a phantom retry, even though bgWork
// is still alive and holding the per-round mutex. Background kinds get a
// longer leash — bgWork's per-round mutex (20-minute auto-expiry) is the
// upstream backstop against truly orphaned rows.
// Wave 13b adds `pulse_description_extract` — text-only Gemini extractor that
// runs in EdgeRuntime.waitUntil for ~3-5 min on a 100-row smoke. Same
// background-mode contract as shape_d_stage1: HTTP 200 ack with mode='background',
// bgWork self-updates the row on completion.
const BACKGROUND_MODE_KINDS = new Set([
  "shape_d_stage1",
  "stage4_synthesis",
  "pulse_description_extract",
]);
const STALE_CLAIM_MIN_BACKGROUND = 15;

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
  //
  // Wave 11.7.1: BACKGROUND_MODE_KINDS get a longer threshold (15 min) —
  // shape-d Stage 1 legitimately runs 3-5 min inside EdgeRuntime.waitUntil,
  // and the ordinary 5-min sweep would phantom-retry it mid-run.
  const fastCutoff = new Date(
    Date.now() - STALE_CLAIM_MIN * 60 * 1000,
  ).toISOString();
  const slowCutoff = new Date(
    Date.now() - STALE_CLAIM_MIN_BACKGROUND * 60 * 1000,
  ).toISOString();
  const backgroundKindsArr = Array.from(BACKGROUND_MODE_KINDS);
  // Two queries since supabase-js doesn't compose conditional cutoffs in a
  // single update; the alternative would be a SQL RPC. Each runs <50ms.
  const { data: staleFast } = await admin
    .from("shortlisting_jobs")
    .update({ status: "pending", started_at: null })
    .eq("status", "running")
    .not("kind", "in", `(${backgroundKindsArr.map((k) => `"${k}"`).join(",")})`)
    .lt("started_at", fastCutoff)
    .select("id");
  const { data: staleSlow } = await admin
    .from("shortlisting_jobs")
    .update({ status: "pending", started_at: null })
    .eq("status", "running")
    .in("kind", backgroundKindsArr)
    .lt("started_at", slowCutoff)
    .select("id");
  const stale = [...(staleFast || []), ...(staleSlow || [])];
  if (stale.length > 0) {
    const ids = stale.map((r) => r.id);
    const { error: decErr } = await admin.rpc(
      "shortlisting_jobs_decrement_attempts",
      { p_ids: ids },
    );
    if (decErr) {
      console.warn(
        `[${GENERATOR}] reset ${stale.length} stale-claim job(s) (fast=${staleFast?.length ?? 0}/slow=${staleSlow?.length ?? 0}), but attempt-decrement RPC failed: ${decErr.message}`,
      );
    } else {
      console.warn(
        `[${GENERATOR}] reset ${stale.length} stale-claim job(s) (fast=${staleFast?.length ?? 0}/slow=${staleSlow?.length ?? 0}) and refunded their attempts`,
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
        if (ok.background_mode) {
          // Wave 11.7.1 immediate-ack contract: the called fn (currently
          // shortlisting-shape-d) returned a fast 200 ack and is now running
          // the heavy work inside EdgeRuntime.waitUntil. The bgWork will
          // self-update the shortlisting_jobs row with status='succeeded' or
          // 'failed' when it finishes. The dispatcher MUST NOT touch the row
          // here — doing so would race with bgWork and either (a) prematurely
          // mark a still-running job as succeeded (breaking chain idempotency
          // checks) or (b) clobber bgWork's persisted error_message.
          //
          // Job chaining is also bgWork's responsibility (the orchestrator
          // inserts the stage4_synthesis row inline so it can carry round-
          // state context). Skip the chain attempt here.
          //
          // Stale-claim sweep at the top of the next tick (>5min in 'running')
          // is the safety net if bgWork crashes before persisting status.
          dispatched++;
          results.push({ id: job.id, kind: job.kind, ok: true });
          console.log(
            `[${GENERATOR}] ${job.kind} ${job.id} ack'd in background mode — bgWork owns row state`,
          );
        } else {
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
  // Wave 11.7.1: When the called function returns `{ ok: true, mode: 'background', ... }`
  // it has kicked the heavy work into EdgeRuntime.waitUntil and will self-update
  // the shortlisting_jobs row when bgWork completes. The dispatcher must NOT
  // auto-mark the row as 'succeeded' on the HTTP 200 ack — the row is still
  // 'running' from the dispatcher's perspective until bgWork writes its
  // terminal state. Used by shortlisting-shape-d (Stage 1 takes 3-5 min for
  // 200-angle shoots, well past the 120s gateway timeout).
  background_mode?: boolean;
};

/**
 * Map kind → target Edge Function name. The 6 pass-kinds all accept
 * `{ job_id }` in their request body (see each function's RequestBody type)
 * and use it to look up round_id / payload server-side. Centralising the
 * mapping here means new kinds only need a single line added.
 *
 * Wave 11.7.1: Shape D adds `shape_d_stage1` + `stage4_synthesis`. The chain
 * `pass0 → ?` reads engine_mode at chain time and picks pass1 (two_pass) or
 * shape_d_stage1 (shape_d). Stage 4 is dispatched as a standalone job by
 * the shape-d orchestrator at the end of Stage 1 — the dispatcher does not
 * chain it.
 *
 * Wave 12 hygiene: `canonical_rollup` is dispatched alongside `stage4_synthesis`
 * by the shape-d orchestrator when Stage 1 finishes. The dispatcher only needs
 * to map the kind to the canonical-rollup edge fn — it is terminal (no chain).
 * The fn is idempotent (the unique key on raw_attribute_observations means
 * re-running for the same round skips already-processed labels) so a retry
 * after a transient failure is safe.
 */
const KIND_TO_FUNCTION: Record<string, string> = {
  ingest: "shortlisting-ingest",
  extract: "shortlisting-extract",
  pass0: "shortlisting-pass0",
  pass1: "shortlisting-pass1",
  pass2: "shortlisting-pass2",
  pass3: "shortlisting-pass3",
  shape_d_stage1: "shortlisting-shape-d",
  stage4_synthesis: "shortlisting-shape-d-stage4",
  canonical_rollup: "canonical-rollup",
  // Wave 13b — text-only Gemini 2.5 Pro extractor over pulse_listings.description.
  // Background-mode kind: returns {mode: 'background'} ack and self-updates
  // the job row when bgWork completes (matches shape_d_stage1).
  pulse_description_extract: "pulse-description-extractor",
  // Wave 13c — vision-Gemini 2.5 Pro extractor over pulse_listings.floorplan_urls.
  // Terminal kind, no chain. Inline mode for ≤4 units (smoke), background mode
  // for larger N (immediate-ack + EdgeRuntime.waitUntil + self-update).
  floorplan_extract: "floorplan-ocr-extractor",
};

async function dispatchOne(job: ShortlistingJob): Promise<DispatchResult> {
  const fnName = KIND_TO_FUNCTION[job.kind];
  if (!fnName) {
    return { ok: false, error: `unknown kind: ${job.kind}` };
  }
  // Wave 12: canonical-rollup parses `{ round_id }` from its body (it's a
  // round-level Stage 1.5 normalisation pass, not a per-job pass). Send
  // round_id alongside job_id so the fn sees what it expects without breaking
  // the per-job contract every other kind uses.
  if (job.kind === "canonical_rollup") {
    const roundId =
      job.round_id || (job.payload?.round_id as string | undefined) || null;
    if (!roundId) {
      return {
        ok: false,
        error: `canonical_rollup job ${job.id} missing round_id`,
      };
    }
    return await callEdgeFunction(fnName, { job_id: job.id, round_id: roundId });
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

  // Wave 11.7.1: Shape D terminal kinds.
  // shape_d_stage1 itself enqueues stage4_synthesis at the end of its run
  // (the orchestrator inserts the row inline so it can carry round-state
  // context). The dispatcher does NOT chain after shape_d_stage1.
  if (job.kind === "shape_d_stage1") return;
  // stage4_synthesis is terminal in Shape D (Stage 4's persistence transitions
  // shortlisting_rounds.status to 'proposed', matching legacy pass2's terminal
  // state — no further chain).
  if (job.kind === "stage4_synthesis") return;
  // Wave 12: canonical_rollup is terminal — it's a Stage 1.5 normalisation
  // sidecar enqueued by shape-d alongside stage4_synthesis. It writes to
  // raw_attribute_observations + object_registry + object_registry_candidates
  // and exits. Nothing else chains off it.
  if (job.kind === "canonical_rollup") return;
  // Wave 13b: pulse_description_extract is terminal — it's a standalone
  // batch extractor over historical pulse_listings.description rows. It
  // writes to pulse_description_extracts + pulse_extract_audit and exits.
  // Downstream waves (W12.5 organic registry growth, W14 calibration) read
  // those tables directly rather than via a chained dispatcher kind.
  if (job.kind === "pulse_description_extract") return;
  // Wave 13c: floorplan_extract is terminal — vision-Gemini 2.5 Pro extractor
  // over pulse_listings.floorplan_urls. Writes to floorplan_extracts and exits.
  // Downstream waves (W12.5 canonical registry, W15c floorplan-aware
  // shortlisting) read floorplan_extracts directly.
  if (job.kind === "floorplan_extract") return;

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

  // pass0 → (pass1 OR shape_d_stage1, depending on engine_mode), pass1 → pass2,
  // pass2 → pass3.
  //
  // Wave 11.7.1 coexistence: pass0 is shared by both engines; the next-kind
  // picks at chain time based on the round's engine_mode (with the engine_
  // settings.engine_mode as the global fallback). engine_mode is stamped onto
  // shortlisting_rounds at round-bootstrap so the routing is deterministic
  // even if a round is replayed mid-flight.
  const roundId =
    job.round_id || (job.payload?.round_id as string | undefined) || null;
  if (!roundId) {
    console.warn(
      `[${GENERATOR}] ${job.kind} ${job.id} succeeded but round_id missing — cannot chain next kind`,
    );
    return;
  }
  let nextKind: string;
  if (job.kind === "pass0") {
    // Look up the round's engine_mode. If 'shape_d_*' → route to
    // shape_d_stage1; if 'two_pass' or null → route to legacy pass1.
    const { data: roundRow } = await admin
      .from("shortlisting_rounds")
      .select("engine_mode")
      .eq("id", roundId)
      .maybeSingle();
    const roundMode = (roundRow?.engine_mode as string | null) || null;
    let useShapeD = roundMode?.startsWith("shape_d") ?? false;
    if (!roundMode || roundMode === "two_pass") {
      // No per-round override → check the global default.
      const { data: gs } = await admin
        .from("engine_settings")
        .select("value")
        .eq("key", "engine_mode")
        .maybeSingle();
      const globalMode = typeof gs?.value === "string"
        ? gs.value
        : (typeof gs?.value === "object" && gs?.value !== null
          ? (gs.value as Record<string, unknown>).value
          : null);
      if (globalMode === "shape_d") useShapeD = true;
    }
    nextKind = useShapeD ? "shape_d_stage1" : "pass1";
    if (useShapeD) {
      console.log(
        `[${GENERATOR}] pass0 ${job.id} → routing round ${roundId} to Shape D (engine_mode=${roundMode ?? "global_shape_d"})`,
      );
    }
  } else {
    const nextMap: Record<string, string> = {
      pass1: "pass2",
      pass2: "pass3",
    };
    const mapped = nextMap[job.kind];
    if (!mapped) return;
    nextKind = mapped;
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
      // Wave 11.7.1 background-mode contract: the function returned a fast
      // ack and is running the real work inside EdgeRuntime.waitUntil. It
      // will self-update shortlisting_jobs.status when bgWork finishes, so
      // we surface the flag and let the caller skip the auto-mark.
      const isBackground = bodyJson.mode === "background";
      return { ok: true, result: bodyJson, background_mode: isBackground };
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

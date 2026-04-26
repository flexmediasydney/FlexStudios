/**
 * drone-job-dispatcher
 * ────────────────────
 * Pulls pending `drone_jobs` and dispatches them to the appropriate handler:
 *
 *   kind='ingest'                       → POST to drone-ingest      payload: { project_id }
 *   kind='render'                       → POST to drone-render      payload: { shoot_id, kind?, fallback? }
 *   kind='render_edited'                → POST to drone-render-edited payload: { shoot_id|shot_id, kind?, column_state?, wipe_existing?, reason?, cascade? }
 *   kind='boundary_save_render_cascade' → POST to drone-render-edited (cascade=true) payload: { project_id }
 *   kind='sfm'                          → POST to Modal sfm_http    payload: { _token, shoot_id }
 *   kind='poi_fetch'                    → POST to drone-pois        payload: { project_id }
 *   kind='raw_preview_render'           → POST to drone-raw-preview payload: { shoot_id }
 *
 *     Chain: ingest → sfm → poi_fetch → raw_preview_render
 *
 *     On SfM success the dispatcher chains a follow-up `kind='poi_fetch'` job
 *     (debounced ~10s). On poi_fetch success it chains a
 *     `kind='raw_preview_render'` job so the operator can see what each raw
 *     candidate would look like as a deliverable AND so the smart-shortlist
 *     algorithm flags is_ai_recommended.
 *
 *     Production-deliverable renders (kind='render') are NO LONGER auto-chained
 *     after poi_fetch — they are explicitly enqueued by the swimlane Lock
 *     action (drone-shortlist-lock, separate stream) so the operator must
 *     curate the raws first. Manual / Pin-Editor / Re-analyse paths still
 *     enqueue kind='render' directly, which is unaffected by this change.
 *
 *     Chained at the dispatcher layer rather than inside the Modal/POI
 *     endpoints to keep all queue logic in one place (and so retries of the
 *     SfM job don't re-fan-out renders).
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
// QC2-1 #8: SfM HTTP timeout MUST be < Edge Function wall-clock cap (~145s),
// otherwise the dispatcher gets killed mid-fetch, the job stays stuck in
// 'running' for 20min until the stale-claim sweeper requeues it, and the
// Modal-side result is silently lost. Cap at 120s — most SfMs finish in
// 30-90s anyway, and a >120s SfM dies cleanly with a network timeout that
// surfaces through markFailed → backoff retry.
//
// For SfMs that consistently exceed 120s, refactor to a Modal-callback
// pattern: kick off the job + return immediately + Modal POSTs back to a
// dedicated webhook on completion (deferred, not in-band). Tracked as a
// follow-up — not blocking for current shoots which complete inside 90s.
const SFM_HTTP_TIMEOUT_MS = 120 * 1000;
const MAX_JOBS_PER_RUN = 10;
const MAX_ATTEMPTS = 3;

// QC3-8 E2E13: hard upper bound on dispatcher wall-clock so the function
// returns BEFORE Supabase's own ~145s scheduler kills it. We aborted Modal
// fetches at 120s but the OUTER dispatcher tick was observed taking up to
// 148.6s when stale-claim sweep + 9 dispatched jobs + chained inserts all
// piled up. A platform-side kill leaves 'running' rows orphaned for 20min
// (until the stale sweep) so we'd rather exit cleanly at 110s and let the
// next cron tick pick up the rest. 110s leaves a safety margin for the
// final response serialisation + advisory-unlock RPC.
const DISPATCHER_DEADLINE_MS = 110 * 1000;

// QC2-6 #12: single-flight enforcement at the function level. Cron schedule
// `* * * * *` plus 145s wall-clock cap means two cron invocations can
// overlap. SKIP LOCKED on claim_drone_jobs prevents row double-claim, but
// MAX_SFM_PER_TICK=1 still lets BOTH overlapping invocations dispatch a
// separate SfM to Modal back-to-back (doubles spend during the overlap).
// Wrap the body in pg_try_advisory_lock(LOCK_KEY) → if a second tick
// arrives while the first is still running, return cleanly with
// `skipped:concurrent_dispatch`.
//
// Lock id derived from a fixed string; same hashing strategy as
// hashtext('drone-job-dispatcher') — but we precompute on the JS side so
// every dispatcher tick agrees on the value. Use a stable 53-bit hash
// (Postgres bigint is signed 64-bit; we stay well inside the JS safe
// integer range to avoid bignum gymnastics).
const DISPATCHER_LOCK_KEY = stableHashBigInt("drone-job-dispatcher");

// Backoff seconds: attempt 1 fail → +60s, attempt 2 → +300s, attempt 3 → +1800s
const BACKOFF_SECONDS = [60, 300, 1800];

// W10-S2: Modal-resource-limit backoff. When callEdgeFunction detects a
// WORKER_RESOURCE_LIMIT or 5xx Modal error, the next retry should wait
// longer (5min / 30min / 2hr) instead of the default 1min / 5min / 30min
// so the Modal worker pool has time to scale back / shed load. Paired
// with payload.next_attempt_smaller_batch=true so the smaller working
// set lands on a less-contended worker.
const MODAL_RESOURCE_BACKOFF_SECONDS = [300, 1800, 7200];

// W10-S2: regex for Modal-side 5xx detection. The 5xx-from-Modal pattern
// arrives as a synthesised string in the dispatched function's response
// body when the inner Modal call to render-worker returns 5xx. We match
// the literal substring drone-render uses ("Modal returned 5\d\d") so
// the classifier picks up resource-limit-style failures even when Modal
// surfaces them as a plain 5xx rather than the explicit
// WORKER_RESOURCE_LIMIT sentinel.
const MODAL_5XX_REGEX = /Modal returned 5\d\d/;

type DroneJob = {
  id: string;
  // claim_drone_jobs() returns project_id directly as of migration 248 so the
  // chain logic doesn't have to derive it via a per-shoot lookup.
  project_id: string | null;
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

  // QC3-8 E2E13: hard wall-clock deadline. AbortController fires at 110s so
  // any in-flight fetch (Modal SfM, Edge Function dispatch) gets cancelled
  // and the dispatcher returns 200 cleanly before Supabase's platform-side
  // kill can leave rows in 'running' for 20min.
  const dispatcherDeadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => dispatcherDeadline.abort("dispatcher_deadline_110s"),
    DISPATCHER_DEADLINE_MS,
  );

  // ── QC2-6 #12: Single-flight advisory lock ──────────────────────────────
  // Try to acquire the dispatcher lock. If another invocation already holds
  // it, exit cleanly (200 OK) without touching the queue — the holder will
  // process pending jobs in the same minute. We deliberately return 200 so
  // pg_cron doesn't log it as a failed invocation; the explicit
  // `skipped:concurrent_dispatch` field makes overlap visible in logs.
  let lockAcquired = false;
  try {
    const { data: lockResp, error: lockErr } = await admin.rpc(
      "pg_try_advisory_lock",
      { lock_id: DISPATCHER_LOCK_KEY },
    );
    if (lockErr) {
      // RPC error (wrapper missing, role lacks EXECUTE, etc.) — fail loud
      // so we notice during deploy. Don't silently degrade to no-lock mode
      // because that's how QC2-6 #12 happened in the first place.
      return errorResponse(
        `pg_try_advisory_lock RPC failed: ${lockErr.message}`,
        500,
        req,
      );
    }
    lockAcquired = lockResp === true;
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
          deferred: 0,
          skipped: "concurrent_dispatch",
          elapsed_ms: Date.now() - startedAt,
        },
        200,
        req,
      );
    }

    // Lock held — run the original dispatcher body. The `return` statements
    // inside flow through to the `finally` block which releases the lock.
    return await runDispatcherTick(
      admin,
      req,
      startedAt,
      dispatcherDeadline.signal,
    );
  } finally {
    clearTimeout(deadlineTimer);
    if (lockAcquired) {
      const { error: relErr } = await admin.rpc("pg_advisory_unlock", {
        lock_id: DISPATCHER_LOCK_KEY,
      });
      if (relErr) {
        // Non-fatal — Postgres releases all session locks when the
        // connection is recycled (PostgREST pool churn handles this in
        // ~minutes). Worst case the next 1-2 ticks see lock-held and
        // skip. Worth a warn so it's visible if it persists.
        console.warn(
          `[${GENERATOR}] pg_advisory_unlock failed (lock will release on session recycle): ${relErr.message}`,
        );
      }
    }
  }
});

/**
 * Original dispatcher tick — extracted so the advisory-lock wrapper above
 * can wrap it in a clean try/finally without nesting half a function inside
 * an `if` block.
 */
async function runDispatcherTick(
  admin: ReturnType<typeof getAdminClient>,
  req: Request,
  startedAt: number,
  deadlineSignal: AbortSignal,
): Promise<Response> {
  // Helper: returns true when the dispatcher's 110s wall-clock budget is
  // exhausted. Used between job iterations so we exit cleanly with a
  // `deadline_hit:true` body rather than letting the platform kill us.
  const deadlineHit = () => deadlineSignal.aborted;
  // ── Reset stale 'running' jobs back to 'pending'. Edge Function crashes
  // (panic, OOM, gateway timeout) leave claimed jobs stuck in 'running'
  // forever. Anything still 'running' after STALE_CLAIM_MIN minutes gets
  // requeued. (#30 audit fix)
  //
  // claim_drone_jobs() already incremented attempt_count when it claimed the
  // job — the sweep below has to UN-burn that attempt, otherwise an Edge-
  // Function timeout (which is not the operator's fault and not a real
  // failure signal) ratchets the job toward dead_letter as fast as a real
  // per-shot error would. Without the decrement, a 3-strike retry budget
  // evaporates after 3 unrelated platform timeouts.
  const STALE_CLAIM_MIN = 20;
  const { data: stale, error: sweepErr } = await admin
    .from("drone_jobs")
    .update({ status: "pending", started_at: null })
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - STALE_CLAIM_MIN * 60 * 1000).toISOString())
    .select("id");
  if (sweepErr) {
    console.warn(
      `[${GENERATOR}] stale-claim sweep failed: ${sweepErr.message} — stuck-running rows may persist until next tick`,
    );
  }
  if ((stale?.length ?? 0) > 0) {
    // Refund the attempt via the dedicated RPC — supabase-js can't express
    // attempt_count = GREATEST(0, attempt_count - 1) in .update(), so this
    // is a follow-up call. Idempotent: if the row was claimed again between
    // the reset and this decrement, attempt_count is now 1 (claim already
    // bumped) and we'd pull it back to 0 — which is fine, the next claim
    // bumps it to 1 again and the only effect is the OOM/timeout is fully
    // forgiven.
    const ids = stale!.map((r) => r.id);
    const { error: decErr } = await admin.rpc("drone_jobs_decrement_attempts", {
      p_ids: ids,
    });
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

  // Cap SfM dispatches per tick. SfM jobs take ~2-15 minutes each; the Edge
  // Function wall-clock budget is ~145s so claiming more than 1 SfM means
  // the rest stay in 'running' until they're swept as stale. (#34 audit fix)
  // Other job kinds (ingest/render/render_preview) are seconds-scale so they
  // share the remaining budget freely.
  const MAX_SFM_PER_TICK = 1;
  let sfmDispatched = 0;
  const deferred: DroneJob[] = [];

  for (const job of jobs) {
    // QC3-8 E2E13: budget check between jobs. If the dispatcher's 110s
    // deadline already fired (e.g. one heavy SfM ate >100s), defer the
    // remaining claimed jobs back to 'pending' rather than burning attempts.
    if (deadlineHit()) {
      deferred.push(job);
      continue;
    }
    // Canonical kind is 'sfm' per the drone_jobs CHECK constraint. The legacy
    // 'sfm_run' literal has been removed from this codebase (#20 audit). If
    // any historical row still has 'sfm_run' we treat it as 'sfm' below.
    const isSfmKind = job.kind === "sfm" || job.kind === "sfm_run";
    if (isSfmKind && sfmDispatched >= MAX_SFM_PER_TICK) {
      deferred.push(job);
      continue;
    }
    if (isSfmKind) sfmDispatched++;
    try {
      const ok = await dispatchOne(admin, job, deadlineSignal);
      if (ok.ok && ok.deferred === true) {
        // Deferred path — the dispatched function ran cleanly but had nothing
        // to do (e.g. drone-render: every eligible shot is waiting on the
        // editor). Push back to 'pending' WITHOUT counting this attempt
        // against the dead-letter budget, with a short backoff window.
        const backoffSec = ok.defer_backoff_sec ?? DEFER_BACKOFF_SEC;
        const next = new Date(Date.now() + backoffSec * 1000).toISOString();
        // Decrement attempt_count (claim_drone_jobs already bumped it). Use
        // the same RPC the stale-claim sweeper uses.
        await admin
          .from("drone_jobs")
          .update({
            status: "pending",
            scheduled_for: next,
            started_at: null,
            error_message: null,
            result: ok.result ?? null,
          })
          .eq("id", job.id);
        const { error: decErr } = await admin.rpc(
          "drone_jobs_decrement_attempts",
          { p_ids: [job.id] },
        );
        if (decErr) {
          console.warn(
            `[${GENERATOR}] deferred job ${job.id} attempt-refund failed: ${decErr.message}`,
          );
        }
        dispatched++;
        results.push({ id: job.id, kind: job.kind, ok: true });
        continue;
      }
      if (ok.ok) {
        const { error: succErr } = await admin
          .from("drone_jobs")
          .update({
            status: "succeeded",
            finished_at: new Date().toISOString(),
            error_message: null,
            result: ok.result ?? null,
          })
          .eq("id", job.id);
        if (succErr) {
          console.warn(`[${GENERATOR}] mark-succeeded update failed for job ${job.id}: ${succErr.message}`);
        }
        dispatched++;
        results.push({ id: job.id, kind: job.kind, ok: true });

        // Chain: on a successful SfM dispatch where Modal also reported a
        // valid reconstruction, enqueue a follow-up poi_fetch job for the
        // project. poi_fetch success will in turn chain the raw_preview_render
        // job, so drone-raw-preview's chained drone-render call finds a warm
        // drone_pois_cache row when it draws POIs over the previews.
        // Shoots that exit cleanly with too few images (Modal returns
        // ok=false but HTTP 200) do NOT trigger chaining — they remain at
        // status='sfm_failed' for review.
        //
        // Pin-edit guard (#33 audit): if the user kicked off a pin_edit_saved
        // render between SfM start and SfM success, the existing pending /
        // running render will pick up the new SfM pose itself. Skip the
        // chained poi_fetch+raw_preview_render so we don't clobber that work.
        if (isSfmKind && ok.sfm_ok === true) {
          const shootId =
            (job.payload?.shoot_id as string | undefined) || job.shoot_id;
          if (shootId) {
            // Look back 5 min for any pending/running render job for this shoot.
            const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            const { data: priorRender } = await admin
              .from("drone_jobs")
              .select("id, status, payload")
              .eq("shoot_id", shootId)
              .eq("kind", "render")
              .in("status", ["pending", "running"])
              .gte("created_at", windowStart)
              .limit(1)
              .maybeSingle();
            if (priorRender) {
              console.log(
                `[${GENERATOR}] sfm ${job.id} succeeded but render job ${priorRender.id} is already pending/running for shoot ${shootId} — skipping chained poi_fetch+raw_preview_render (will pick up new SfM pose)`,
              );
            } else {
              // Resolve project_id: SfM payload only carries shoot_id, and
              // claim_drone_jobs doesn't return the project_id column. Look
              // it up via drone_shoots so we can hand it to drone-pois.
              const projectId = await resolveProjectIdForShoot(admin, shootId);
              const scheduled = new Date(Date.now() + 10_000).toISOString();
              if (projectId) {
                const { error: enqErr } = await admin.from("drone_jobs").insert({
                  project_id: projectId,
                  shoot_id: shootId,
                  kind: "poi_fetch",
                  status: "pending",
                  payload: {
                    project_id: projectId,
                    shoot_id: shootId,
                    chained_from: job.id,
                  },
                  scheduled_for: scheduled,
                });
                if (enqErr) {
                  console.warn(
                    `[${GENERATOR}] failed to chain poi_fetch job after sfm ${job.id}: ${enqErr.message} — falling back to direct raw_preview_render`,
                  );
                  await enqueueRawPreviewAfterPois(admin, {
                    projectId,
                    shootId,
                    chainedFrom: job.id,
                    poiFetchSkipped: "enqueue_failed",
                  });
                }
              } else {
                // No project_id resolvable — skip POI step, go straight to
                // raw_preview_render so the operator still gets previews.
                console.warn(
                  `[${GENERATOR}] sfm ${job.id} succeeded but project_id unresolvable for shoot ${shootId} — skipping poi_fetch, enqueueing raw_preview_render directly`,
                );
                await enqueueRawPreviewAfterPois(admin, {
                  projectId: null,
                  shootId,
                  chainedFrom: job.id,
                  poiFetchSkipped: "project_id_unresolvable",
                });
              }
            }
          }
        }

        // Chain: on a successful poi_fetch dispatch, enqueue the
        // raw_preview_render. The cache is now warm so drone-raw-preview's
        // chained drone-render call (column_state='preview') will draw pins.
        // Production-deliverable renders (kind='render') are gated on the
        // operator's swimlane Lock action — they are NOT auto-chained here.
        if (job.kind === "poi_fetch") {
          const shootId =
            (job.payload?.shoot_id as string | undefined) || job.shoot_id;
          const projectId = (job.payload?.project_id as string | undefined) ?? null;
          if (shootId) {
            await enqueueRawPreviewAfterPois(admin, {
              projectId,
              shootId,
              chainedFrom: job.id,
              poiFetchSkipped: null,
            });
          } else {
            console.warn(
              `[${GENERATOR}] poi_fetch ${job.id} succeeded but shoot_id missing — cannot chain raw_preview_render`,
            );
          }
        }
      } else {
        // W10-S2: thread the modal_resource_limit flag through to markFailed
        // so it can pick the longer backoff curve + flip next_attempt_smaller_batch
        // on the retry payload.
        await markFailed(admin, job, ok.error || "unknown", {
          modalResourceLimit: ok.modal_resource_limit === true,
        });
        failed++;
        results.push({ id: job.id, kind: job.kind, ok: false, error: ok.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Throw-path failures (network blow-up etc) — also classify in case
      // the error string contains the Modal sentinel.
      const isResLimit =
        msg.includes("WORKER_RESOURCE_LIMIT") || MODAL_5XX_REGEX.test(msg);
      await markFailed(admin, job, msg, { modalResourceLimit: isResLimit });
      failed++;
      results.push({ id: job.id, kind: job.kind, ok: false, error: msg });
    }
  }

  // Release deferred SfM jobs back to 'pending' so the next dispatcher tick
  // can claim them (otherwise they'd be stuck in 'running' from the claim).
  //
  // W1-γ pre-existing fix: previously this batched all deferred ids into a
  // single UPDATE that wrote `deferred[0].attempt_count - 1` to every row.
  // Heterogeneous attempts (e.g. one fresh job at attempt=1 and one previously-
  // failed job at attempt=2) got clobbered to the same value, undermining the
  // dead-letter cutoff. claim_drone_jobs() incremented their attempt_count when
  // it claimed them, so the correct release writes EACH job's `attempt_count - 1`
  // to undo the increment. Loop one-by-one — there's typically zero or one
  // deferred per tick (MAX_SFM_PER_TICK=1) so the cost is negligible.
  if (deferred.length > 0) {
    for (const j of deferred) {
      const { error: relErr } = await admin
        .from("drone_jobs")
        .update({
          status: "pending",
          started_at: null,
          attempt_count: Math.max(0, (j.attempt_count || 1) - 1),
        })
        .eq("id", j.id);
      if (relErr) {
        console.warn(
          `[${GENERATOR}] failed to release deferred job ${j.id}: ${relErr.message}`,
        );
      }
    }
  }

  return jsonResponse(
    {
      success: true,
      claimed: jobs.length,
      dispatched,
      failed,
      deferred: deferred.length,
      // QC3-8 E2E13: surface when the wall-clock deadline truncated the
      // tick so cron logs / dashboard can spot the pattern. Cron treats
      // this as success — the next tick will pick up the deferred rows.
      deadline_hit: deadlineSignal.aborted,
      elapsed_ms: Date.now() - startedAt,
      results,
    },
    200,
    req,
  );
}

/**
 * stableHashBigInt — deterministic 53-bit hash for an arbitrary string.
 *
 * Used to derive a stable BIGINT lock id for pg_try_advisory_lock without
 * round-tripping through the database for `hashtext('drone-job-dispatcher')`.
 * Matches Postgres's hashtext output well enough for namespacing purposes
 * (lock collisions across DIFFERENT lock keys would be catastrophic; lock
 * collisions across THE SAME key are the entire point — both dispatcher
 * ticks must agree on the same number).
 *
 * Algorithm: 32-bit FNV-1a × 2 with two seeds, packed into a 53-bit positive
 * integer (stays in JS Number safe range; Postgres BIGINT accepts it).
 */
function stableHashBigInt(s: string): number {
  let h1 = 0x811c9dc5; // FNV offset basis
  let h2 = 0x01000193; // alternate seed
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = (h1 * 0x01000193) >>> 0;
    h2 ^= c; h2 = (h2 * 0x811c9dc5) >>> 0;
  }
  // Combine to a 53-bit positive integer.
  return (h1 * 0x200000 + (h2 & 0x1fffff)) % Number.MAX_SAFE_INTEGER;
}

// ──────────────────────────────────────────────────────────────────────
// Result type carries optional `sfm_ok` (Modal-reported success) and `result`
// (small JSON blob persisted into drone_jobs.result for the SfM/render tick).
//
// `deferred=true` means the dispatched function ran cleanly but its outcome
// was "nothing to do right now, try again later" — e.g. drone-render
// returning 0 rendered when every eligible shot was skipped because the
// editor team hasn't uploaded edited JPGs yet. We push the job back into
// 'pending' WITHOUT burning an attempt and WITHOUT marking it as failed; a
// short backoff window gives the editor time to upload and the next
// dispatcher tick re-tries.
type DispatchResult = {
  ok: boolean;
  error?: string;
  sfm_ok?: boolean;
  result?: Record<string, unknown> | null;
  deferred?: boolean;
  /** Backoff hint in seconds when deferred=true (default DEFER_BACKOFF_SEC). */
  defer_backoff_sec?: number;
  /**
   * W10-S2: set true when callEdgeFunction detected a Modal resource-limit
   * error (WORKER_RESOURCE_LIMIT substring OR matches MODAL_5XX_REGEX).
   * markFailed reads this flag and (a) writes payload.next_attempt_smaller_batch=true
   * so drone-render lowers PER_INVOCATION_CAP on the next tick, and (b) uses
   * the longer MODAL_RESOURCE_BACKOFF_SECONDS curve.
   */
  modal_resource_limit?: boolean;
};

// Default backoff window when a job is deferred (e.g. waiting on editor
// uploads). 5 minutes is short enough to feel responsive once the editor
// drops the file but long enough not to thrash the dispatcher tick budget.
const DEFER_BACKOFF_SEC = 300;

async function dispatchOne(
  _admin: ReturnType<typeof getAdminClient>,
  job: DroneJob,
  deadlineSignal: AbortSignal,
): Promise<DispatchResult> {
  switch (job.kind) {
    case "ingest":
      return await callEdgeFunction("drone-ingest", {
        project_id: job.payload?.project_id,
      }, deadlineSignal);
    case "render": {
      // Wave 5 P2 (S3): drone-render is the RAW pipeline only. If a legacy
      // edited-pipeline payload slips into a kind='render' row (pre-S3
      // dispatcher / direct DB write), reject loudly rather than letting
      // drone-render's own pipeline guard 400 it from inside (which would
      // burn dispatcher attempts unnecessarily). The job goes straight to
      // failed and the operator can re-enqueue as kind='render_edited'.
      const rawPipeline = job.payload?.pipeline;
      if (rawPipeline === 'edited') {
        return {
          ok: false,
          error:
            "legacy edited-pipeline render in kind=render row; should have been kind=render_edited",
        };
      }
      return await callEdgeFunction("drone-render", {
        shoot_id: job.payload?.shoot_id || job.shoot_id,
        // W12 P0 fix from E2E walker: per-shot render children from the
        // drone-raw-preview fan-out (W10-S2) carry payload.shot_id, but the
        // pre-fix dispatcher dropped it on the floor — drone-render then
        // rendered the WHOLE shoot, found everything already done, returned
        // shots_rendered=0/shots_already_rendered=N, and the dispatcher
        // dead-lettered the whole batch. Forward shot_id (also from the
        // top-level column W11-S2 added in commit 4917cb1 → fall back to
        // payload.shot_id for backwards compat).
        shot_id: job.shot_id || job.payload?.shot_id,
        // pipeline / column_state / allow_raw_source pass-through for the
        // raw-preview-per-shot path which runs raw pipeline + column_state="pool"
        // + allow_raw_source=true. Without these, drone-render falls back to
        // legacy edited-pipeline defaults and misroutes outputs.
        pipeline: job.payload?.pipeline,
        column_state: job.payload?.column_state,
        allow_raw_source: job.payload?.allow_raw_source === true,
        kind: job.payload?.kind || "poi_plus_boundary",
        // Pass-through `reason` so drone-render can route Pin Editor saves
        // to the drone_renders_adjusted/ folder + adjustments column state.
        reason: job.payload?.reason,
        // Pin Editor saves enqueue with payload.wipe_existing=true so the
        // adjustments lane regenerates with the new pins instead of stacking
        // alongside stale rows. Pass-through for any caller that sets it.
        wipe_existing: job.payload?.wipe_existing === true,
      }, deadlineSignal);
    }
    case "render_edited": {
      // Wave 5 P2 (S3): edited pipeline canonical renderer. Mirrors the
      // 'render' case but routes to drone-render-edited and propagates
      // edited-pipeline-specific fields (column_state, cascade, project_id).
      //
      // W10-S1: when payload.cascade=true (drone-pins-save's pin-edit
      // cascade enqueues this shape), pass parent_job_id so the fan-out
      // children get stamped with this orchestration row's id and the
      // mig 302 trigger can roll up children_summary on the parent.
      const isCascade = job.payload?.cascade === true;
      return await callEdgeFunction("drone-render-edited", {
        shoot_id: job.payload?.shoot_id || job.shoot_id,
        shot_id: job.payload?.shot_id,
        project_id: job.payload?.project_id || job.project_id,
        kind: job.payload?.kind || "poi_plus_boundary",
        column_state: job.payload?.column_state,
        reason: job.payload?.reason,
        cascade: isCascade,
        wipe_existing: job.payload?.wipe_existing === true,
        pipeline: 'edited',
        ...(isCascade ? { parent_job_id: job.id } : {}),
      }, deadlineSignal);
    }
    case "boundary_save_render_cascade":
      // Wave 5 P2 (S3): boundary save trigger. The dispatcher fans this out
      // to drone-render-edited with cascade=true and a fixed
      // 'boundary_edit_cascade' reason so the per-shot fan-out lands rows
      // in column_state='adjustments'. shoot_id is intentionally NULL —
      // the cascade scopes to the entire project. The render fan-out is
      // server-side in drone-render-edited (B.2 spec).
      //
      // W10-S1: stamp parent_job_id=job.id so fan-out children link back to
      // this orchestration row. The mig 302 trigger then rolls children
      // status into parent.children_summary + parent.terminal_status.
      return await callEdgeFunction("drone-render-edited", {
        project_id: job.payload?.project_id || job.project_id,
        shoot_id: null,
        cascade: true,
        kind: 'poi_plus_boundary',
        reason: 'boundary_edit_cascade',
        pipeline: 'edited',
        parent_job_id: job.id,
      }, deadlineSignal);
    // 'sfm' is the canonical kind per migration 225 CHECK constraint.
    // 'sfm_run' is a deprecated alias kept for forward-compat with any rows
    // still in the queue from prior deployments — accepted at dispatch time
    // only. New enqueues should always use 'sfm'. (#20 audit fix)
    case "sfm":
    case "sfm_run":
      return await callModalSfm({
        shoot_id: (job.payload?.shoot_id as string | undefined) || job.shoot_id,
      }, deadlineSignal);
    case "poi_fetch":
      // Hand the project_id to drone-pois. drone-pois reads its cache; if
      // empty/expired it fetches from the upstream provider and writes the
      // cache row. Either way the next render's inline fetchPois() finds
      // a warm row. project_id may live on the job row OR on its payload
      // (we always set it on payload when we enqueue from sfm-success).
      return await callEdgeFunction("drone-pois", {
        project_id:
          (job.payload?.project_id as string | undefined) || job.project_id,
      }, deadlineSignal);
    case "raw_preview_render":
      // Hand to drone-raw-preview, which renders every raw_proposed
      // non-SfM shot through the engine (POI + boundary overlay) so the
      // operator can SEE each candidate before locking the shortlist. Also
      // runs the smart-shortlist algorithm to flag is_ai_recommended.
      // W10-S2: pass parent_job_id=job.id so the per-shot child render
      // jobs drone-raw-preview fans out are linked back to THIS row via
      // drone_jobs.parent_job_id (mig 302 trigger refreshes children_summary).
      return await callEdgeFunction("drone-raw-preview", {
        shoot_id: (job.payload?.shoot_id as string | undefined) || job.shoot_id,
        parent_job_id: job.id,
      }, deadlineSignal);
    case "cadastral_fetch":
      // QC8 D-11: cadastral cache was cold for everyone because no kind=
      // cadastral_fetch job was ever enqueued. drone-cadastral itself is the
      // existing handler — it's also called inline by drone-render's
      // fetchCadastral but that bypasses the cache-warming path on the
      // dispatcher's service-role JWT (TODO #8 in drone-render). Enqueueing
      // explicitly here from the chain (alongside raw_preview_render) makes
      // sure the cache row exists by the time drone-render fires.
      return await callEdgeFunction("drone-cadastral", {
        project_id:
          (job.payload?.project_id as string | undefined) || job.project_id,
      }, deadlineSignal);
    default:
      return { ok: false, error: `unknown kind: ${job.kind}` };
  }
}

// ── Chain helpers ─────────────────────────────────────────────────────────
// resolveProjectIdForShoot: SfM job payloads only carry shoot_id, but the
// poi_fetch endpoint needs project_id (it owns the per-project cache row).
// The drone_jobs row claimed by claim_drone_jobs() also doesn't always have
// project_id populated. Fetch from drone_shoots.
async function resolveProjectIdForShoot(
  admin: ReturnType<typeof getAdminClient>,
  shootId: string,
): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("drone_shoots")
      .select("project_id")
      .eq("id", shootId)
      .maybeSingle();
    if (error) {
      console.warn(
        `[${GENERATOR}] resolveProjectIdForShoot(${shootId}) lookup failed: ${error.message}`,
      );
      return null;
    }
    return (data?.project_id as string | undefined) || null;
  } catch (e) {
    console.warn(
      `[${GENERATOR}] resolveProjectIdForShoot(${shootId}) threw: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// enqueueRawPreviewAfterPois: insert the chained raw_preview_render job that
// consumes a now-warm POI cache. Used both by the poi_fetch-success branch
// and by the fallback paths (project_id unresolvable / poi_fetch enqueue
// failed) where we want the operator to still get previews even without POIs
// drawn.
//
// This REPLACED the prior `enqueueRawPreviewAfterPois` — production-deliverable
// renders (kind='render') are no longer auto-chained. The operator must
// explicitly Lock the curated shortlist (drone-shortlist-lock, separate
// stream) which is responsible for enqueueing the kind='render' job that
// produces customer-facing output. Preview rows (column_state='preview') are
// excluded from the active-per-variant uniqueness scope (migration 243) so
// they coexist freely with whatever the Lock action produces later.
async function enqueueRawPreviewAfterPois(
  admin: ReturnType<typeof getAdminClient>,
  args: {
    projectId: string | null;
    shootId: string;
    chainedFrom: string;
    poiFetchSkipped: string | null;
  },
): Promise<void> {
  const scheduled = new Date(Date.now() + 10_000).toISOString();
  const { error } = await admin.from("drone_jobs").insert({
    project_id: args.projectId,
    shoot_id: args.shootId,
    kind: "raw_preview_render",
    status: "pending",
    payload: {
      shoot_id: args.shootId,
      chained_from: args.chainedFrom,
      ...(args.poiFetchSkipped
        ? { poi_fetch_skipped: args.poiFetchSkipped }
        : {}),
    },
    scheduled_for: scheduled,
  });
  if (error) {
    console.warn(
      `[${GENERATOR}] failed to chain raw_preview_render job after poi_fetch ${args.chainedFrom}: ${error.message}`,
    );
  }

  // QC8 D-11: ALSO enqueue cadastral_fetch alongside raw_preview_render so
  // the per-project cadastral cache row gets warmed before drone-render's
  // inline fetchCadastral runs. cadastral_fetch is independent of the
  // raw-preview render (parallel, not blocking) — both consume the warm POI
  // cache and the cadastral fetch is itself an independent NSW DCDB call.
  // Skip if no project_id (drone-cadastral takes project_id, not shoot_id).
  if (args.projectId) {
    const { error: cadErr } = await admin.from("drone_jobs").insert({
      project_id: args.projectId,
      shoot_id: args.shootId,
      kind: "cadastral_fetch",
      status: "pending",
      payload: {
        project_id: args.projectId,
        shoot_id: args.shootId,
        chained_from: args.chainedFrom,
      },
      scheduled_for: scheduled,
    });
    if (cadErr) {
      console.warn(
        `[${GENERATOR}] failed to chain cadastral_fetch job after poi_fetch ${args.chainedFrom}: ${cadErr.message}`,
      );
    }
  }
}

async function callModalSfm(args: {
  shoot_id: string | null | undefined;
}, deadlineSignal: AbortSignal): Promise<DispatchResult> {
  if (!args.shoot_id) {
    return { ok: false, error: "callModalSfm: shoot_id missing on job" };
  }
  const renderToken = Deno.env.get("FLEXSTUDIOS_RENDER_TOKEN") || "";
  if (!renderToken) {
    return { ok: false, error: "FLEXSTUDIOS_RENDER_TOKEN not set" };
  }

  // QC3-8 E2E13: compose Modal's per-call timeout with the dispatcher's
  // overall 110s deadline so a slow SfM doesn't push us past the platform
  // wall-clock kill.
  const composedSignal = AbortSignal.any([
    AbortSignal.timeout(SFM_HTTP_TIMEOUT_MS),
    deadlineSignal,
  ]);

  try {
    const resp = await fetch(MODAL_SFM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Send token as Bearer to keep it out of Modal's request-body error
        // logs. Body field retained for backward compat. (#7 audit)
        Authorization: `Bearer ${renderToken}`,
      },
      body: JSON.stringify({ _token: renderToken, shoot_id: args.shoot_id }),
      signal: composedSignal,
    });
    // Single-read body — see callEdgeFunction for rationale. (#35 audit)
    const rawText = await resp.text().catch(() => "");
    if (!resp.ok) {
      return {
        ok: false,
        error: `sfm_http returned ${resp.status}: ${rawText.slice(0, 400)}`,
      };
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(rawText);
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
  deadlineSignal: AbortSignal,
): Promise<DispatchResult> {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  // DRONE_DISPATCHER_JWT must be a real Supabase JWT (HS256/ES256). The
  // SUPABASE_SERVICE_ROLE_KEY env on this project is the new sb_secret_*
  // hashed format which fails getUserFromReq's JWT structure check, so the
  // previous fallback silently broke every dispatched call when the JWT was
  // unset. Fail loud instead. (#29 audit fix)
  const serviceKey = Deno.env.get("DRONE_DISPATCHER_JWT") || "";
  if (!serviceKey) {
    return {
      ok: false,
      error: "DRONE_DISPATCHER_JWT not set — cannot dispatch. Set it to a real Supabase service-role JWT (not the sb_secret_* env value).",
    };
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
      // QC3-8 E2E13: dispatcher 110s deadline — abort downstream Edge
      // Function calls if we run out of budget so we exit cleanly.
      signal: deadlineSignal,
    });

    // Body inspection: read the body ONCE as text and try to parse it as JSON.
    // The previous code did `resp.text().catch()` for the non-OK path then
    // `resp.json()` for the OK path — fine in isolation but brittle if the
    // path order ever flipped (you can't read a body twice). Single-read is
    // safer and lets the error branch report the same body shape. (#35 audit)
    const rawText = await resp.text().catch(() => "");

    if (!resp.ok) {
      const errMsg = `${fnName} returned ${resp.status}: ${rawText.slice(0, 300)}`;
      // W10-S2: Modal-error classifier. Detect resource-limit-style failures
      // so markFailed can use the longer backoff curve + flip the smaller-batch
      // flag on the retry payload. WORKER_RESOURCE_LIMIT is Modal's explicit
      // sentinel; the regex picks up the more general 5xx-from-Modal pattern
      // (drone-render surfaces this as "Modal returned 5\d\d" in error
      // strings via callModalRender).
      const isResourceLimit =
        errMsg.includes("WORKER_RESOURCE_LIMIT") || MODAL_5XX_REGEX.test(errMsg);
      return { ok: false, error: errMsg, modal_resource_limit: isResourceLimit };
    }

    // drone-render and drone-ingest both expose shots_total / shots_rendered
    // (or similar) in their response body — if shots_rendered === 0 with
    // shots_total > 0, that's a per-job failure even though HTTP was 200.
    let bodyJson: Record<string, unknown> | null = null;
    if (rawText.length > 0) {
      try {
        bodyJson = JSON.parse(rawText);
      } catch {
        // Not JSON — accept HTTP-200 as success.
        bodyJson = null;
      }
    }
    if (bodyJson && typeof bodyJson === "object") {
      if (
        typeof bodyJson.shots_total === "number" &&
        typeof bodyJson.shots_rendered === "number" &&
        bodyJson.shots_total > 0 &&
        bodyJson.shots_rendered === 0
      ) {
        // "0/N rendered" is the dispatcher's red-flag pattern — but a sub-
        // category of zero-rendered runs is benign: ALL eligible shots were
        // skipped because they have no edited_dropbox_path yet (editor team
        // owes the file). drone-render returns shots_skipped_no_edit so we
        // can distinguish "render genuinely failed" from "nothing to render
        // until the editor uploads".
        //
        // Treat the run as a DEFER (not failure) when EVERY shot processed
        // in this invocation was skipped_no_edit. drone-render caps each
        // invocation at PER_INVOCATION_CAP=4 shots and re-enqueues a
        // continuation for the rest, so the totals don't always satisfy
        // skipped + rendered === shots_total. We use shots_failed_this_run
        // (== shotsCapped.length - rendered) as the per-invocation
        // denominator: when skipped == failed_this_run AND rendered == 0,
        // every shot we tried this round was a no-edit skip. (Job goes back
        // to 'pending' with a short backoff window WITHOUT burning an
        // attempt — three back-to-back ticks while the editor is still
        // uploading would otherwise dead-letter the job. Live evidence: 3
        // dead-letter renders for Everton on 2026-04-25 hit this exact path
        // because the prior shots_total-based check excluded the multi-
        // invocation case.)
        const skipped =
          typeof bodyJson.shots_skipped_no_edit === "number"
            ? bodyJson.shots_skipped_no_edit
            : 0;
        const failedThisRun =
          typeof bodyJson.shots_failed_this_run === "number"
            ? bodyJson.shots_failed_this_run
            : -1;
        // W12 P0 fix from E2E walker: shots_already_rendered === shots_total
        // is genuine success, not failure. Happens when a per-shot render
        // child runs after a sibling already filled the row (raw-preview
        // fan-out + Pin Editor re-fire). Treat as success to drain the queue
        // cleanly.
        const alreadyRendered =
          typeof bodyJson.shots_already_rendered === "number"
            ? bodyJson.shots_already_rendered
            : 0;
        const allAlreadyRendered =
          alreadyRendered > 0 && alreadyRendered === bodyJson.shots_total;
        const allFailedAreSkipped =
          skipped > 0 && failedThisRun > 0 && skipped === failedThisRun;
        const totalsMatch =
          skipped > 0 &&
          skipped + (bodyJson.shots_rendered as number) === bodyJson.shots_total;
        if (allAlreadyRendered) {
          return {
            ok: true,
            result: bodyJson,
          };
        }
        if (allFailedAreSkipped || totalsMatch) {
          return {
            ok: true,
            deferred: true,
            result: bodyJson,
          };
        }
        // Pull a representative per-shot error if present.
        const firstErr = Array.isArray(bodyJson.results)
          ? (bodyJson.results as Array<{ ok: boolean; error?: string }>)
              .find((r) => r && r.ok === false)?.error
          : undefined;
        const errStr = `${fnName}: 0/${bodyJson.shots_total} shots rendered. ${
          firstErr ? `First error: ${String(firstErr).slice(0, 200)}` : ""
        }`.trim();
        // W10-S2: classifier also runs on the body-JSON 0/N error path,
        // where Modal-side failures arrive inside a per-shot result.error
        // rather than as a transport-level non-OK response.
        const isResourceLimit =
          errStr.includes("WORKER_RESOURCE_LIMIT") || MODAL_5XX_REGEX.test(errStr);
        return {
          ok: false,
          error: errStr,
          modal_resource_limit: isResourceLimit,
        };
      }
      if (bodyJson.success === false) {
        const errStr = `${fnName}: success=false, error=${bodyJson.error || "unknown"}`;
        const isResourceLimit =
          errStr.includes("WORKER_RESOURCE_LIMIT") || MODAL_5XX_REGEX.test(errStr);
        return {
          ok: false,
          error: errStr,
          modal_resource_limit: isResourceLimit,
        };
      }
    }
    return { ok: true, result: bodyJson };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// W14-S3: parse "<fnName> returned <NNN>:" / "Modal returned <NNN>" / "sfm_http
// returned <NNN>:" patterns out of the dispatcher's error strings so the
// errors[] array entry can carry a typed http_status. Returns null when the
// error didn't originate from an HTTP call (eg. timeout / shoot_id missing).
const HTTP_STATUS_FROM_ERR_REGEX = /returned\s+(\d{3})/;
function parseHttpStatusFromError(errMsg: string): number | null {
  const m = errMsg.match(HTTP_STATUS_FROM_ERR_REGEX);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function markFailed(
  admin: ReturnType<typeof getAdminClient>,
  job: DroneJob,
  errMsg: string,
  opts?: { modalResourceLimit?: boolean },
): Promise<void> {
  // claim_drone_jobs already incremented attempt_count when it claimed the
  // job, so job.attempt_count IS the count of attempts made (including this
  // failed one). The previous nextAttempt = (...) + 1 was an off-by-one that
  // killed jobs after MAX_ATTEMPTS-1 failures. (#31 audit fix)
  const attemptsSoFar = job.attempt_count || 1;
  // W10-S2: Modal resource-limit failures get a longer backoff curve and
  // a smaller-batch payload flag so the next tick has a better chance of
  // landing on a less-contended Modal worker.
  const isModalResLimit = opts?.modalResourceLimit === true;
  if (isModalResLimit) {
    console.warn(
      `[${GENERATOR}] Modal resource limit detected on job ${job.id}, using longer backoff + smaller batch on retry`,
    );
  }

  // W14-S3: Build the per-attempt audit entry once and append to drone_jobs.errors.
  // claim_drone_jobs doesn't return the existing errors array (would require an
  // RPC signature change), so we read it inline. The race window is bounded:
  // a job is in status='running' when markFailed runs, and only the dispatcher
  // tick that claimed it ever calls markFailed for that row, so concurrent
  // writers don't exist for a single job. error_message is preserved as the
  // most-recent error fragment for backwards compat (frontend / AlertsPanel /
  // older queries). (QC iter 7 F27 follow-through.)
  const newErrorEntry = {
    attempt: attemptsSoFar,
    message: errMsg.slice(0, 1000),
    http_status: parseHttpStatusFromError(errMsg),
    modal_resource_limit: isModalResLimit,
    occurred_at: new Date().toISOString(),
  };
  let nextErrors: Record<string, unknown>[] = [newErrorEntry];
  try {
    const { data: existing, error: readErr } = await admin
      .from("drone_jobs")
      .select("errors")
      .eq("id", job.id)
      .maybeSingle();
    if (readErr) {
      console.warn(
        `[${GENERATOR}] errors[] read failed for job ${job.id}: ${readErr.message} — entry will overwrite prior history`,
      );
    } else {
      const arr = (existing as { errors?: unknown } | null)?.errors;
      if (Array.isArray(arr)) {
        nextErrors = [...arr as Record<string, unknown>[], newErrorEntry];
      }
    }
  } catch (readEx) {
    const m = readEx instanceof Error ? readEx.message : String(readEx);
    console.warn(
      `[${GENERATOR}] errors[] read threw for job ${job.id}: ${m} — entry will overwrite prior history`,
    );
  }

  if (attemptsSoFar >= MAX_ATTEMPTS) {
    const { error: dlErr } = await admin
      .from("drone_jobs")
      .update({
        // The drone_jobs CHECK constraint allows 'dead_letter', not 'dead'.
        // The previous 'dead' value silently failed the UPDATE leaving the
        // job stuck in 'running' forever. (#32 audit fix)
        status: "dead_letter",
        finished_at: new Date().toISOString(),
        // W14-S3: error_message is now the most-recent fragment; the full
        // per-attempt history lives in errors[] (mig 333). Kept for
        // backwards compat with frontend / older queries.
        error_message: errMsg.slice(0, 1000),
        errors: nextErrors,
      })
      .eq("id", job.id);
    if (dlErr) {
      console.warn(`[${GENERATOR}] dead-letter mark failed for job ${job.id}: ${dlErr.message}`);
    }
  } else {
    const backoffCurve = isModalResLimit
      ? MODAL_RESOURCE_BACKOFF_SECONDS
      : BACKOFF_SECONDS;
    const backoffSec = backoffCurve[Math.min(attemptsSoFar - 1, backoffCurve.length - 1)];
    const next = new Date(Date.now() + backoffSec * 1000).toISOString();
    const updateRow: Record<string, unknown> = {
      status: "pending",
      scheduled_for: next,
      error_message: errMsg.slice(0, 1000),
      errors: nextErrors,
    };
    if (isModalResLimit) {
      // Merge into existing payload so shoot_id/kind/etc are preserved.
      updateRow.payload = {
        ...(job.payload || {}),
        next_attempt_smaller_batch: true,
      };
    }
    const { error: retryErr } = await admin
      .from("drone_jobs")
      .update(updateRow)
      .eq("id", job.id);
    if (retryErr) {
      console.warn(`[${GENERATOR}] retry-pending update failed for job ${job.id}: ${retryErr.message}`);
    }
  }
}

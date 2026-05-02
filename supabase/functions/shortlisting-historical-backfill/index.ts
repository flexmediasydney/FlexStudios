/**
 * shortlisting-historical-backfill
 * ────────────────────────────────
 * Wave 13a — manual-trigger backfill of legacy delivered FlexMedia projects
 * through the Shape D engine. Generates training_examples for W14 calibration
 * and seeds object_registry.market_frequency for W12.
 *
 * Spec: docs/design-specs/W13a-historical-flexmedia-goldmine.md
 *
 * ─── INVOCATION MODEL (manual-trigger only) ──────────────────────────────────
 *
 * Joseph alone fires this — no cron, no autonomous batch runner. Each call
 * processes exactly ONE project. The system never decides on its own to
 * process a queue. The endpoint:
 *
 *   POST /functions/v1/shortlisting-historical-backfill
 *   Authorization: Bearer <master_admin JWT>
 *   {
 *     "project_id": "<uuid of a delivered legacy project>",
 *     "raws_dropbox_path": "/Flex Media Team Folder/.../Photos/Raws",
 *     "finals_dropbox_path": "/Flex Media Team Folder/.../Photos/Finals",
 *     "cost_cap_usd": 5
 *   }
 *
 * ─── PIPELINE ────────────────────────────────────────────────────────────────
 *
 *   1. Pre-flight (synchronous):
 *      a. Project exists + status='delivered'
 *      b. No existing synthetic round for this project (no double-backfill;
 *         exception — a previous failed log row is archived and a fresh run
 *         starts).
 *      c. Both Dropbox paths exist + listable
 *      d. Cost estimate (raws + finals × ~$0.013/img stand-in for the Stage 1
 *         per-image call cost; rounded up to ~$1.30 / 33 angles per spec).
 *         Reject if estimate > cost_cap_usd.
 *      e. engine_settings.cost_cap_per_round_usd circuit breaker (default 10).
 *   2. INSERT shortlisting_rounds (is_synthetic_backfill=TRUE,
 *      status='backfilled', engine_mode='shape_d_full',
 *      backfill_source_paths={raws,finals}).
 *   3. INSERT shortlisting_backfill_log (status='queued', round_id set).
 *   4. INSERT shortlisting_jobs of kind='ingest' pointing at raws path. The
 *      existing dispatcher chain handles extract → pass0 → shape_d_stage1 →
 *      stage4_synthesis → persistence.
 *   5. Background work via EdgeRuntime.waitUntil:
 *      a. UPDATE log status='running' + started_at
 *      b. Cross-reference final filenames with composition_groups; populate
 *         composition_groups.synthetic_finals_match_stem on matches. (This
 *         step runs once Stage 4 has produced compositions; it polls.)
 *      c. Poll engine_run_audit.total_cost_usd; persist to log.cost_usd
 *         on completion.
 *      d. Watchdog: if actual cost > 1.5×estimate → abort + mark failed.
 *      e. Status transition: queued → running → succeeded|failed
 *
 * ─── COST DISCIPLINE ─────────────────────────────────────────────────────────
 *
 *   Layer 1 (pre-flight): caller's cost_cap_usd, hard 400 reject if exceeded.
 *   Layer 2 (system circuit breaker): engine_settings.cost_cap_per_round_usd,
 *           hard 400 reject if pre-flight estimate exceeds it.
 *   Layer 3 (background watchdog): actual_cost > 1.5×estimate → log row
 *           marked 'failed' with failure_reason='cost_overrun'.
 *
 * ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
 *
 *   - Re-running for a project with an existing succeeded log row → 409.
 *   - Re-running for a project with an in-flight (queued/running) log row →
 *     409 (operator must wait or manually mark it aborted).
 *   - Re-running for a project with only failed log rows → allowed; previous
 *     row stays for audit, fresh row created.
 *
 * ─── AUTH ───────────────────────────────────────────────────────────────────
 *
 *   master_admin only. Service-role disallowed (this is operator-fired only;
 *   no cron should ever reach here).
 *
 * ─── OUT OF SCOPE (handled by other functions) ───────────────────────────────
 *
 *   - The actual Shape D processing chain (existing functions handle it once
 *     the ingest job is queued).
 *   - shortlisting_training_examples insertion (a separate W13a follow-up
 *     extractor reads the synthetic round + finals match data and emits
 *     training rows).
 *   - object_registry.market_frequency aggregation (W12 separate pipeline).
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { listFolder } from '../_shared/dropbox.ts';
import { ENGINE_VERSION } from '../_shared/engineVersion.ts';

const GENERATOR = 'shortlisting-historical-backfill';

// Per-image cost stand-in: spec quotes ~$1.30 / 33 angles ≈ $0.0394/img for the
// Shape D Stage 1 + Stage 4 path. Use a slightly conservative $0.04 to stay
// safe against vendor price drift.
const COST_PER_IMAGE_USD = 0.04;

// Hard upper bound on synthetic rounds: spec uses ~$5 typical Premium ceiling.
// We let the caller pass anything; this is just the default if not supplied.
const DEFAULT_COST_CAP_USD = 5.0;

// Circuit breaker fallback when engine_settings load fails.
const FALLBACK_SYSTEM_COST_CAP_USD = 10.0;

// Image extensions we count toward cost (RAWs + finals JPEGs).
const RAW_EXT = ['.cr3', '.cr2', '.arw', '.nef', '.raf', '.dng'];
const FINAL_EXT = ['.jpg', '.jpeg', '.png', '.tif', '.tiff'];

interface RequestBody {
  project_id?: string;
  raws_dropbox_path?: string;
  finals_dropbox_path?: string;
  cost_cap_usd?: number;
  _health_check?: boolean;
}

interface PreflightResult {
  raws_count: number;
  finals_count: number;
  estimated_cost_usd: number;
  finals_filenames: string[]; // for later match-stem enrichment
  raws_filenames: string[];
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ─── Auth ──────────────────────────────────────────────────────────────────
  // master_admin only. Service-role disallowed here on purpose — no cron may
  // reach this code path. Manual-trigger discipline is enforced at the auth
  // boundary.
  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);
  if (user.id === '__service_role__') {
    return errorResponse(
      'Forbidden — historical backfill is master_admin manual-trigger only; service role disallowed',
      403,
      req,
    );
  }
  if (user.role !== 'master_admin') {
    return errorResponse('Forbidden — master_admin only', 403, req);
  }

  // ─── Body parsing ─────────────────────────────────────────────────────────
  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
  const rawsPath = typeof body.raws_dropbox_path === 'string'
    ? body.raws_dropbox_path.trim()
    : '';
  const finalsPath = typeof body.finals_dropbox_path === 'string'
    ? body.finals_dropbox_path.trim()
    : '';
  const costCapUsd = typeof body.cost_cap_usd === 'number' && body.cost_cap_usd > 0
    ? body.cost_cap_usd
    : DEFAULT_COST_CAP_USD;

  if (!projectId) return errorResponse('project_id required', 400, req);
  if (!rawsPath) return errorResponse('raws_dropbox_path required', 400, req);
  if (!finalsPath) return errorResponse('finals_dropbox_path required', 400, req);

  const admin = getAdminClient();

  // ─── Pre-flight: project + idempotency + paths + cost ──────────────────────
  // We log the attempt EARLY so even pre-flight rejections are auditable. The
  // log row is upgraded to 'queued' once the synthetic round is created;
  // pre-flight rejections write 'failed' with a failure_reason and return 4xx.

  let logRowId: string | null = null;
  const writeFailedLog = async (failureReason: string, raws_count?: number, finals_count?: number, estimated?: number): Promise<void> => {
    try {
      const { data } = await admin
        .from('shortlisting_backfill_log')
        .insert({
          project_id: projectId,
          round_id: null,
          raws_dropbox_path: rawsPath,
          finals_dropbox_path: finalsPath,
          status: 'failed',
          cost_cap_usd: costCapUsd,
          estimated_cost_usd: estimated ?? null,
          raws_count: raws_count ?? null,
          finals_count: finals_count ?? null,
          requested_by: user.id,
          completed_at: new Date().toISOString(),
          failure_reason: failureReason,
        })
        .select('id')
        .single();
      logRowId = data?.id ?? null;
    } catch (logErr) {
      const lmsg = logErr instanceof Error ? logErr.message : String(logErr);
      console.warn(`[${GENERATOR}] failed-log insert failed: ${lmsg}`);
    }
  };

  // 1. Project exists + status='delivered'
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, status, tonomo_package, project_type_id, dropbox_root_path')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) {
    await writeFailedLog(`project lookup failed: ${projErr.message}`);
    return errorResponse(`project lookup failed: ${projErr.message}`, 500, req);
  }
  if (!project) {
    await writeFailedLog('project not found');
    return errorResponse(`project ${projectId} not found`, 404, req);
  }
  if (project.status !== 'delivered') {
    await writeFailedLog(`project status is '${project.status}' — only 'delivered' projects are eligible`);
    return errorResponse(
      `project ${projectId} status is '${project.status}' — only 'delivered' projects are eligible for historical backfill`,
      400,
      req,
    );
  }

  // 2. Idempotency check — no double-backfill
  const { data: existingLogs, error: logErr } = await admin
    .from('shortlisting_backfill_log')
    .select('id, status, round_id, requested_at')
    .eq('project_id', projectId)
    .order('requested_at', { ascending: false });
  if (logErr) {
    await writeFailedLog(`backfill_log lookup failed: ${logErr.message}`);
    return errorResponse(`backfill_log lookup failed: ${logErr.message}`, 500, req);
  }
  const inFlight = (existingLogs || []).find((r) =>
    r.status === 'queued' || r.status === 'running'
  );
  if (inFlight) {
    return errorResponse(
      `project ${projectId} already has an in-flight backfill (log ${inFlight.id}, status=${inFlight.status}); wait or abort before retrying`,
      409,
      req,
    );
  }
  const succeeded = (existingLogs || []).find((r) => r.status === 'succeeded');
  if (succeeded) {
    return errorResponse(
      `project ${projectId} already has a successful backfill (log ${succeeded.id}, round ${succeeded.round_id}); refusing double-backfill`,
      409,
      req,
    );
  }

  // 3. Pre-flight: list both Dropbox paths
  let preflight: PreflightResult;
  try {
    preflight = await preflightDropbox(rawsPath, finalsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeFailedLog(`dropbox pre-flight failed: ${msg}`);
    return errorResponse(`dropbox pre-flight failed: ${msg}`, 400, req);
  }
  if (preflight.raws_count === 0) {
    await writeFailedLog(
      'raws path is empty (no recognised RAW files)',
      preflight.raws_count,
      preflight.finals_count,
      preflight.estimated_cost_usd,
    );
    return errorResponse(
      `raws_dropbox_path '${rawsPath}' contains no recognised RAW files (expected one of ${RAW_EXT.join('/')})`,
      400,
      req,
    );
  }
  if (preflight.finals_count === 0) {
    await writeFailedLog(
      'finals path is empty (no recognised image files)',
      preflight.raws_count,
      preflight.finals_count,
      preflight.estimated_cost_usd,
    );
    return errorResponse(
      `finals_dropbox_path '${finalsPath}' contains no recognised image files (expected one of ${FINAL_EXT.join('/')})`,
      400,
      req,
    );
  }

  // 4. Cost gate: caller-supplied cap
  if (preflight.estimated_cost_usd > costCapUsd) {
    await writeFailedLog(
      `estimate $${preflight.estimated_cost_usd.toFixed(4)} exceeds caller cost_cap_usd $${costCapUsd.toFixed(4)}`,
      preflight.raws_count,
      preflight.finals_count,
      preflight.estimated_cost_usd,
    );
    return errorResponse(
      `estimated cost $${preflight.estimated_cost_usd.toFixed(4)} (${preflight.raws_count} raws + ${preflight.finals_count} finals @ $${COST_PER_IMAGE_USD}/img) exceeds cost_cap_usd $${costCapUsd.toFixed(4)}`,
      400,
      req,
    );
  }

  // 5. System circuit breaker: engine_settings.cost_cap_per_round_usd
  const systemCap = await loadSystemCostCap(admin);
  if (preflight.estimated_cost_usd > systemCap) {
    await writeFailedLog(
      `estimate $${preflight.estimated_cost_usd.toFixed(4)} exceeds engine_settings.cost_cap_per_round_usd $${systemCap.toFixed(4)}`,
      preflight.raws_count,
      preflight.finals_count,
      preflight.estimated_cost_usd,
    );
    return errorResponse(
      `estimated cost $${preflight.estimated_cost_usd.toFixed(4)} exceeds system circuit breaker engine_settings.cost_cap_per_round_usd ($${systemCap.toFixed(4)})`,
      400,
      req,
    );
  }

  // ─── Synthetic round + ingest job ──────────────────────────────────────────
  // All pre-flight gates passed. Insert the synthetic round, the log row, and
  // the ingest job atomically (best-effort — if any step after round creation
  // fails, we mark the log 'failed').

  const startedAt = new Date().toISOString();

  // Determine next round_number for this project (matches shortlisting-ingest)
  const { data: roundRows, error: roundLookupErr } = await admin
    .from('shortlisting_rounds')
    .select('round_number')
    .eq('project_id', projectId)
    .order('round_number', { ascending: false })
    .limit(1);
  if (roundLookupErr) {
    await writeFailedLog(`round_number lookup failed: ${roundLookupErr.message}`);
    return errorResponse(`round_number lookup failed: ${roundLookupErr.message}`, 500, req);
  }
  const nextRoundNumber = (roundRows && roundRows.length > 0
    ? (roundRows[0].round_number || 0)
    : 0) + 1;

  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .insert({
      project_id: projectId,
      round_number: nextRoundNumber,
      status: 'backfilled',
      package_type: project.tonomo_package || null,
      package_ceiling: preflight.finals_count, // collapse target/min/max to delivered finals count
      expected_count_target: preflight.finals_count,
      expected_count_min: preflight.finals_count,
      expected_count_max: preflight.finals_count,
      total_compositions: null,
      trigger_source: 'historical_backfill',
      started_at: startedAt,
      engine_version: ENGINE_VERSION,
      engine_mode: 'shape_d_full',
      is_synthetic_backfill: true,
      backfill_source_paths: { raws: rawsPath, finals: finalsPath },
    })
    .select('id, round_number')
    .single();
  if (roundErr || !round) {
    const msg = roundErr?.message || 'no row returned';
    await writeFailedLog(`synthetic round insert failed: ${msg}`);
    return errorResponse(`synthetic round insert failed: ${msg}`, 500, req);
  }
  const roundId: string = round.id;

  // Log row — status='queued' with synthetic round attached
  const { data: logRow, error: logInsertErr } = await admin
    .from('shortlisting_backfill_log')
    .insert({
      project_id: projectId,
      round_id: roundId,
      raws_dropbox_path: rawsPath,
      finals_dropbox_path: finalsPath,
      status: 'queued',
      cost_cap_usd: costCapUsd,
      estimated_cost_usd: preflight.estimated_cost_usd,
      raws_count: preflight.raws_count,
      finals_count: preflight.finals_count,
      requested_by: user.id,
    })
    .select('id')
    .single();
  if (logInsertErr || !logRow) {
    const msg = logInsertErr?.message || 'no row returned';
    // We have an orphaned synthetic round — flag and continue. The reconciliation
    // can pick this up via "rounds where is_synthetic_backfill=true AND no log row".
    console.error(`[${GENERATOR}] log insert failed for round ${roundId}: ${msg}`);
    return errorResponse(`backfill_log insert failed: ${msg}`, 500, req);
  }
  logRowId = logRow.id;

  // Audit event (best-effort; never fail the request on event insert).
  try {
    const { error: evtErr } = await admin
      .from('shortlisting_events')
      .insert({
        project_id: projectId,
        round_id: roundId,
        event_type: 'backfill_round_started',
        actor_type: 'user',
        actor_id: user.id,
        payload: {
          log_id: logRowId,
          raws_count: preflight.raws_count,
          finals_count: preflight.finals_count,
          estimated_cost_usd: preflight.estimated_cost_usd,
          cost_cap_usd: costCapUsd,
          raws_dropbox_path: rawsPath,
          finals_dropbox_path: finalsPath,
        },
      });
    if (evtErr) {
      console.warn(`[${GENERATOR}] event insert failed (non-fatal): ${evtErr.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${GENERATOR}] event insert threw (non-fatal): ${msg}`);
  }

  // ─── Background work: ingest job + match-stem enrichment + cost watchdog ──
  // We return ack immediately; the dispatcher chain handles the actual Shape D
  // processing. The background promise here only:
  //   (a) inserts the ingest job (synchronously)
  //   (b) updates log status to 'running' once we know the chain is in flight
  //   (c) cross-references finals filenames with composition_groups once
  //       Stage 4 has run (polled with backoff)
  //   (d) reads engine_run_audit.total_cost_usd and stamps log.cost_usd
  //   (e) abort + 'failed' if cost exceeds 1.5× estimate

  // logRowId is non-null at this point (we just inserted it above and returned
  // 500 if the insert failed). Cast to satisfy the BackgroundOpts.logRowId
  // string contract — null branch is unreachable here.
  const bgLogRowId: string = logRowId as string;
  const bgWork = runBackgroundChain({
    admin,
    logRowId: bgLogRowId,
    projectId,
    roundId,
    rawsPath,
    finalsPath,
    rawsFilenames: preflight.raws_filenames,
    finalsFilenames: preflight.finals_filenames,
    estimatedCostUsd: preflight.estimated_cost_usd,
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] background chain failed for round ${roundId}: ${msg}`);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      mode: 'background',
      round_id: roundId,
      round_number: round.round_number,
      log_id: logRowId,
      raws_count: preflight.raws_count,
      finals_count: preflight.finals_count,
      estimated_cost_usd: preflight.estimated_cost_usd,
      cost_cap_usd: costCapUsd,
      started_at: startedAt,
    },
    200,
    req,
  );
});

// ─── Pre-flight helpers ─────────────────────────────────────────────────────

async function preflightDropbox(rawsPath: string, finalsPath: string): Promise<PreflightResult> {
  const [rawsResult, finalsResult] = await Promise.all([
    listFolder(rawsPath, { recursive: false, maxEntries: 5000 }).catch((err) => {
      throw new Error(`raws path '${rawsPath}': ${err instanceof Error ? err.message : String(err)}`);
    }),
    listFolder(finalsPath, { recursive: false, maxEntries: 5000 }).catch((err) => {
      throw new Error(`finals path '${finalsPath}': ${err instanceof Error ? err.message : String(err)}`);
    }),
  ]);

  const rawsFilenames: string[] = [];
  for (const e of rawsResult.entries) {
    if (e['.tag'] === 'file' && typeof e.name === 'string') {
      const lower = e.name.toLowerCase();
      if (RAW_EXT.some((ext) => lower.endsWith(ext))) {
        rawsFilenames.push(e.name);
      }
    }
  }
  const finalsFilenames: string[] = [];
  for (const e of finalsResult.entries) {
    if (e['.tag'] === 'file' && typeof e.name === 'string') {
      const lower = e.name.toLowerCase();
      if (FINAL_EXT.some((ext) => lower.endsWith(ext))) {
        finalsFilenames.push(e.name);
      }
    }
  }

  const totalImgs = rawsFilenames.length + finalsFilenames.length;
  const estimated = +(totalImgs * COST_PER_IMAGE_USD).toFixed(4);

  return {
    raws_count: rawsFilenames.length,
    finals_count: finalsFilenames.length,
    estimated_cost_usd: estimated,
    raws_filenames: rawsFilenames,
    finals_filenames: finalsFilenames,
  };
}

async function loadSystemCostCap(
  admin: ReturnType<typeof getAdminClient>,
): Promise<number> {
  try {
    const { data, error } = await admin
      .from('engine_settings')
      .select('value')
      .eq('key', 'cost_cap_per_round_usd')
      .maybeSingle();
    if (error || !data) return FALLBACK_SYSTEM_COST_CAP_USD;
    const v = (data as { value: unknown }).value;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isNaN(n) ? FALLBACK_SYSTEM_COST_CAP_USD : n;
    }
    return FALLBACK_SYSTEM_COST_CAP_USD;
  } catch {
    return FALLBACK_SYSTEM_COST_CAP_USD;
  }
}

// ─── Background chain ────────────────────────────────────────────────────────

interface BackgroundOpts {
  admin: ReturnType<typeof getAdminClient>;
  logRowId: string;
  projectId: string;
  roundId: string;
  rawsPath: string;
  finalsPath: string;
  rawsFilenames: string[];
  finalsFilenames: string[];
  estimatedCostUsd: number;
}

/**
 * Background chain: enqueue ingest, update log status, poll for completion,
 * enrich composition_groups with finals match stems, watchdog cost.
 *
 * The synthetic round goes through the existing dispatcher chain:
 *   ingest → extract → pass0 → shape_d_stage1 → stage4_synthesis
 *
 * We don't drive the chain ourselves — we observe + enrich + reconcile.
 */
async function runBackgroundChain(opts: BackgroundOpts): Promise<void> {
  const {
    admin, logRowId, projectId, roundId, rawsPath, rawsFilenames,
    finalsFilenames, estimatedCostUsd,
  } = opts;

  // Step 1: Insert the ingest job. The ingest fn will list the raws path
  // itself (matches its existing contract) and chain extracts → pass0 →
  // shape_d_stage1 → stage4. We do NOT pass file_paths in the payload —
  // shortlisting-ingest reads from project's raw folder. NOTE: the existing
  // ingest fn uses getFolderPath() which reads the project's standard layout.
  // For backfill we want to honor the caller-supplied raws_dropbox_path even
  // when it differs from the project's standard layout. We sidestep ingest
  // and queue the extract jobs directly using the explicit paths.

  try {
    await enqueueExtractJobs({
      admin,
      projectId,
      roundId,
      rawsPath,
      rawsFilenames,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markLogFailed(admin, logRowId, `extract_enqueue_failed: ${msg}`);
    return;
  }

  // Step 2: log status → 'running'
  try {
    await admin
      .from('shortlisting_backfill_log')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', logRowId);
  } catch (err) {
    console.warn(`[${GENERATOR}] log status->running update failed: ${err instanceof Error ? err.message : err}`);
  }

  // Step 3: Poll for completion. The dispatcher will eventually move the
  // round through stage 4. We poll engine_run_audit and shortlisting_rounds
  // every 30 seconds for up to 30 minutes (matches the worst-case wall budget
  // for a Premium project).
  const POLL_INTERVAL_MS = 30_000;
  const MAX_WALL_MS = 30 * 60_000;
  const startedAt = Date.now();
  let succeeded = false;
  let failureReason: string | null = null;
  let actualCostUsd: number | null = null;

  while (Date.now() - startedAt < MAX_WALL_MS) {
    await sleep(POLL_INTERVAL_MS);

    // Check engine_run_audit
    const { data: audit } = await admin
      .from('engine_run_audit')
      .select('completed_at, total_cost_usd, error_summary, stages_failed')
      .eq('round_id', roundId)
      .maybeSingle();

    if (audit) {
      const cost = Number((audit as { total_cost_usd: number | string }).total_cost_usd) || 0;
      actualCostUsd = cost;

      // Cost watchdog
      if (cost > estimatedCostUsd * 1.5) {
        failureReason = `cost_overrun: actual $${cost.toFixed(4)} > 1.5× estimate $${estimatedCostUsd.toFixed(4)}`;
        break;
      }

      if (audit.completed_at) {
        const failed = Array.isArray(audit.stages_failed) && audit.stages_failed.length > 0;
        if (failed || audit.error_summary) {
          failureReason = `engine_failed: ${audit.error_summary || 'stages_failed=' + JSON.stringify(audit.stages_failed)}`;
        } else {
          succeeded = true;
        }
        break;
      }
    }

    // Also check shortlisting_jobs for dead_letter (engine_run_audit rollup
    // may not be written yet at the time a job dead-letters).
    const { count: deadLetterCount } = await admin
      .from('shortlisting_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('round_id', roundId)
      .eq('status', 'dead_letter');
    if ((deadLetterCount ?? 0) > 0) {
      failureReason = `engine_failed: one or more jobs reached dead_letter`;
      break;
    }

    // QC-iter2-W7 F-B-014: engine_run_audit.completed_at is the canonical
    // success signal but the rollup occasionally lags the round-status flip
    // by 30-90s. Fall back to shortlisting_rounds.status so we don't burn
    // the full 30-minute wall_timeout when the round has actually finished.
    if (!audit?.completed_at) {
      const { data: round } = await admin
        .from('shortlisting_rounds')
        .select('status')
        .eq('id', roundId)
        .maybeSingle();
      const status = (round as { status?: string } | null)?.status;
      if (status === 'proposed' || status === 'locked') {
        succeeded = true;
        break;
      }
      if (status === 'failed') {
        failureReason = `engine_failed: round status='failed' (engine_run_audit rollup lag)`;
        break;
      }
    }
  }

  if (!succeeded && !failureReason) {
    failureReason = `wall_timeout: round did not complete within ${Math.round(MAX_WALL_MS / 60_000)} minutes`;
  }

  if (succeeded) {
    // Step 4: Enrich composition_groups with finals match stems. This is the
    // signal that powers W14 calibration: which compositions did the human
    // editor actually pick?
    try {
      const matched = await enrichFinalsMatchStems({
        admin,
        roundId,
        finalsFilenames,
      });
      console.log(`[${GENERATOR}] enrichment matched ${matched} of ${finalsFilenames.length} finals to compositions for round ${roundId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] finals-stems enrichment failed: ${msg}`);
    }

    // Mark succeeded
    await admin
      .from('shortlisting_backfill_log')
      .update({
        status: 'succeeded',
        completed_at: new Date().toISOString(),
        cost_usd: actualCostUsd,
      })
      .eq('id', logRowId);

    await admin
      .from('shortlisting_events')
      .insert({
        project_id: projectId,
        round_id: roundId,
        event_type: 'backfill_round_completed',
        actor_type: 'system',
        payload: {
          log_id: logRowId,
          actual_cost_usd: actualCostUsd,
          estimated_cost_usd: estimatedCostUsd,
          finals_matched: finalsFilenames.length,
        },
      });
  } else {
    await markLogFailed(admin, logRowId, failureReason!, actualCostUsd);
  }
}

async function enqueueExtractJobs(opts: {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  roundId: string;
  rawsPath: string;
  rawsFilenames: string[];
}): Promise<void> {
  const { admin, projectId, roundId, rawsPath, rawsFilenames } = opts;
  const CHUNK_SIZE = 50;

  const filePaths = rawsFilenames.map((name) => `${rawsPath}/${name}`).sort();
  if (filePaths.length === 0) {
    throw new Error('no raws to enqueue (preflight should have caught this)');
  }

  const chunkRows: Array<Record<string, unknown>> = [];
  const chunkTotal = Math.ceil(filePaths.length / CHUNK_SIZE);
  for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + CHUNK_SIZE);
    chunkRows.push({
      project_id: projectId,
      round_id: roundId,
      kind: 'extract',
      status: 'pending',
      payload: {
        project_id: projectId,
        round_id: roundId,
        file_paths: chunk,
        chunk_index: Math.floor(i / CHUNK_SIZE),
        chunk_total: chunkTotal,
        is_synthetic_backfill: true,
      },
      scheduled_for: new Date().toISOString(),
    });
  }

  const { error } = await admin
    .from('shortlisting_jobs')
    .insert(chunkRows);
  if (error) {
    throw new Error(`extract job batch insert failed: ${error.message}`);
  }
}

/**
 * Cross-reference final filenames with composition_groups for the synthetic
 * round; UPDATE composition_groups.synthetic_finals_match_stem when a match
 * is found.
 *
 * The matching strategy mirrors the spec:
 *   - Strip extension; lowercase; collapse whitespace
 *   - For each composition_group with a delivery_reference_stem, check whether
 *     ANY final's normalized stem starts with the composition stem (or vice
 *     versa). The composition group is a 3-7 file bracket; the editor's chosen
 *     final is typically the centre frame, so the final's stem will share the
 *     prefix.
 *   - Fall back to direct stem equality when prefix-matching is ambiguous.
 *
 * Returns the number of matches written.
 */
async function enrichFinalsMatchStems(opts: {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  finalsFilenames: string[];
}): Promise<number> {
  const { admin, roundId, finalsFilenames } = opts;

  if (finalsFilenames.length === 0) return 0;

  const { data: groups, error } = await admin
    .from('composition_groups')
    .select('id, delivery_reference_stem')
    .eq('round_id', roundId);
  if (error) throw new Error(`composition_groups fetch failed: ${error.message}`);
  if (!groups || groups.length === 0) return 0;

  const finalsStems = finalsFilenames.map((name) => normalizeStem(stripExt(name)));

  let matched = 0;
  for (const group of groups as Array<{ id: string; delivery_reference_stem: string | null }>) {
    if (!group.delivery_reference_stem) continue;
    const groupStem = normalizeStem(group.delivery_reference_stem);
    const finalMatch = finalsStems.find((fs) =>
      fs === groupStem || fs.startsWith(groupStem) || groupStem.startsWith(fs)
    );
    if (finalMatch) {
      const { error: updErr } = await admin
        .from('composition_groups')
        .update({ synthetic_finals_match_stem: finalMatch })
        .eq('id', group.id);
      if (updErr) {
        console.warn(`[${GENERATOR}] match-stem update failed for group ${group.id}: ${updErr.message}`);
      } else {
        matched++;
      }
    }
  }
  return matched;
}

function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

function normalizeStem(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
}

async function markLogFailed(
  admin: ReturnType<typeof getAdminClient>,
  logRowId: string,
  reason: string,
  costUsd: number | null = null,
): Promise<void> {
  try {
    await admin
      .from('shortlisting_backfill_log')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        failure_reason: reason,
        cost_usd: costUsd,
      })
      .eq('id', logRowId);
  } catch (err) {
    console.error(`[${GENERATOR}] mark-failed update failed: ${err instanceof Error ? err.message : err}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * shortlist-lock
 * ──────────────
 * Per-round batch action invoked from the photo Shortlisting swimlane
 * "Lock & Reorganize" button.
 *
 * After the human reviewer has triaged AI proposals into Approved / Rejected
 * via drag-drop in the swimlane, this function physically reorganises the
 * underlying Dropbox RAW files so the team can browse Photos/Raws/{Final
 * Shortlist, Rejected, ...}/ alongside the app and see the curated state.
 *
 * For each composition_group in the round, the resolved disposition is:
 *
 *   approved  → all RAW files in files_in_group move to Photos/Raws/Final Shortlist/
 *   rejected  → all RAW files in files_in_group move to Photos/Raws/Rejected/
 *   undecided → leave alone (operator hasn't decided yet)
 *
 * Resolution rule (deterministic, mirrors the swimlane's column logic):
 *   Initial AI shortlist set =
 *     groups with a `pass2_slot_assigned` rank=1 event OR a
 *     `pass2_phase3_recommendation` event.
 *   Apply overrides on top:
 *     human_action='approved_as_proposed' → keep in approved set
 *     human_action='added_from_rejects'   → add to approved set
 *     human_action='removed'              → remove from approved set
 *     human_action='swapped'              → human_selected_group_id replaces
 *                                            ai_proposed_group_id in the set
 *   Approved = final approved set
 *   Rejected = (groups with classification.is_near_duplicate_candidate=TRUE)
 *              UNION (groups removed by human override)
 *   Undecided = neither (left in place)
 *
 * ─── Wave 7 P0-1 rewrite ──────────────────────────────────────────────────
 * The previous implementation did per-file `/files/move_v2` calls in a 6-worker
 * concurrent loop. Dropbox's per-namespace write rate limit (~5-15 req/s under
 * sustained load) meant a 165-file Round 2 lock hit the 150s edge gateway
 * timeout, the DB transitioned to status='locked' regardless, and recovery
 * required ~30 minutes of manual revert/retry cycles.
 *
 * The new flow uses Dropbox's `/files/move_batch_v2` (async, up to 10,000
 * entries per call):
 *   1. Build the move list (same logic as before, now in `buildMoveSpecs`)
 *   2. INSERT shortlisting_lock_progress(stage='submitting', total_moves, ...)
 *   3. Submit ALL non-idempotent moves in one batch call
 *   4. UPDATE progress(stage='polling', async_job_id=<dropbox id>)
 *   5. EdgeRuntime.waitUntil(pollUntilComplete(progressId)) — fire-and-forget
 *   6. Return immediately with status='in_progress' + progress_id + async_job_id
 *
 * Background polling:
 *   - Poll /files/move_batch/check_v2 every 3s, up to 60 attempts (~3 min)
 *   - On '.tag' === 'complete': iterate entries, count successes/failures,
 *     stage→'finalizing'
 *   - On finalizing: flip round.status='locked', invoke training extractor,
 *     stage→'complete'
 *   - On '.tag' === 'failed' OR poll exhausted: stage→'failed', error_message
 *
 * Idempotent: a file whose Dropbox path already starts with the destination
 * folder is skipped without an API call. Re-running after a partial failure
 * picks up where it left off.
 *
 * POST { round_id, resume?: boolean }
 *
 * Auth: master_admin / admin / manager OR service_role.
 *
 * Response (immediate, before background poll completes):
 *   {
 *     ok: true,
 *     status: 'in_progress' | 'complete' (when no work / already locked),
 *     round_id,
 *     progress_id?: <uuid>,
 *     async_job_id?: <dropbox id>,
 *     total_moves: N,
 *     moved: { approved, rejected }  // only on already_locked / no-work paths
 *   }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  invokeFunction,
} from '../_shared/supabase.ts';
import { getShortlistingFolders } from '../_shared/shortlistingFolders.ts';
import {
  moveBatch,
  checkMoveBatch,
  uploadFile,
  type DropboxBatchEntryResult,
  type DropboxMoveEntry,
} from '../_shared/dropbox.ts';
import {
  buildMoveSpecs,
  computeApprovedRejectedSets,
  type CompositionGroupForLock,
  type SlotEventForLock,
  type OverrideForLock,
  type ClassificationForLock,
  type MoveSpec,
} from '../_shared/shortlistLockMoves.ts';
import {
  buildAuditJson,
  buildAuditJsonPath,
  serializeAuditJson,
  type AuditApprovedInput,
  type AuditJsonMode,
  type AuditOverrideRow,
  type AuditRejectedInput,
} from '../_shared/auditJsonBuilder.ts';
import {
  resolveManualLockMoves,
  type ManualLockSourceFile,
} from '../_shared/manualModeResolver.ts';
import { listFolder } from '../_shared/dropbox.ts';

const GENERATOR = 'shortlist-lock';

// Background poll cadence + cap.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // ~3 minutes total before we mark failed
// Cap on the size of errors_sample we persist on the progress row. The full
// failed_moves count is still tracked, but we only retain the first N for
// operator inspection — keeps the row small (and JSONB usable in admin UIs).
const ERRORS_SAMPLE_CAP = 20;

interface LockBody {
  round_id?: string;
  resume?: boolean;
  _health_check?: boolean;
  /**
   * Wave 7 P1-19 (W7.13): manual-mode opt-in. Default 'engine' (today's
   * behaviour: read AI proposals + human overrides, resolve approved/rejected
   * sets via slot events). 'manual' bypasses the engine resolution and uses
   * `approved_stems` directly — for project types where shortlisting_supported
   * = false OR expected_count_target = 0.
   */
  mode?: 'engine' | 'manual';
  /**
   * Wave 7 P1-19 (W7.13): operator-curated approved set in manual mode.
   * Filename stems (with or without extension) the operator dragged into the
   * approved column. Required when mode='manual'; ignored when mode='engine'.
   */
  approved_stems?: string[];
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden — only master_admin/admin/manager can lock shortlist', 403, req);
    }
  }

  let body: LockBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v2.0-batch', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id?.trim();
  if (!roundId) return errorResponse('round_id required', 400, req);
  const resume = body.resume === true;

  // Wave 7 P1-19 (W7.13): mode dispatch. 'engine' is the today's-behaviour
  // default; 'manual' bypasses AI-proposal resolution and uses the operator-
  // curated approved_stems[] directly. Validation of approved_stems happens
  // inside lockManualMode after we've loaded the round (the round's status
  // also needs to be 'manual' — defence in depth).
  const mode: 'engine' | 'manual' = body.mode === 'manual' ? 'manual' : 'engine';
  const approvedStems = Array.isArray(body.approved_stems) ? body.approved_stems : [];
  if (mode === 'manual' && approvedStems.length === 0) {
    return errorResponse(
      'mode=manual requires non-empty approved_stems[]',
      400,
      req,
    );
  }

  const admin = getAdminClient();

  // ── Load round + project ────────────────────────────────────────────────
  // Wave 7 P1-12 (W7.4): also pull round_number + package_type for the audit
  // JSON mirror written at finalize. engine_version + tier_used are NOT
  // columns on shortlisting_rounds today (mig 282); the audit builder accepts
  // null for both and the JSON shape is forward-compat — if a future migration
  // adds those columns, extend the select here.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, locked_at, locked_by, round_number, package_type')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) return errorResponse(`round lookup failed: ${roundErr.message}`, 500, req);
  if (!round) return errorResponse(`round ${roundId} not found`, 404, req);

  // ── Burst 5 K1: idempotent re-lock short-circuit ────────────────────────
  // If the round is already locked, return the prior result from the audit
  // event without re-running file moves OR re-invoking the training extractor.
  if (round.status === 'locked') {
    const { data: priorEvent } = await admin
      .from('shortlisting_events')
      .select('payload, created_at')
      .eq('round_id', roundId)
      .eq('event_type', 'shortlist_locked')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const priorPayload = (priorEvent?.payload || {}) as Record<string, unknown>;
    return jsonResponse(
      {
        ok: true,
        status: 'complete',
        round_id: roundId,
        already_locked: true,
        locked_at: round.locked_at,
        moved: {
          approved: (priorPayload.moved_approved as number) ?? 0,
          rejected: (priorPayload.moved_rejected as number) ?? 0,
        },
        skipped: (priorPayload.skipped as number) ?? 0,
      },
      200,
      req,
    );
  }

  // ── Resume guard ────────────────────────────────────────────────────────
  // If a prior progress row exists and is still in flight, refuse to start
  // another. This prevents a browser double-click or pg_net retry from
  // submitting a second batch in parallel — Dropbox would happily move the
  // files twice (the first to dest, the second errors with to/conflict).
  const { data: priorProgress } = await admin
    .from('shortlisting_lock_progress')
    .select('id, stage, async_job_id, started_at')
    .eq('round_id', roundId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorProgress && !resume) {
    if (priorProgress.stage === 'submitting' || priorProgress.stage === 'polling' || priorProgress.stage === 'finalizing') {
      return errorResponse(
        `Lock already in flight for round ${roundId} (stage=${priorProgress.stage}, started_at=${priorProgress.started_at}). Wait for completion or call shortlist-lock-status.`,
        409,
        req,
      );
    }
    if (priorProgress.stage === 'failed') {
      return errorResponse(
        `Lock previously failed for round ${roundId}. Call again with { round_id, resume: true } to retry.`,
        409,
        req,
      );
    }
    // 'pending' is a transient state — we've never seen it persist in steady
    // state. Safe to retry from scratch.
  }

  if (priorProgress && resume) {
    if (priorProgress.stage === 'complete') {
      // Already done — short-circuit caller.
      return jsonResponse(
        { ok: true, status: 'complete', round_id: roundId, progress_id: priorProgress.id },
        200,
        req,
      );
    }
    if (priorProgress.stage !== 'failed') {
      return errorResponse(
        `Cannot resume — prior lock is ${priorProgress.stage}, not failed. Call shortlist-lock-status to check progress.`,
        409,
        req,
      );
    }
    // Falls through to full rebuild below; we DELETE the failed row before
    // INSERTING the new one (UNIQUE constraint is per-round).
  }

  // ── Resolve destination folder paths ────────────────────────────────────
  let folders;
  try {
    folders = await getShortlistingFolders(round.project_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(
      `Project Photos/* folders not provisioned: ${msg}`,
      500,
      req,
    );
  }

  // ── Wave 7 P1-19 (W7.13) Manual-mode branch ─────────────────────────────
  // Manual mode skips the engine resolution path entirely (no
  // composition_groups, no classifications, no slot events, no overrides).
  // We list the source folder, resolve approved_stems against the file list,
  // run the same move_batch_v2 + finalize + audit-mirror flow.
  if (mode === 'manual') {
    return await lockManualMode({
      req,
      admin,
      roundId,
      round,
      approvedStems,
      approvedDest: folders.rawFinalShortlist,
      sourceDest: folders.rawShortlist,
      isService,
      lockedBy: isService ? null : (user?.id ?? null),
      priorProgress,
      resume,
    });
  }

  // ── Load groups + classifications + events + overrides ──────────────────
  // Wave 7 P1-12 (W7.4): the classifications + overrides selects pull more
  // fields than buildMoveSpecs strictly needs — combined_score on the
  // classification, ai_proposed_score on the override, and `select(*)` on
  // overrides — so finalizeRound can assemble the audit JSON without a second
  // round-trip after move_batch_v2 lands.
  const [groupsRes, classRes, eventsRes, overridesRes] = await Promise.all([
    admin
      .from('composition_groups')
      .select('id, project_id, files_in_group, best_bracket_stem, delivery_reference_stem, exif_metadata')
      .eq('round_id', roundId),
    admin
      .from('composition_classifications')
      .select('group_id, is_near_duplicate_candidate, combined_score')
      .eq('round_id', roundId),
    admin
      .from('shortlisting_events')
      .select('group_id, event_type, payload')
      .eq('round_id', roundId)
      .in('event_type', ['pass2_slot_assigned', 'pass2_phase3_recommendation'])
      // Burst 5 K2: deterministic event order. created_at ASC matches the order
      // events were emitted by Pass 2.
      .order('created_at', { ascending: true }),
    admin
      .from('shortlisting_overrides')
      .select('*')
      .eq('round_id', roundId)
      // Burst 4 J1: prefer client_sequence over created_at when present (NULLS
      // LAST puts legacy events at the end).
      .order('client_sequence', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);

  if (groupsRes.error) return errorResponse(`groups query failed: ${groupsRes.error.message}`, 500, req);
  if (classRes.error)  return errorResponse(`classifications query failed: ${classRes.error.message}`, 500, req);
  if (eventsRes.error) return errorResponse(`events query failed: ${eventsRes.error.message}`, 500, req);
  if (overridesRes.error) return errorResponse(`overrides query failed: ${overridesRes.error.message}`, 500, req);

  const groups = (groupsRes.data || []) as CompositionGroupForLock[];
  const classifications = (classRes.data || []) as ClassificationForLock[];
  const slotEvents = (eventsRes.data || []) as SlotEventForLock[];
  const overrides = (overridesRes.data || []) as OverrideForLock[];
  // Wave 7 P1-12 (W7.4): the same overrides rows, retyped for the audit JSON.
  // computeApprovedRejectedSets only reads the three fields on OverrideForLock;
  // the audit mirror needs the full row (select('*')) — both views point at
  // the same array, no second query.
  const overrideAuditRows = (overridesRes.data || []) as AuditOverrideRow[];

  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(slotEvents, overrides, classifications);

  // ── Pre-fetch project dropbox_root_path for the audit JSON write ───────
  // Wave 7 P1-12 (W7.4): the audit mirror writes to <root>/Photos/_AUDIT/.
  // Read the root once here so finalizeRound (sync) and pollUntilComplete
  // (async background) don't each round-trip the DB to find it.
  let dropboxRootPath: string | null = null;
  try {
    const { data: projRow } = await admin
      .from('projects')
      .select('dropbox_root_path')
      .eq('id', round.project_id)
      .maybeSingle();
    dropboxRootPath = (projRow?.dropbox_root_path as string | null) ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[${GENERATOR}] dropbox_root_path lookup failed for project ${round.project_id}: ${msg}`);
    dropboxRootPath = null;
  }

  // ── Per-disposition dest map ────────────────────────────────────────────
  const approvedDest = folders.rawFinalShortlist;
  const rejectedDest = folders.rawRejected;
  const sourceDest = folders.rawShortlist;

  if (!approvedDest || !rejectedDest || !sourceDest) {
    return errorResponse(
      'Project Photos/* folders are missing required kinds (Shortlist Proposed / Final Shortlist / Rejected)',
      500,
      req,
    );
  }

  // ── Build move specs ────────────────────────────────────────────────────
  const allSpecs = buildMoveSpecs(groups, approvedSet, rejectedSet, sourceDest, approvedDest, rejectedDest);
  const toMove = allSpecs.filter((s) => !s.already_at_destination);
  const idempotentSkipped = allSpecs.length - toMove.length;

  const lockedBy = isService ? null : (user?.id ?? null);

  // ── Capture confirmed shortlist snapshot (used in finalize stage) ───────
  // Burst 5 K2: sort the snapshot deterministically. Set iteration order
  // depends on insertion order, which depends on slotEvents row order from
  // Postgres. Sorting by group_id gives a fully deterministic snapshot.
  const confirmedShortlistGroupIds = Array.from(approvedSet).sort();

  // ── Build the audit-mirror context once (Wave 7 P1-12 / W7.4) ──────────
  // Indexed inputs assembled here so finalizeRound (sync or async) can write
  // the JSON without touching the DB again. Cast classifications to widen the
  // type — buildAuditMirrorContext reads `combined_score` which isn't on
  // ClassificationForLock but IS in the row data (we added it to the select).
  const auditMirror: AuditMirrorContext = buildAuditMirrorContext(
    groups,
    classifications as Array<
      { group_id: string; is_near_duplicate_candidate: boolean | null; combined_score: number | null }
    >,
    slotEvents,
    overrideAuditRows,
    approvedSet,
    rejectedSet,
    round.round_number as number,
    (round.package_type as string | null) ?? null,
    dropboxRootPath,
  );

  // ── Zero-work fast path ─────────────────────────────────────────────────
  // No files to move (all already at destination, or empty round). Skip the
  // batch submit + poll entirely; just flip the round to locked synchronously.
  if (toMove.length === 0) {
    const finalizeResult = await finalizeRound({
      admin,
      roundId,
      projectId: round.project_id,
      lockedBy,
      isService,
      movedApproved: 0,
      movedRejected: 0,
      idempotentSkipped,
      confirmedShortlistGroupIds,
      approvedCount: approvedSet.size,
      rejectedCount: rejectedSet.size,
      failedMovesCount: 0,
      auditMirror,
    });
    if (!finalizeResult.ok) {
      return errorResponse(finalizeResult.error || 'finalize failed', 500, req);
    }
    return jsonResponse(
      {
        ok: true,
        status: 'complete',
        round_id: roundId,
        total_moves: 0,
        moved: { approved: 0, rejected: 0 },
        skipped: idempotentSkipped,
      },
      200,
      req,
    );
  }

  // ── Insert progress row ─────────────────────────────────────────────────
  // On resume we DELETE the prior failed row first to honour the per-round
  // UNIQUE constraint. The constraint is DEFERRABLE INITIALLY DEFERRED so the
  // delete-then-insert in the same transaction is OK; we issue them as
  // separate statements via supabase-js since it doesn't expose explicit
  // BEGIN/COMMIT for two operations on different tables. The DELETE is safe
  // here because we already validated stage='failed' above.
  if (priorProgress && resume) {
    await admin.from('shortlisting_lock_progress').delete().eq('id', priorProgress.id);
  }

  const { data: progressRow, error: progressInsErr } = await admin
    .from('shortlisting_lock_progress')
    .insert({
      round_id: roundId,
      stage: 'submitting',
      total_moves: toMove.length,
      approved_count: approvedSet.size,
      rejected_count: rejectedSet.size,
    })
    .select('id')
    .single();
  if (progressInsErr || !progressRow) {
    return errorResponse(
      `Failed to create lock progress row: ${progressInsErr?.message || 'no row returned'}`,
      500,
      req,
    );
  }
  const progressId = progressRow.id as string;

  // ── Submit batch ────────────────────────────────────────────────────────
  let submitResult;
  try {
    const entries: DropboxMoveEntry[] = toMove.map((s) => ({
      from_path: s.from_path,
      to_path: s.to_path,
    }));
    submitResult = await moveBatch(entries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from('shortlisting_lock_progress')
      .update({
        stage: 'failed',
        error_message: `move_batch_v2 submit failed: ${msg}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', progressId);
    return errorResponse(`Dropbox batch submit failed: ${msg}`, 502, req);
  }

  // ── Inline-complete fast path ───────────────────────────────────────────
  // For very small batches Dropbox returns `.tag === 'complete'` synchronously.
  // We still go through the finalize stage, but don't need to poll.
  if (submitResult['.tag'] === 'complete') {
    const counts = countBatchEntries(toMove, submitResult.entries || []);
    await admin.from('shortlisting_lock_progress')
      .update({
        stage: 'finalizing',
        succeeded_moves: counts.succeeded,
        failed_moves: counts.failed,
        errors_sample: counts.errors_sample,
      })
      .eq('id', progressId);

    const finalizeResult = await finalizeRound({
      admin,
      roundId,
      projectId: round.project_id,
      lockedBy,
      isService,
      movedApproved: counts.movedApproved,
      movedRejected: counts.movedRejected,
      idempotentSkipped,
      confirmedShortlistGroupIds,
      approvedCount: approvedSet.size,
      rejectedCount: rejectedSet.size,
      failedMovesCount: counts.failed,
      auditMirror,
    });
    if (!finalizeResult.ok) {
      await admin.from('shortlisting_lock_progress')
        .update({
          stage: 'failed',
          error_message: finalizeResult.error,
          completed_at: new Date().toISOString(),
        })
        .eq('id', progressId);
      return errorResponse(finalizeResult.error || 'finalize failed', 500, req);
    }

    await admin.from('shortlisting_lock_progress')
      .update({ stage: 'complete', completed_at: new Date().toISOString() })
      .eq('id', progressId);

    return jsonResponse(
      {
        ok: true,
        status: 'complete',
        round_id: roundId,
        progress_id: progressId,
        total_moves: toMove.length,
        moved: { approved: counts.movedApproved, rejected: counts.movedRejected },
        skipped: idempotentSkipped,
      },
      200,
      req,
    );
  }

  // ── Async path: persist async_job_id + fire background poll ─────────────
  if (submitResult['.tag'] !== 'async_job_id' || !submitResult.async_job_id) {
    await admin.from('shortlisting_lock_progress')
      .update({
        stage: 'failed',
        error_message: `unexpected move_batch_v2 response tag: ${submitResult['.tag']}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', progressId);
    return errorResponse(`Unexpected Dropbox response tag: ${submitResult['.tag']}`, 502, req);
  }
  const asyncJobId = submitResult.async_job_id;
  await admin.from('shortlisting_lock_progress')
    .update({ stage: 'polling', async_job_id: asyncJobId })
    .eq('id', progressId);

  // Background poll runs after the response is sent.
  const bgWork = pollUntilComplete({
    progressId,
    asyncJobId,
    toMove,
    roundId,
    projectId: round.project_id,
    lockedBy,
    isService,
    idempotentSkipped,
    confirmedShortlistGroupIds,
    approvedCount: approvedSet.size,
    rejectedCount: rejectedSet.size,
    auditMirror,
  }).catch((err) => {
    console.error(`[${GENERATOR}] background poll failed:`, err?.message || err);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      status: 'in_progress',
      round_id: roundId,
      progress_id: progressId,
      async_job_id: asyncJobId,
      total_moves: toMove.length,
      moved: { approved: 0, rejected: 0 }, // counts populate during background poll
      skipped: idempotentSkipped,
    },
    202,
    req,
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Count succeeded + failed moves from a batch result. Failures are tagged
 * with their from_path so the operator can see which files didn't make it.
 *
 * `to/conflict` is treated as success — that means the file is already at
 * destination (a prior partial run already moved it). This matches the
 * idempotent semantics of the old per-file path.
 */
function countBatchEntries(
  toMove: MoveSpec[],
  entries: DropboxBatchEntryResult[],
): {
  succeeded: number;
  failed: number;
  movedApproved: number;
  movedRejected: number;
  errors_sample: Array<{ from_path: string; group_id: string; failure_tag: string; detail?: string }>;
} {
  let succeeded = 0;
  let failed = 0;
  let movedApproved = 0;
  let movedRejected = 0;
  const errors: Array<{ from_path: string; group_id: string; failure_tag: string; detail?: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const spec = toMove[i];
    if (!spec) continue; // out-of-bounds defensive

    if (e['.tag'] === 'success') {
      succeeded++;
      if (spec.bucket === 'approved') movedApproved++;
      else movedRejected++;
      continue;
    }

    // Failure path. Dropbox wraps batch failures as a TWO-level tagged union:
    //   { '.tag': 'relocation_error', relocation_error: { '.tag': 'from_lookup', from_lookup: { '.tag': 'not_found' } } }
    //   { '.tag': 'relocation_error', relocation_error: { '.tag': 'to', to: { '.tag': 'conflict' } } }
    // The outer .tag is usually 'relocation_error' (sometimes 'too_many_write_operations',
    // 'internal_error', etc). The actionable detail lives at
    // failure[outerTag][innerTag] for relocation_error variants.
    //
    // Both 'to/conflict' (file already at destination from a prior run) and
    // 'from_lookup/not_found' (source file already moved out, also from a prior
    // run) are silent-success cases: the file ended up where the operator
    // wants it, just not via THIS lock attempt. The old per-file path treated
    // both as success (see /Users/.../shortlist-lock/index.ts pre-Wave-7
    // line 369-378). We do the same here so re-running a partially-applied
    // lock cleanly converges.
    const outerTag = e.failure?.['.tag'] || 'unknown';
    // deno-lint-ignore no-explicit-any
    const inner = (e.failure as any)?.[outerTag] as { '.tag'?: string } | undefined;
    const innerTag = inner?.['.tag'];
    const innerDeeper = innerTag
      // deno-lint-ignore no-explicit-any
      ? ((inner as any)?.[innerTag] as { '.tag'?: string } | undefined)
      : undefined;
    const innerDeeperTag = innerDeeper?.['.tag'];

    // Compose a human-readable failure tag for telemetry. Examples:
    //   'relocation_error/from_lookup/not_found'
    //   'relocation_error/to/conflict'
    //   'relocation_error/from_write/insufficient_space'
    const composedTag = [outerTag, innerTag, innerDeeperTag].filter(Boolean).join('/');

    const isConflictSoft = innerTag === 'to' && innerDeeperTag === 'conflict';
    const isAlreadyMoved = innerTag === 'from_lookup' && innerDeeperTag === 'not_found';

    if (isConflictSoft || isAlreadyMoved) {
      // Already at destination (silent-success). Count as succeeded so the UI
      // shows 100% complete; not as moved (we didn't actually move them).
      succeeded++;
      continue;
    }

    failed++;
    if (errors.length < ERRORS_SAMPLE_CAP) {
      errors.push({
        from_path: spec.from_path,
        group_id: spec.group_id,
        failure_tag: composedTag || outerTag,
        detail: JSON.stringify(e.failure || {}).slice(0, 500),
      });
    }
  }

  return {
    succeeded,
    failed,
    movedApproved,
    movedRejected,
    errors_sample: errors,
  };
}

interface FinalizeArgs {
  // deno-lint-ignore no-explicit-any
  admin: any;
  roundId: string;
  projectId: string;
  lockedBy: string | null;
  isService: boolean;
  movedApproved: number;
  movedRejected: number;
  idempotentSkipped: number;
  confirmedShortlistGroupIds: string[];
  approvedCount: number;
  rejectedCount: number;
  failedMovesCount: number;
  /**
   * Wave 7 P1-12 (W7.4): if present, finalizeRound writes a per-lock audit
   * JSON to `<dropbox_root_path>/Photos/_AUDIT/round_<N>_locked_<ISO>.json`
   * after the round update succeeds. Best-effort — failure logs a warning
   * and does NOT roll the lock back (the audit JSON is an enhancement, not
   * a hard dependency for lock to succeed; per W7.4 spec § "Where to write").
   *
   * Set to null when the lock context can't supply round_number (e.g. a
   * legacy code path that isn't loading the round row in full); the audit
   * mirror is then skipped silently with a console.info.
   */
  auditMirror: AuditMirrorContext | null;
}

/**
 * Wave 7 P1-12 (W7.4): everything finalizeRound needs to assemble the audit
 * JSON after the round flips to locked. Pre-computed once in the main lock
 * handler so we don't re-query DB rows per finalize stage.
 *
 * Wave 7 P1-19 (W7.13): `mode` field added so the audit JSON distinguishes
 * engine-mode vs manual-mode locks. Manual-mode contexts have empty
 * rejected[] + overrides[] and approved entries with slot_id/score/
 * ai_proposed_score all null.
 */
interface AuditMirrorContext {
  mode: AuditJsonMode;
  roundNumber: number;
  packageType: string | null;
  approved: AuditApprovedInput[];
  rejected: AuditRejectedInput[];
  overrides: AuditOverrideRow[];
  /**
   * Pre-resolved Dropbox root path for the project. Read from
   * `projects.dropbox_root_path` once at the top of the handler so the
   * background poll path doesn't need to round-trip the DB to find it again.
   * If null, the audit mirror is skipped (project hasn't been provisioned).
   */
  dropboxRootPath: string | null;
}

/**
 * Apply the round-status update + audit event + training extractor invoke
 * after Dropbox moves complete. Used both by the inline-complete fast path
 * and the background async-poll path.
 *
 * Returns { ok: false, error } if the round update fails — in that case
 * the caller MUST surface the failure (do NOT silently mark progress as
 * complete) so the operator sees the error and can re-run Lock. The file
 * moves are already idempotent (K1 + Dropbox to/conflict), so re-running
 * is safe.
 */
async function finalizeRound(args: FinalizeArgs): Promise<{ ok: boolean; error?: string }> {
  const lockedAt = new Date().toISOString();
  const { error: roundUpdErr } = await args.admin
    .from('shortlisting_rounds')
    .update({
      status: 'locked',
      locked_at: lockedAt,
      locked_by: args.lockedBy,
      updated_at: lockedAt,
      confirmed_shortlist_group_ids: args.confirmedShortlistGroupIds,
    })
    .eq('id', args.roundId);
  // Burst 5 K3: hard-fail on round update failure so the training extractor
  // doesn't read stale confirmed_shortlist_group_ids.
  if (roundUpdErr) {
    console.error(`[${GENERATOR}] round update failed — aborting before training extractor: ${roundUpdErr.message}`);
    return {
      ok: false,
      error: `Round status update failed: ${roundUpdErr.message}. Files were moved but the round was not marked locked. Re-run Lock to retry.`,
    };
  }

  const { error: projectUpdErr } = await args.admin
    .from('projects')
    .update({ shortlist_status: 'locked' })
    .eq('id', args.projectId);
  if (projectUpdErr) {
    // Best-effort: shortlist_status is a denormalised cache.
    console.warn(`[${GENERATOR}] project update failed: ${projectUpdErr.message}`);
  }

  // Audit event
  await args.admin.from('shortlisting_events').insert({
    project_id: args.projectId,
    round_id: args.roundId,
    event_type: 'shortlist_locked',
    actor_type: args.isService ? 'system' : 'user',
    actor_id: args.isService ? null : args.lockedBy,
    payload: {
      moved_approved: args.movedApproved,
      moved_rejected: args.movedRejected,
      skipped: args.idempotentSkipped,
      errors_count: args.failedMovesCount,
      approved_count: args.approvedCount,
      rejected_count: args.rejectedCount,
    },
  });

  // Wave 7 P1-12 (W7.4): write the per-lock audit JSON to Dropbox. The DB
  // event above is the lightweight audit row; this is the canonical "what
  // did this round become" snapshot, written to
  // `<root>/Photos/_AUDIT/round_<N>_locked_<ISO>.json`. Best-effort: failure
  // logs a warning + does NOT roll back the lock (audit mirror is an
  // enhancement; the move + DB update are the hard dependencies).
  if (args.auditMirror) {
    await writeAuditMirror({
      lockedAt,
      lockedBy: args.lockedBy,
      roundId: args.roundId,
      projectId: args.projectId,
      ctx: args.auditMirror,
    });
  } else {
    console.info(`[${GENERATOR}] auditMirror context not provided — skipping audit JSON write for round ${args.roundId}`);
  }

  // Phase 8: kick the training extractor (fire-and-forget).
  if (args.confirmedShortlistGroupIds.length > 0) {
    const extractorWork = invokeFunction(
      'shortlisting-training-extractor',
      { round_id: args.roundId },
      GENERATOR,
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] training extractor invoke failed: ${msg}`);
    });
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(extractorWork);
  }

  return { ok: true };
}

interface PollArgs {
  progressId: string;
  asyncJobId: string;
  toMove: MoveSpec[];
  roundId: string;
  projectId: string;
  lockedBy: string | null;
  isService: boolean;
  idempotentSkipped: number;
  confirmedShortlistGroupIds: string[];
  approvedCount: number;
  rejectedCount: number;
  /** Wave 7 P1-12 (W7.4): forwarded to finalizeRound for the audit JSON write. */
  auditMirror: AuditMirrorContext | null;
}

/**
 * Background poll loop. Polls /files/move_batch/check_v2 until complete or
 * the cap (~3 min) is hit. Updates shortlisting_lock_progress on every poll
 * so the frontend's polling status endpoint sees live progress.
 */
async function pollUntilComplete(args: PollArgs): Promise<void> {
  const admin = getAdminClient();
  let attempts = 0;

  while (attempts < POLL_MAX_ATTEMPTS) {
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let check;
    try {
      check = await checkMoveBatch(args.asyncJobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Transient: log + retry the loop. We've seen Dropbox 5xx briefly during
      // sustained batch ops; the retry budget on dropboxApi already handles
      // 429/5xx, so a thrown error here is genuinely terminal.
      console.warn(`[${GENERATOR}] check_v2 attempt ${attempts} failed: ${msg}`);
      await admin.from('shortlisting_lock_progress')
        .update({
          last_polled_at: new Date().toISOString(),
          poll_attempt_count: attempts,
          error_message: `poll attempt ${attempts}: ${msg}`,
        })
        .eq('id', args.progressId);
      // Continue — the next attempt may succeed. The cap will eventually fail.
      continue;
    }

    await admin.from('shortlisting_lock_progress')
      .update({
        last_polled_at: new Date().toISOString(),
        poll_attempt_count: attempts,
      })
      .eq('id', args.progressId);

    if (check['.tag'] === 'in_progress') {
      // Keep waiting.
      continue;
    }

    if (check['.tag'] === 'complete') {
      const counts = countBatchEntries(args.toMove, check.entries || []);
      await admin.from('shortlisting_lock_progress')
        .update({
          stage: 'finalizing',
          succeeded_moves: counts.succeeded,
          failed_moves: counts.failed,
          errors_sample: counts.errors_sample,
        })
        .eq('id', args.progressId);

      const finalizeResult = await finalizeRound({
        admin,
        roundId: args.roundId,
        projectId: args.projectId,
        lockedBy: args.lockedBy,
        isService: args.isService,
        movedApproved: counts.movedApproved,
        movedRejected: counts.movedRejected,
        idempotentSkipped: args.idempotentSkipped,
        confirmedShortlistGroupIds: args.confirmedShortlistGroupIds,
        approvedCount: args.approvedCount,
        rejectedCount: args.rejectedCount,
        failedMovesCount: counts.failed,
        auditMirror: args.auditMirror,
      });
      if (!finalizeResult.ok) {
        await admin.from('shortlisting_lock_progress')
          .update({
            stage: 'failed',
            error_message: finalizeResult.error,
            completed_at: new Date().toISOString(),
          })
          .eq('id', args.progressId);
        return;
      }
      await admin.from('shortlisting_lock_progress')
        .update({ stage: 'complete', completed_at: new Date().toISOString() })
        .eq('id', args.progressId);
      return;
    }

    if (check['.tag'] === 'failed') {
      const failureTxt = JSON.stringify(check.failure || {}).slice(0, 500);
      await admin.from('shortlisting_lock_progress')
        .update({
          stage: 'failed',
          error_message: `Dropbox batch reported failed: ${failureTxt}`,
          completed_at: new Date().toISOString(),
        })
        .eq('id', args.progressId);
      return;
    }

    // 'other' or unknown tag — treat as transient, log + continue.
    console.warn(`[${GENERATOR}] unexpected check_v2 tag: ${check['.tag']}`);
  }

  // Cap reached without complete — mark failed so the operator can resume.
  await admin.from('shortlisting_lock_progress')
    .update({
      stage: 'failed',
      error_message: `Poll cap reached (${POLL_MAX_ATTEMPTS} attempts, ~${(POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS) / 1000}s) without batch completing. Resume to retry.`,
      completed_at: new Date().toISOString(),
    })
    .eq('id', args.progressId);
}

// ─── Audit JSON mirror (Wave 7 P1-12 / W7.4) ─────────────────────────────────

interface WriteAuditMirrorArgs {
  /** Canonical lock timestamp — same value persisted to shortlisting_rounds.locked_at. */
  lockedAt: string;
  lockedBy: string | null;
  roundId: string;
  projectId: string;
  ctx: AuditMirrorContext;
}

/**
 * Wave 7 P1-12 (W7.4): write the per-lock audit JSON to Dropbox at
 * `<dropbox_root_path>/Photos/_AUDIT/round_<N>_locked_<ISO>.json`.
 *
 * Path safety: Dropbox `/files/upload` does NOT auto-create parent directories.
 * If `Photos/_AUDIT/` doesn't exist (project provisioned before W7.4 added the
 * `photos_audit` folder kind), the upload returns path/not_found. We catch
 * that, create the folder, and retry once — same recovery pattern as the
 * `_AUDIT/events/` mirror in `_shared/projectFolders.ts`. This is the
 * "create folder on first lock" backfill behaviour the W7.4 spec calls for.
 *
 * Uses `mode: 'add'` (fail if file exists) — combined with a millisecond-
 * precision ISO stamp in the filename, every lock attempt produces a unique
 * filename, so 'add' is correct. If two locks somehow land at the same
 * millisecond (vanishingly unlikely; same-round re-lock is gated by the
 * resume guard), the second upload errors and we log a warning. We do NOT
 * fall back to autorename — that would silently break the convention that
 * filename ↔ lock event is 1:1.
 *
 * Best-effort: any exception is logged and swallowed. The audit JSON is an
 * enhancement; the round is already marked locked at this point.
 */
async function writeAuditMirror(args: WriteAuditMirrorArgs): Promise<void> {
  const { ctx } = args;
  if (!ctx.dropboxRootPath) {
    console.warn(
      `[${GENERATOR}] audit mirror skipped: project ${args.projectId} has no dropbox_root_path (not provisioned)`,
    );
    return;
  }

  const audit = buildAuditJson({
    round: {
      round_id: args.roundId,
      round_number: ctx.roundNumber,
      project_id: args.projectId,
      package_type: ctx.packageType,
      locked_at: args.lockedAt,
      locked_by_user_id: args.lockedBy,
      // engine_version + tier_used not on shortlisting_rounds today (mig 282).
      // Forward-compat: the audit JSON shape includes both, set to null until a
      // future migration adds them to the rounds table.
      engine_version: null,
      tier_used: null,
    },
    approved: ctx.approved,
    rejected: ctx.rejected,
    overrides: ctx.overrides,
    mode: ctx.mode,
  });

  const path = buildAuditJsonPath(ctx.dropboxRootPath, ctx.roundNumber, args.lockedAt);
  const body = serializeAuditJson(audit);

  try {
    await uploadFile(path, body, 'add');
    console.info(`[${GENERATOR}] audit mirror written: ${path} (${body.length} bytes)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // path/not_found means Photos/_AUDIT/ doesn't exist. Recover by creating
    // it and retrying once — matches projectFolders.mirrorEventToDropbox's
    // pattern. Using lazy import avoids loading the createFolder dependency
    // for the (common) hot path where the folder already exists.
    if (msg.includes('path/not_found') || msg.includes('not_found')) {
      try {
        const { createFolder } = await import('../_shared/dropbox.ts');
        const photosAuditDir = `${ctx.dropboxRootPath.replace(/\/+$/, '')}/Photos/_AUDIT`;
        await createFolder(photosAuditDir);
        await uploadFile(path, body, 'add');
        console.info(`[${GENERATOR}] audit mirror written after creating Photos/_AUDIT/: ${path}`);
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(`[${GENERATOR}] audit mirror retry failed for round ${args.roundId}: ${retryMsg}`);
        return;
      }
    }
    console.warn(`[${GENERATOR}] audit mirror failed for round ${args.roundId}: ${msg}`);
  }
}

/**
 * Wave 7 P1-12 (W7.4): assemble the AuditMirrorContext from the data already
 * loaded in the main lock handler. Called once before the move_batch_v2
 * submit so it's ready for either the inline-complete or async-poll path.
 *
 * Approved entries: one per group_id in approvedSet, joining
 *   - composition_groups (file stems)
 *   - composition_classifications (combined_score)
 *   - pass2_slot_assigned events (slot_id)
 *   - shortlisting_overrides (ai_proposed_score)
 *
 * Rejected entries: one per group_id in rejectedSet, with reason resolved
 * from classifications + overrides:
 *   - is_near_duplicate_candidate=true       → 'near_duplicate'
 *   - human_action='removed' for this group  → 'human_action=removed'
 *   - both                                    → 'near_duplicate' (more specific)
 */
function buildAuditMirrorContext(
  groups: CompositionGroupForLock[],
  // deno-lint-ignore no-explicit-any
  classifications: Array<{ group_id: string; is_near_duplicate_candidate: boolean | null; combined_score: number | null }>,
  slotEvents: SlotEventForLock[],
  overrides: AuditOverrideRow[],
  approvedSet: Set<string>,
  rejectedSet: Set<string>,
  roundNumber: number,
  packageType: string | null,
  dropboxRootPath: string | null,
): AuditMirrorContext {
  // Index inputs once for O(1) lookups inside the per-group loop. Keys:
  //   - groupById: composition_groups by id
  //   - classByGroup: classification by group_id
  //   - slotByGroup: latest pass2 event payload per group
  //   - aiProposedScoreByGroup: ai_proposed_score from any override mentioning
  //     this group as the AI proposal
  const groupById = new Map<string, CompositionGroupForLock>();
  for (const g of groups) groupById.set(g.id, g);

  const classByGroup = new Map<
    string,
    { is_near_duplicate_candidate: boolean | null; combined_score: number | null }
  >();
  for (const c of classifications) classByGroup.set(c.group_id, c);

  // For each group, prefer the rank=1 pass2_slot_assigned event (the canonical
  // winner), falling back to a phase-3 recommendation if no rank=1 event
  // exists. Both event types carry slot_id in payload (phase-3 uses null).
  const slotByGroup = new Map<string, { slot_id: string | null }>();
  for (const ev of slotEvents) {
    if (!ev.group_id) continue;
    if (slotByGroup.has(ev.group_id)) continue; // first wins (events are ordered)
    if (ev.event_type === 'pass2_slot_assigned' && ev.payload?.rank !== 1) continue;
    const slot_id = (ev.payload?.slot_id as string | undefined) || null;
    slotByGroup.set(ev.group_id, { slot_id });
  }
  // Second pass for any groups that only have phase-3 events (no rank=1 winner).
  for (const ev of slotEvents) {
    if (!ev.group_id) continue;
    if (slotByGroup.has(ev.group_id)) continue;
    const slot_id = (ev.payload?.slot_id as string | undefined) || null;
    slotByGroup.set(ev.group_id, { slot_id });
  }

  const aiProposedScoreByGroup = new Map<string, number | null>();
  for (const ov of overrides) {
    const gid = ov.ai_proposed_group_id as string | null;
    if (!gid) continue;
    if (aiProposedScoreByGroup.has(gid)) continue;
    const score = ov.ai_proposed_score;
    aiProposedScoreByGroup.set(
      gid,
      typeof score === 'number' ? score : score == null ? null : Number(score),
    );
  }

  // Track which groups were explicitly removed via human override (mirrors
  // shortlistLockMoves.computeApprovedRejectedSets internal logic so the
  // rejection reasons match the actual disposition).
  const explicitlyRemovedGroups = new Set<string>();
  for (const ov of overrides) {
    if (ov.human_action === 'removed' || ov.human_action === 'swapped') {
      const gid = ov.ai_proposed_group_id as string | null;
      if (gid) explicitlyRemovedGroups.add(gid);
    }
  }

  // ── Approved entries ───────────────────────────────────────────────────
  const approved: AuditApprovedInput[] = [];
  for (const groupId of approvedSet) {
    const g = groupById.get(groupId);
    const cls = classByGroup.get(groupId);
    const slot = slotByGroup.get(groupId);
    const file_stems = (g?.files_in_group || []).filter((s): s is string => typeof s === 'string');
    const score = cls?.combined_score == null ? null : Number(cls.combined_score);
    const ai_proposed_score = aiProposedScoreByGroup.has(groupId)
      ? aiProposedScoreByGroup.get(groupId) ?? null
      : null;
    approved.push({
      group_id: groupId,
      slot_id: slot?.slot_id ?? null,
      score,
      ai_proposed_score,
      file_stems,
    });
  }

  // ── Rejected entries ───────────────────────────────────────────────────
  const rejected: AuditRejectedInput[] = [];
  for (const groupId of rejectedSet) {
    const g = groupById.get(groupId);
    const cls = classByGroup.get(groupId);
    const file_stems = (g?.files_in_group || []).filter((s): s is string => typeof s === 'string');
    const isNearDup = cls?.is_near_duplicate_candidate === true;
    const wasRemoved = explicitlyRemovedGroups.has(groupId);
    // 'near_duplicate' is more specific than 'human_action=removed' — a group
    // can be both (Pass 1 flagged it AND the human removed it on review), so
    // we surface the structural signal first.
    const reason = isNearDup
      ? 'near_duplicate'
      : wasRemoved
        ? 'human_action=removed'
        : 'unspecified';
    rejected.push({ group_id: groupId, file_stems, reason });
  }

  return {
    mode: 'engine',
    roundNumber,
    packageType,
    approved,
    rejected,
    overrides,
    dropboxRootPath,
  };
}

// ─── Wave 7 P1-19 (W7.13): Manual-mode lock handler ──────────────────────────

interface LockManualModeArgs {
  req: Request;
  // deno-lint-ignore no-explicit-any
  admin: any;
  roundId: string;
  // deno-lint-ignore no-explicit-any
  round: any;
  approvedStems: string[];
  approvedDest: string;
  sourceDest: string;
  isService: boolean;
  lockedBy: string | null;
  // deno-lint-ignore no-explicit-any
  priorProgress: any;
  resume: boolean;
}

/**
 * Manual-mode lock handler. Mirrors the engine path's submit/poll/finalize
 * structure but skips the AI-resolution layer:
 *
 *   1. Defence: round must have status='manual' (set by shortlisting-ingest
 *      when the manual-mode triggers fired)
 *   2. List the source folder via /files/list_folder
 *   3. Resolve approved_stems[] against the file list (resolveManualLockMoves
 *      handles case-insensitive matching, idempotency, dedup)
 *   4. Build a manual-flavoured AuditMirrorContext (mode='manual', empty
 *      rejected[] + overrides[], slot_id/score/ai_proposed_score=null on
 *      approved entries)
 *   5. Submit move_batch_v2; on inline-complete or async-poll path, finalize
 *      reuses the existing finalizeRound (writes audit JSON, transitions
 *      round to status='locked', kicks training extractor — though manual
 *      rounds have no confirmed_shortlist_group_ids so the extractor noops)
 */
async function lockManualMode(args: LockManualModeArgs): Promise<Response> {
  const {
    req,
    admin,
    roundId,
    round,
    approvedStems,
    approvedDest,
    sourceDest,
    isService,
    lockedBy,
    priorProgress,
    resume,
  } = args;

  // Defence: the round must be a manual-mode round. shortlisting-ingest sets
  // status='manual' when either trigger (#1 project_type_unsupported, #2
  // no_photo_products) fires. If a frontend somehow sends mode='manual' for
  // an engine-mode round, refuse — the engine path is the right answer for
  // those rounds.
  if (round.status !== 'manual') {
    return errorResponse(
      `mode=manual but round ${roundId} is in status='${round.status}' (expected 'manual'). ` +
      `Manual mode is only valid for rounds created via shortlisting-ingest with manual-mode triggers.`,
      400,
      req,
    );
  }

  // ── List the source folder ────────────────────────────────────────────
  let sourceFiles: ManualLockSourceFile[];
  try {
    const { entries } = await listFolder(sourceDest, { recursive: false, maxEntries: 5000 });
    sourceFiles = entries
      .filter((e) => e['.tag'] === 'file' && typeof e.name === 'string')
      .map((e) => ({
        name: e.name as string,
        path: (e.path_display as string | undefined) || `${sourceDest}/${e.name}`,
      }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(
      `Failed to list source folder for manual lock (${sourceDest}): ${msg}`,
      502,
      req,
    );
  }

  // ── Resolve approved stems ────────────────────────────────────────────
  const { entries: moveEntries, unmatchedStems } = resolveManualLockMoves(
    approvedStems,
    sourceFiles,
    approvedDest,
  );

  if (unmatchedStems.length > 0) {
    // Hard fail — operator approved a file that doesn't exist in the source
    // folder. Stale UI state or a file the operator deleted between drag and
    // lock. Surface it; don't silently move a partial set.
    return errorResponse(
      `Manual lock: ${unmatchedStems.length} approved stem(s) not found in source folder: ${unmatchedStems.slice(0, 5).join(', ')}${unmatchedStems.length > 5 ? '…' : ''}`,
      400,
      req,
    );
  }

  // ── Pre-fetch dropbox_root_path for audit JSON write ──────────────────
  let dropboxRootPath: string | null = null;
  try {
    const { data: projRow } = await admin
      .from('projects')
      .select('dropbox_root_path')
      .eq('id', round.project_id)
      .maybeSingle();
    dropboxRootPath = (projRow?.dropbox_root_path as string | null) ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[${GENERATOR}] dropbox_root_path lookup failed for project ${round.project_id} (manual): ${msg}`);
    dropboxRootPath = null;
  }

  // ── Build manual-flavoured AuditMirrorContext ─────────────────────────
  // Per W7.13 spec § "audit JSON path already correct": manual-mode audit
  // JSONs use a synthetic `group_id` per approved entry (the file stem,
  // since manual mode has no composition_groups). slot_id / score /
  // ai_proposed_score are all null. Rejected + overrides are empty arrays —
  // the spec says "no AI proposed anything to override" and "undecided files
  // stay in source" (no rejection bucket).
  const approvedAudit: AuditApprovedInput[] = moveEntries.map((e) => ({
    group_id: e.stem,
    slot_id: null,
    score: null,
    ai_proposed_score: null,
    file_stems: [e.stem],
  }));
  const auditMirror: AuditMirrorContext = {
    mode: 'manual',
    roundNumber: round.round_number as number,
    packageType: (round.package_type as string | null) ?? null,
    approved: approvedAudit,
    rejected: [],
    overrides: [],
    dropboxRootPath,
  };

  // ── Snapshot for shortlisting_rounds.confirmed_shortlist_group_ids ────
  // Manual mode has no real group_ids; we persist the matched stems so the
  // dashboard ("X confirmed shortlist") still shows the approved file count.
  const confirmedShortlistGroupIds = moveEntries.map((e) => e.stem).sort();
  const approvedCount = moveEntries.length;

  // ── Idempotent + zero-work split ──────────────────────────────────────
  const toMove = moveEntries.filter((e) => !e.already_at_destination);
  const idempotentSkipped = moveEntries.length - toMove.length;

  // Zero-work fast path (every approved file is already at destination, or
  // the operator approved zero — the latter we already 400'd above).
  if (toMove.length === 0) {
    const finalizeResult = await finalizeRound({
      admin,
      roundId,
      projectId: round.project_id,
      lockedBy,
      isService,
      movedApproved: 0,
      movedRejected: 0,
      idempotentSkipped,
      confirmedShortlistGroupIds,
      approvedCount,
      rejectedCount: 0,
      failedMovesCount: 0,
      auditMirror,
    });
    if (!finalizeResult.ok) {
      return errorResponse(finalizeResult.error || 'finalize failed', 500, req);
    }
    return jsonResponse(
      {
        ok: true,
        status: 'complete',
        round_id: roundId,
        mode: 'manual',
        total_moves: 0,
        moved: { approved: 0, rejected: 0 },
        skipped: idempotentSkipped,
      },
      200,
      req,
    );
  }

  // ── Insert progress row ───────────────────────────────────────────────
  if (priorProgress && resume) {
    await admin.from('shortlisting_lock_progress').delete().eq('id', priorProgress.id);
  }
  const { data: progressRow, error: progressInsErr } = await admin
    .from('shortlisting_lock_progress')
    .insert({
      round_id: roundId,
      stage: 'submitting',
      total_moves: toMove.length,
      approved_count: approvedCount,
      rejected_count: 0,
    })
    .select('id')
    .single();
  if (progressInsErr || !progressRow) {
    return errorResponse(
      `Failed to create manual lock progress row: ${progressInsErr?.message || 'no row returned'}`,
      500,
      req,
    );
  }
  const progressId = progressRow.id as string;

  // ── Submit batch ──────────────────────────────────────────────────────
  // Reuse engine-path MoveSpec shape so countBatchEntries (engine-side) keeps
  // working: bucket='approved' (manual mode has no rejected bucket), group_id
  // = stem (no composition_group exists).
  const toMoveAsSpecs: MoveSpec[] = toMove.map((e) => ({
    group_id: e.stem,
    stem: e.stem,
    from_path: e.from_path,
    to_path: e.to_path,
    bucket: 'approved' as const,
    already_at_destination: false,
  }));

  let submitResult;
  try {
    const dropboxEntries: DropboxMoveEntry[] = toMove.map((e) => ({
      from_path: e.from_path,
      to_path: e.to_path,
    }));
    submitResult = await moveBatch(dropboxEntries);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from('shortlisting_lock_progress')
      .update({
        stage: 'failed',
        error_message: `manual-mode move_batch_v2 submit failed: ${msg}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', progressId);
    return errorResponse(`Dropbox batch submit failed: ${msg}`, 502, req);
  }

  // ── Inline-complete fast path ─────────────────────────────────────────
  if (submitResult['.tag'] === 'complete') {
    const counts = countBatchEntries(toMoveAsSpecs, submitResult.entries || []);
    await admin.from('shortlisting_lock_progress')
      .update({
        stage: 'finalizing',
        succeeded_moves: counts.succeeded,
        failed_moves: counts.failed,
        errors_sample: counts.errors_sample,
      })
      .eq('id', progressId);

    const finalizeResult = await finalizeRound({
      admin,
      roundId,
      projectId: round.project_id,
      lockedBy,
      isService,
      movedApproved: counts.movedApproved,
      movedRejected: 0, // manual mode has no rejected bucket
      idempotentSkipped,
      confirmedShortlistGroupIds,
      approvedCount,
      rejectedCount: 0,
      failedMovesCount: counts.failed,
      auditMirror,
    });
    if (!finalizeResult.ok) {
      await admin.from('shortlisting_lock_progress')
        .update({
          stage: 'failed',
          error_message: finalizeResult.error,
          completed_at: new Date().toISOString(),
        })
        .eq('id', progressId);
      return errorResponse(finalizeResult.error || 'finalize failed', 500, req);
    }
    await admin.from('shortlisting_lock_progress')
      .update({ stage: 'complete', completed_at: new Date().toISOString() })
      .eq('id', progressId);

    return jsonResponse(
      {
        ok: true,
        status: 'complete',
        round_id: roundId,
        mode: 'manual',
        progress_id: progressId,
        total_moves: toMove.length,
        moved: { approved: counts.movedApproved, rejected: 0 },
        skipped: idempotentSkipped,
      },
      200,
      req,
    );
  }

  // ── Async path: persist + fire background poll ────────────────────────
  if (submitResult['.tag'] !== 'async_job_id' || !submitResult.async_job_id) {
    await admin.from('shortlisting_lock_progress')
      .update({
        stage: 'failed',
        error_message: `unexpected manual-mode move_batch_v2 response tag: ${submitResult['.tag']}`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', progressId);
    return errorResponse(`Unexpected Dropbox response tag: ${submitResult['.tag']}`, 502, req);
  }
  const asyncJobId = submitResult.async_job_id;
  await admin.from('shortlisting_lock_progress')
    .update({ stage: 'polling', async_job_id: asyncJobId })
    .eq('id', progressId);

  const bgWork = pollUntilComplete({
    progressId,
    asyncJobId,
    toMove: toMoveAsSpecs,
    roundId,
    projectId: round.project_id,
    lockedBy,
    isService,
    idempotentSkipped,
    confirmedShortlistGroupIds,
    approvedCount,
    rejectedCount: 0,
    auditMirror,
  }).catch((err) => {
    console.error(`[${GENERATOR}] manual-mode background poll failed:`, err?.message || err);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      status: 'in_progress',
      round_id: roundId,
      mode: 'manual',
      progress_id: progressId,
      async_job_id: asyncJobId,
      total_moves: toMove.length,
      moved: { approved: 0, rejected: 0 },
      skipped: idempotentSkipped,
    },
    202,
    req,
  );
}

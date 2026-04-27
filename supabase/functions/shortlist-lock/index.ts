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

  const admin = getAdminClient();

  // ── Load round + project ────────────────────────────────────────────────
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, locked_at, locked_by')
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

  // ── Load groups + classifications + events + overrides ──────────────────
  const [groupsRes, classRes, eventsRes, overridesRes] = await Promise.all([
    admin
      .from('composition_groups')
      .select('id, project_id, files_in_group, best_bracket_stem, delivery_reference_stem, exif_metadata')
      .eq('round_id', roundId),
    admin
      .from('composition_classifications')
      .select('group_id, is_near_duplicate_candidate')
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
      .select('ai_proposed_group_id, human_selected_group_id, human_action, created_at, client_sequence')
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

  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(slotEvents, overrides, classifications);

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

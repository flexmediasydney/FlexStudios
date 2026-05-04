/**
 * shortlist-unlock
 * ────────────────
 * Reverse a previously committed lock so the operator can resume editing
 * the shortlist on the SAME round (no fresh ingest, no re-extraction).
 *
 * Per Joseph 2026-05-04: starting a new round is NOT a substitute for
 * unlock because shortlisting-ingest only reads
 * `Photos/Raws/Shortlist Proposed/`.  Files that were moved to
 * `Final Shortlist/` or `Rejected/` by a prior lock are physically
 * invisible to the next round.  So unlock is the SOLE supported way to
 * change a decision after lock.
 *
 * What it does (logically):
 *   1. Read approved/rejected sets from the SAME logic shortlist-lock
 *      uses (slot events + chronologically-folded overrides + classifications).
 *   2. Build reverse move specs: every file currently in
 *      `Photos/Raws/Final Shortlist/<filename>` or `Rejected/<filename>`
 *      goes back to `Shortlist Proposed/<filename>`.
 *   3. Submit ONE Dropbox `/files/move_batch_v2`.
 *   4. Auto-retry transient `too_many_write_operations` failures
 *      (operator feedback 2026-05-04: "shouldn't we be aiming for no
 *      failures and auto-retries on the failed ones?").
 *   5. Mark every shortlisting_committed_decisions row for this round
 *      `superseded=true` so training pipelines (mig 467) ignore the
 *      stale signal.  A subsequent relock UPSERTs new rows on top of
 *      the same (round_id, group_id) primary key with superseded=false.
 *   6. Update the round: status='locked' → 'proposed', clear locked_at
 *      and locked_by.
 *   7. Write a `shortlist_unlocked` event with the operator's reason.
 *
 * Sync vs async path (2026-05-04 update — operator-feedback fix for
 * 99s timeout on a 154-file batch):
 *   - If Dropbox returns inline-complete (small batches, <50 files):
 *     run all 7 steps synchronously and return 200.
 *   - If Dropbox returns async_job_id (large batches): submit, kick off
 *     EdgeRuntime.waitUntil() background polling, and return 202
 *     immediately with `{ status: 'in_progress', async_job_id }`.  The
 *     background path runs steps 4–7 once the Dropbox batch finishes.
 *     Frontend polls `round.status` and re-renders when it flips back
 *     to 'proposed'.
 *
 * What it does NOT do:
 *   - Does NOT re-run Pass 0 / extraction.  composition_groups +
 *     classifications + slot events stay valid for the same RAW set.
 *   - Does NOT delete shortlisting_overrides.  WIP review state is
 *     preserved so the operator walks back into the swimlane in the
 *     state they left it.
 *   - Does NOT update the Dropbox audit JSON written at lock time.
 *
 * POST { round_id, reason? }
 * Auth: master_admin only OR service_role.  Stricter than shortlist-lock
 * (which allows admin/manager too) — unlock has more downside if misused.
 *
 * Response (sync path):
 *   {
 *     ok: true,
 *     round_id,
 *     status: 'proposed',
 *     moved: { total, succeeded, failed },
 *     decisions_superseded: N
 *   }
 * Response (async path, HTTP 202):
 *   {
 *     ok: true,
 *     round_id,
 *     status: 'in_progress',
 *     async_job_id: '...',
 *     total_moves: N,
 *     message: 'Unlock submitted; round.status will flip to proposed once Dropbox completes (~2 min for ~150 files).'
 *   }
 *
 * Failure modes:
 *   - 403 if caller is not master_admin
 *   - 409 if round.status !== 'locked'
 *   - 502 if Dropbox batch submit fails
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { getShortlistingFolders } from '../_shared/shortlistingFolders.ts';
import {
  moveBatch,
  checkMoveBatch,
  moveBatchWithRetry,
  isTransientBatchFailure,
  type DropboxBatchEntryResult,
  type DropboxMoveEntry,
} from '../_shared/dropbox.ts';
import {
  computeApprovedRejectedSets,
  resolveFullFilename,
  type CompositionGroupForLock,
  type SlotEventForLock,
  type OverrideForLock,
  type ClassificationForLock,
} from '../_shared/shortlistLockMoves.ts';

const GENERATOR = 'shortlist-unlock';

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 60; // ~3 min — same cap as lock's background poll

interface UnlockBody {
  round_id?: string;
  reason?: string;
  _health_check?: boolean;
}

interface ReverseMoveSpec {
  group_id: string;
  stem: string;
  bucket: 'approved' | 'rejected';
  from_path: string;
  to_path: string;
  already_at_destination: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // ── Auth: master_admin only ─────────────────────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse(
        'Forbidden — only master_admin can unlock a shortlist',
        403,
        req,
      );
    }
  }

  let body: UnlockBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v2.0-async', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id?.trim();
  if (!roundId) return errorResponse('round_id required', 400, req);
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
  const unlockedBy = isService ? null : (user?.id ?? null);

  const admin = getAdminClient();

  // ── Load round + validate state ─────────────────────────────────────────
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, locked_at, locked_by, round_number, package_type')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) return errorResponse(`round lookup failed: ${roundErr.message}`, 500, req);
  if (!round) return errorResponse(`round ${roundId} not found`, 404, req);

  if (round.status !== 'locked') {
    return errorResponse(
      `Round status is '${round.status}' — only 'locked' rounds can be unlocked.`,
      409,
      req,
    );
  }

  // ── Load groups + classifications + events + overrides ─────────────────
  const [groupsRes, classRes, eventsRes, overridesRes] = await Promise.all([
    admin
      .from('composition_groups')
      .select('id, files_in_group, exif_metadata')
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
      .order('created_at', { ascending: true }),
    admin
      .from('shortlisting_overrides')
      .select('ai_proposed_group_id, human_selected_group_id, human_action, created_at')
      .eq('round_id', roundId)
      .order('client_sequence', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);

  if (groupsRes.error) return errorResponse(`groups query failed: ${groupsRes.error.message}`, 500, req);
  if (classRes.error) return errorResponse(`classifications query failed: ${classRes.error.message}`, 500, req);
  if (eventsRes.error) return errorResponse(`events query failed: ${eventsRes.error.message}`, 500, req);
  if (overridesRes.error) return errorResponse(`overrides query failed: ${overridesRes.error.message}`, 500, req);

  const groups = (groupsRes.data || []) as CompositionGroupForLock[];
  const classifications = (classRes.data || []) as ClassificationForLock[];
  const slotEvents = (eventsRes.data || []) as SlotEventForLock[];
  const overrides = (overridesRes.data || []) as OverrideForLock[];

  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(
    slotEvents,
    overrides,
    classifications,
  );

  // ── Resolve folder paths ────────────────────────────────────────────────
  let folders;
  try {
    folders = await getShortlistingFolders(round.project_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(`Project Photos/* folders not provisioned: ${msg}`, 500, req);
  }
  const proposedDest = folders.rawShortlist;
  const approvedDest = folders.rawFinalShortlist;
  const rejectedDest = folders.rawRejected;
  if (!proposedDest || !approvedDest || !rejectedDest) {
    return errorResponse(
      'Project Photos/* folders are missing required kinds',
      500,
      req,
    );
  }

  // ── Build reverse move specs ────────────────────────────────────────────
  const reverseSpecs = buildReverseMoveSpecs(
    groups,
    approvedSet,
    rejectedSet,
    proposedDest,
    approvedDest,
    rejectedDest,
  );
  const toMove = reverseSpecs.filter((s) => !s.already_at_destination);
  const idempotentSkipped = reverseSpecs.length - toMove.length;

  // ── Zero-work fast path ─────────────────────────────────────────────────
  if (toMove.length === 0) {
    const finalizeResult = await finalizeUnlock({
      admin,
      roundId,
      projectId: round.project_id,
      reason,
      unlockedBy,
      moved: { total: 0, succeeded: 0, failed: 0 },
      idempotentSkipped,
      errorsSample: [],
      priorLockedAt: round.locked_at,
      priorLockedBy: round.locked_by,
    });
    if (!finalizeResult.ok) {
      return errorResponse(finalizeResult.error || 'finalize failed', 500, req);
    }
    return jsonResponse(
      {
        ok: true,
        round_id: roundId,
        status: 'proposed',
        moved: { total: 0, succeeded: 0, failed: 0 },
        idempotent_skipped: idempotentSkipped,
        decisions_superseded: finalizeResult.decisionsSuperseded,
      },
      200,
      req,
    );
  }

  // ── Submit Dropbox batch ────────────────────────────────────────────────
  const entries: DropboxMoveEntry[] = toMove.map((s) => ({
    from_path: s.from_path,
    to_path: s.to_path,
  }));

  let submitResult;
  try {
    submitResult = await moveBatch(entries, { app: 'engine' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResponse(`Dropbox move_batch_v2 submit failed: ${msg}`, 502, req);
  }

  // Inline-complete fast path — small batches resolve sync in one round-trip.
  if (submitResult['.tag'] === 'complete') {
    const inlineEntries = submitResult.entries || [];
    await retryUnlockTransients(toMove, inlineEntries);
    const tally = tallyEntries(inlineEntries, toMove);
    const finalizeResult = await finalizeUnlock({
      admin,
      roundId,
      projectId: round.project_id,
      reason,
      unlockedBy,
      moved: tally.moved,
      idempotentSkipped,
      errorsSample: tally.errorsSample,
      priorLockedAt: round.locked_at,
      priorLockedBy: round.locked_by,
    });
    if (!finalizeResult.ok) {
      return errorResponse(finalizeResult.error || 'finalize failed', 500, req);
    }
    return jsonResponse(
      {
        ok: true,
        round_id: roundId,
        status: 'proposed',
        moved: tally.moved,
        idempotent_skipped: idempotentSkipped,
        decisions_superseded: finalizeResult.decisionsSuperseded,
      },
      200,
      req,
    );
  }

  // Async path — Dropbox returned an async_job_id.  Kick off background
  // poll + finalize via EdgeRuntime.waitUntil() and return 202 immediately.
  if (submitResult['.tag'] !== 'async_job_id' || !submitResult.async_job_id) {
    return errorResponse(
      `Unexpected Dropbox response tag: ${submitResult['.tag']}`,
      502,
      req,
    );
  }
  const asyncJobId = submitResult.async_job_id;

  const bgWork = pollAndFinalizeUnlock({
    asyncJobId,
    toMove,
    roundId,
    projectId: round.project_id,
    reason,
    unlockedBy,
    idempotentSkipped,
    priorLockedAt: round.locked_at,
    priorLockedBy: round.locked_by,
  }).catch((err) => {
    console.error(`[${GENERATOR}] background poll failed:`, err?.message || err);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      round_id: roundId,
      status: 'in_progress',
      async_job_id: asyncJobId,
      total_moves: toMove.length,
      idempotent_skipped: idempotentSkipped,
      message:
        'Unlock submitted to Dropbox.  Round.status will flip to \'proposed\' once the batch completes (~1–3 min for >100 files).  Refresh the swimlane to see live state.',
    },
    202,
    req,
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildReverseMoveSpecs(
  groups: CompositionGroupForLock[],
  approvedSet: Set<string>,
  rejectedSet: Set<string>,
  proposedDest: string,
  approvedDest: string,
  rejectedDest: string,
): ReverseMoveSpec[] {
  const proposedPrefix = proposedDest.replace(/\/+$/, '') + '/';
  const approvedPrefix = approvedDest.replace(/\/+$/, '') + '/';
  const rejectedPrefix = rejectedDest.replace(/\/+$/, '') + '/';

  const sortedGroups = [...groups].sort((a, b) => a.id.localeCompare(b.id));
  const out: ReverseMoveSpec[] = [];

  for (const g of sortedGroups) {
    const files = g.files_in_group || [];
    if (files.length === 0) continue;
    let bucket: 'approved' | 'rejected' | null = null;
    let sourcePrefix: string | null = null;
    if (approvedSet.has(g.id)) {
      bucket = 'approved';
      sourcePrefix = approvedPrefix;
    } else if (rejectedSet.has(g.id)) {
      bucket = 'rejected';
      sourcePrefix = rejectedPrefix;
    }
    if (!bucket || !sourcePrefix) continue;

    for (const stem of files) {
      if (!stem) continue;
      const looksLikePath = stem.startsWith('/');
      const filename = looksLikePath ? stem : resolveFullFilename(stem, g.exif_metadata);
      const fromPath = looksLikePath ? stem : `${sourcePrefix}${filename}`;
      const baseName = filename.split('/').pop() || filename;
      const toPath = `${proposedPrefix}${baseName}`;
      const alreadyAtDestination = fromPath
        .toLowerCase()
        .startsWith(proposedPrefix.toLowerCase());
      out.push({
        group_id: g.id,
        stem,
        bucket,
        from_path: fromPath,
        to_path: toPath,
        already_at_destination: alreadyAtDestination,
      });
    }
  }
  return out;
}

/**
 * Auto-retry transient (too_many_write_operations) failures from a Dropbox
 * batch.  Mutates `entries[]` in place at the failing positions with the
 * retry results.  Best-effort.
 */
async function retryUnlockTransients(
  toMove: ReverseMoveSpec[],
  entries: DropboxBatchEntryResult[],
): Promise<void> {
  const transientIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isTransientBatchFailure(entries[i])) transientIndices.push(i);
  }
  if (transientIndices.length === 0) return;

  console.info(
    `[${GENERATOR}] retrying ${transientIndices.length} transient (too_many_write_operations) failure(s)`,
  );

  const retryEntries: DropboxMoveEntry[] = transientIndices.map((i) => ({
    from_path: toMove[i].from_path,
    to_path: toMove[i].to_path,
  }));

  try {
    const retryResult = await moveBatchWithRetry(retryEntries, {
      app: 'engine',
      maxRetries: 3,
      backoffMs: 2000,
      pollIntervalMs: POLL_INTERVAL_MS,
      pollMaxAttempts: POLL_MAX_ATTEMPTS,
      onRetry: (round, count, msg) => {
        console.info(`[${GENERATOR}] retry round ${round}: ${count} entries — ${msg}`);
      },
    });
    for (let j = 0; j < transientIndices.length; j++) {
      const origIdx = transientIndices[j];
      const updated = retryResult.entries[j];
      if (updated) entries[origIdx] = updated;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[${GENERATOR}] retry helper threw (non-fatal): ${msg}`);
  }
}

interface TallyResult {
  moved: { total: number; succeeded: number; failed: number };
  errorsSample: Array<{ from_path: string; reason: string }>;
}

function tallyEntries(
  entries: DropboxBatchEntryResult[],
  toMove: ReverseMoveSpec[],
): TallyResult {
  let succeeded = 0;
  let failed = 0;
  const errorsSample: Array<{ from_path: string; reason: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e['.tag'] === 'success') {
      succeeded++;
      continue;
    }
    // Treat 'from_lookup/not_found' and 'to/conflict' as soft-success (file
    // already where we want it, from a prior partial run).
    const outerTag = e.failure?.['.tag'];
    // deno-lint-ignore no-explicit-any
    const inner = (e.failure as any)?.[outerTag || ''] as { '.tag'?: string } | undefined;
    const innerTag = inner?.['.tag'];
    // deno-lint-ignore no-explicit-any
    const innerDeeper = innerTag ? ((inner as any)?.[innerTag] as { '.tag'?: string } | undefined) : undefined;
    const innerDeeperTag = innerDeeper?.['.tag'];
    const isAlreadyMoved = innerTag === 'from_lookup' && innerDeeperTag === 'not_found';
    const isConflictSoft = innerTag === 'to' && innerDeeperTag === 'conflict';
    if (isAlreadyMoved || isConflictSoft) {
      succeeded++;
      continue;
    }
    failed++;
    if (errorsSample.length < 20) {
      errorsSample.push({
        from_path: toMove[i]?.from_path ?? '<unknown>',
        reason: JSON.stringify(e.failure || {}).slice(0, 200),
      });
    }
  }
  return {
    moved: { total: entries.length, succeeded, failed },
    errorsSample,
  };
}

interface FinalizeUnlockArgs {
  // deno-lint-ignore no-explicit-any
  admin: any;
  roundId: string;
  projectId: string;
  reason: string | null;
  unlockedBy: string | null;
  moved: { total: number; succeeded: number; failed: number };
  idempotentSkipped: number;
  errorsSample: Array<{ from_path: string; reason: string }>;
  priorLockedAt: string | null;
  priorLockedBy: string | null;
}

/**
 * Steps 5–7 of the unlock flow: supersede committed_decisions, flip round
 * status, write audit event.  Idempotent — safe to call after Dropbox moves
 * or after a no-op zero-work path.
 */
async function finalizeUnlock(
  args: FinalizeUnlockArgs,
): Promise<{ ok: boolean; error?: string; decisionsSuperseded: number }> {
  const { count: decisionsSuperseded, error: supersedeErr } = await args.admin
    .from('shortlisting_committed_decisions')
    .update({ superseded: true }, { count: 'exact' })
    .eq('round_id', args.roundId)
    .eq('superseded', false);
  if (supersedeErr) {
    console.warn(`[${GENERATOR}] supersede failed (non-fatal): ${supersedeErr.message}`);
  }

  const { error: roundUpdateErr } = await args.admin
    .from('shortlisting_rounds')
    .update({
      status: 'proposed',
      locked_at: null,
      locked_by: null,
    })
    .eq('id', args.roundId);
  if (roundUpdateErr) {
    return {
      ok: false,
      error: `Files moved but round status flip failed: ${roundUpdateErr.message}. Re-run shortlist-unlock to retry.`,
      decisionsSuperseded: decisionsSuperseded ?? 0,
    };
  }

  const eventPayload = {
    reason: args.reason,
    unlocked_by: args.unlockedBy,
    moved: args.moved,
    idempotent_skipped: args.idempotentSkipped,
    decisions_superseded: decisionsSuperseded ?? 0,
    errors_sample: args.errorsSample,
    prior_locked_at: args.priorLockedAt,
    prior_locked_by: args.priorLockedBy,
  };
  const { error: eventErr } = await args.admin
    .from('shortlisting_events')
    .insert({
      round_id: args.roundId,
      project_id: args.projectId,
      event_type: 'shortlist_unlocked',
      payload: eventPayload,
    });
  if (eventErr) {
    console.warn(`[${GENERATOR}] audit event insert failed (non-fatal): ${eventErr.message}`);
  }

  return { ok: true, decisionsSuperseded: decisionsSuperseded ?? 0 };
}

interface PollUnlockArgs {
  asyncJobId: string;
  toMove: ReverseMoveSpec[];
  roundId: string;
  projectId: string;
  reason: string | null;
  unlockedBy: string | null;
  idempotentSkipped: number;
  priorLockedAt: string | null;
  priorLockedBy: string | null;
}

/**
 * Background poll loop for the async path.  Polls Dropbox until complete,
 * retries transient failures, then finalizes (supersede + status flip +
 * event).  Runs in EdgeRuntime.waitUntil() — caller has already returned
 * 202 to the operator.
 */
async function pollAndFinalizeUnlock(args: PollUnlockArgs): Promise<void> {
  const admin = getAdminClient();
  let attempts = 0;
  let finalEntries: DropboxBatchEntryResult[] | null = null;

  while (attempts < POLL_MAX_ATTEMPTS) {
    attempts++;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let check;
    try {
      check = await checkMoveBatch(args.asyncJobId, { app: 'engine' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[${GENERATOR}] check_v2 attempt ${attempts} failed: ${msg}`);
      continue;
    }
    if (check['.tag'] === 'in_progress') continue;
    if (check['.tag'] === 'complete') {
      finalEntries = check.entries || [];
      break;
    }
    if (check['.tag'] === 'failed') {
      console.error(
        `[${GENERATOR}] async batch failed: ${JSON.stringify(check.failure || {})}`,
      );
      return;
    }
  }

  if (!finalEntries) {
    console.error(
      `[${GENERATOR}] poll exhausted (${POLL_MAX_ATTEMPTS} attempts × ${POLL_INTERVAL_MS}ms = ~${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s); abandoning`,
    );
    return;
  }

  await retryUnlockTransients(args.toMove, finalEntries);
  const tally = tallyEntries(finalEntries, args.toMove);
  console.info(
    `[${GENERATOR}] background batch complete: ${tally.moved.succeeded}/${tally.moved.total} succeeded, ${tally.moved.failed} failed`,
  );

  const finalizeResult = await finalizeUnlock({
    admin,
    roundId: args.roundId,
    projectId: args.projectId,
    reason: args.reason,
    unlockedBy: args.unlockedBy,
    moved: tally.moved,
    idempotentSkipped: args.idempotentSkipped,
    errorsSample: tally.errorsSample,
    priorLockedAt: args.priorLockedAt,
    priorLockedBy: args.priorLockedBy,
  });
  if (!finalizeResult.ok) {
    console.error(`[${GENERATOR}] finalize failed: ${finalizeResult.error}`);
  } else {
    console.info(
      `[${GENERATOR}] unlock complete: superseded ${finalizeResult.decisionsSuperseded} decision row(s), round flipped to proposed`,
    );
  }
}

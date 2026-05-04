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
 * What it does:
 *   1. Read approved/rejected sets from the SAME logic shortlist-lock
 *      uses (slot events + chronologically-folded overrides + classifications).
 *   2. Build reverse move specs: every file currently in
 *      `Photos/Raws/Final Shortlist/<filename>` or `Rejected/<filename>`
 *      goes back to `Shortlist Proposed/<filename>`.  Idempotent — files
 *      already at the source destination are skipped without an API call.
 *   3. Submit ONE Dropbox `/files/move_batch_v2` and poll synchronously.
 *      Most rounds are <100 files (resolves in <30s); we keep a 90s cap
 *      under the 150s edge gateway window.  If the cap is hit we return
 *      504 — the operator retries with the same call (idempotent).
 *   4. Mark every shortlisting_committed_decisions row for this round
 *      `superseded=true` so training pipelines (mig 467) ignore the
 *      stale signal.  A subsequent relock UPSERTs new rows on top of
 *      the same (round_id, group_id) primary key with superseded=false.
 *   5. Update the round: status='locked' → 'proposed', clear locked_at
 *      and locked_by.
 *   6. Write a `shortlist_unlocked` event with the operator's reason
 *      text (audit trail — pairs with `shortlist_locked` for
 *      diagnostics).
 *
 * What it does NOT do:
 *   - Does NOT re-run Pass 0 / extraction.  composition_groups +
 *     classifications + slot events stay valid for the same RAW set.
 *   - Does NOT delete shortlisting_overrides.  WIP review state is
 *     preserved so the operator walks back into the swimlane in the
 *     state they left it.
 *   - Does NOT update the Dropbox audit JSON written at lock time.
 *     The original lock audit remains as a historical artefact; the
 *     next lock (after edits) writes a fresh audit JSON with the
 *     updated approved/rejected sets.
 *
 * POST { round_id, reason? }
 * Auth: master_admin only OR service_role.  This is intentionally
 * stricter than shortlist-lock (which allows admin/manager too) — unlock
 * has more downside if misused.
 *
 * Response:
 *   {
 *     ok: true,
 *     round_id,
 *     moved: { total, succeeded, failed },
 *     decisions_superseded: N,
 *     status: 'proposed'
 *   }
 *
 * Failure modes:
 *   - 403 if caller is not master_admin
 *   - 409 if round.status !== 'locked' (already proposed, or terminal)
 *   - 502 if Dropbox batch submit fails
 *   - 504 if sync poll exceeds the 90s cap (operator retries)
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

// Sync-poll cap.  Edge gateway times out at 150s; we cap at 90s so a
// caller-side retry has headroom to complete after a partial batch.
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 30; // ~90s

interface UnlockBody {
  round_id?: string;
  /** Free-text reason persisted to shortlisting_events.payload.reason. */
  reason?: string;
  _health_check?: boolean;
}

interface ReverseMoveSpec {
  group_id: string;
  stem: string;
  bucket: 'approved' | 'rejected';
  /** Source: `<final_shortlist>/<filename>` or `<rejected>/<filename>`. */
  from_path: string;
  /** Destination: `<shortlist_proposed>/<filename>`. */
  to_path: string;
  /** Idempotency: file already lives at the destination — no API call. */
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
        'Forbidden — only master_admin can unlock a shortlist (admin/manager are excluded; this is intentionally stricter than lock)',
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
    return jsonResponse({ _version: 'v1.0-unlock', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id?.trim();
  if (!roundId) return errorResponse('round_id required', 400, req);
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  const admin = getAdminClient();

  // ── Load round + validate state ─────────────────────────────────────────
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, locked_at, locked_by, round_number, package_type')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) return errorResponse(`round lookup failed: ${roundErr.message}`, 500, req);
  if (!round) return errorResponse(`round ${roundId} not found`, 404, req);

  // Only `locked` rounds can be unlocked.  `proposed` is already unlocked
  // (no-op).  `delivered`/`backfilled`/`manual` are terminal/special:
  // unlocking them is out of scope and could corrupt downstream state.
  if (round.status !== 'locked') {
    return errorResponse(
      `Round status is '${round.status}' — only 'locked' rounds can be unlocked.`,
      409,
      req,
    );
  }

  // ── Load groups + classifications + events + overrides ─────────────────
  // Same shape as shortlist-lock so computeApprovedRejectedSets returns
  // an identical (approvedSet, rejectedSet) — guarantees the reverse
  // moves we submit exactly mirror the original lock's move set.
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
      'Project Photos/* folders are missing required kinds (Shortlist Proposed / Final Shortlist / Rejected)',
      500,
      req,
    );
  }

  // ── Build reverse move specs ────────────────────────────────────────────
  // For every file in the lock's approvedSet/rejectedSet, plan a move
  // FROM the bucket dest BACK TO Shortlist Proposed.  Mirror buildMoveSpecs'
  // stem-resolution logic (audit defect #19) so filenames match Dropbox.
  const proposedPrefix = proposedDest.replace(/\/+$/, '') + '/';
  const approvedPrefix = approvedDest.replace(/\/+$/, '') + '/';
  const rejectedPrefix = rejectedDest.replace(/\/+$/, '') + '/';

  const sortedGroups = [...groups].sort((a, b) => a.id.localeCompare(b.id));
  const reverseSpecs: ReverseMoveSpec[] = [];

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
      reverseSpecs.push({
        group_id: g.id,
        stem,
        bucket,
        from_path: fromPath,
        to_path: toPath,
        already_at_destination: alreadyAtDestination,
      });
    }
  }

  const toMove = reverseSpecs.filter((s) => !s.already_at_destination);
  const idempotentSkipped = reverseSpecs.length - toMove.length;

  // ── Submit Dropbox batch (or skip if no work) ───────────────────────────
  let movedSucceeded = 0;
  let movedFailed = 0;
  const errorsSample: Array<{ from_path: string; reason: string }> = [];

  if (toMove.length > 0) {
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

    let finalEntries = submitResult.entries || null;
    if (submitResult['.tag'] === 'async_job_id' && submitResult.async_job_id) {
      // Poll synchronously up to ~90s.  90s is comfortably under the 150s
      // edge gateway cap; if the batch is genuinely larger we return 504
      // and the operator retries (idempotent — files already moved skip).
      const jobId = submitResult.async_job_id;
      let attempts = 0;
      while (attempts < POLL_MAX_ATTEMPTS) {
        attempts++;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let check;
        try {
          check = await checkMoveBatch(jobId, { app: 'engine' });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[${GENERATOR}] check_v2 transient: ${msg}`);
          continue;
        }
        if (check['.tag'] === 'in_progress') continue;
        if (check['.tag'] === 'complete') {
          finalEntries = check.entries || [];
          break;
        }
        if (check['.tag'] === 'failed') {
          return errorResponse(
            `Dropbox batch failed: ${JSON.stringify(check.failure || {})}`,
            502,
            req,
          );
        }
      }
      if (!finalEntries) {
        return errorResponse(
          `Dropbox batch did not complete within ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s — retry the request (idempotent; already-moved files will be skipped).`,
          504,
          req,
        );
      }
    }

    // Tally + capture failure samples.
    if (finalEntries) {
      for (let i = 0; i < finalEntries.length; i++) {
        const e = finalEntries[i];
        if (e['.tag'] === 'success') {
          movedSucceeded++;
        } else {
          movedFailed++;
          if (errorsSample.length < 20) {
            errorsSample.push({
              from_path: toMove[i]?.from_path ?? '<unknown>',
              reason: JSON.stringify(e.failure || {}).slice(0, 200),
            });
          }
        }
      }
    }
  }

  // ── Mark committed_decisions superseded ─────────────────────────────────
  // Mig 468: training pipelines filter WHERE superseded=false, so this
  // single UPDATE invalidates the prior lock's training signal.  A
  // subsequent relock will UPSERT new rows (superseded=false default)
  // for the same (round_id, group_id) — see writeCommittedDecisions in
  // shortlist-lock.
  const { count: decisionsSuperseded, error: supersedeErr } = await admin
    .from('shortlisting_committed_decisions')
    .update({ superseded: true }, { count: 'exact' })
    .eq('round_id', roundId)
    .eq('superseded', false);
  if (supersedeErr) {
    console.warn(`[${GENERATOR}] mig 468 supersede failed (non-fatal): ${supersedeErr.message}`);
  }

  // ── Flip round status back ──────────────────────────────────────────────
  const { error: roundUpdateErr } = await admin
    .from('shortlisting_rounds')
    .update({
      status: 'proposed',
      locked_at: null,
      locked_by: null,
    })
    .eq('id', roundId);
  if (roundUpdateErr) {
    return errorResponse(
      `Files moved but round status flip failed: ${roundUpdateErr.message}. Re-run shortlist-unlock to retry.`,
      500,
      req,
    );
  }

  // ── Audit event ─────────────────────────────────────────────────────────
  const eventPayload = {
    reason: reason ?? null,
    unlocked_by: isService ? null : (user?.id ?? null),
    moved: {
      total: toMove.length,
      succeeded: movedSucceeded,
      failed: movedFailed,
    },
    idempotent_skipped: idempotentSkipped,
    decisions_superseded: decisionsSuperseded ?? 0,
    errors_sample: errorsSample,
    prior_locked_at: round.locked_at,
    prior_locked_by: round.locked_by,
  };
  const { error: eventErr } = await admin
    .from('shortlisting_events')
    .insert({
      round_id: roundId,
      project_id: round.project_id,
      event_type: 'shortlist_unlocked',
      payload: eventPayload,
    });
  if (eventErr) {
    console.warn(`[${GENERATOR}] audit event insert failed (non-fatal): ${eventErr.message}`);
  }

  return jsonResponse(
    {
      ok: true,
      round_id: roundId,
      status: 'proposed',
      moved: {
        total: toMove.length,
        succeeded: movedSucceeded,
        failed: movedFailed,
      },
      idempotent_skipped: idempotentSkipped,
      decisions_superseded: decisionsSuperseded ?? 0,
    },
    200,
    req,
  );
});

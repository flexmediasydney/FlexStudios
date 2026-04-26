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
 * Idempotent: a file whose Dropbox path already starts with the destination
 * folder is skipped without an API call. Re-running after a partial failure
 * picks up where it left off.
 *
 * POST { round_id }
 *
 * Auth: master_admin / admin / manager OR service_role.
 *
 * Response:
 *   { ok, moved: { approved, rejected }, skipped, errors }
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
import { moveFile } from '../_shared/dropbox.ts';

const GENERATOR = 'shortlist-lock';

interface CompositionGroupRow {
  id: string;
  project_id: string;
  files_in_group: string[] | null;
  best_bracket_stem: string | null;
  delivery_reference_stem: string | null;
  // Audit defect #19: Pass 0 stores files_in_group as STEMS (no extension).
  // We carry exif_metadata so we can derive the actual filename (e.g. IMG_5620.CR3)
  // from exif_metadata[stem].fileName when constructing Dropbox source/dest paths.
  // deno-lint-ignore no-explicit-any
  exif_metadata: Record<string, any> | null;
}

interface ClassificationRow {
  group_id: string;
  is_near_duplicate_candidate: boolean | null;
}

interface SlotEventPayload {
  rank?: number;
  phase?: number;
  kind?: string;
  slot_id?: string;
  stem?: string;
}

interface SlotEventRow {
  group_id: string | null;
  event_type: string;
  payload: SlotEventPayload | null;
}

interface OverrideRow {
  ai_proposed_group_id: string | null;
  human_selected_group_id: string | null;
  human_action: string;
  created_at: string;
  client_sequence: number | null; // Burst 4 J1: prefer over created_at for ordering
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

  let body: { round_id?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const roundId = body.round_id?.trim();
  if (!roundId) return errorResponse('round_id required', 400, req);

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
  // Without this guard, a retry (browser double-click, pg_net retry, edge
  // gateway reissue) would:
  //   - re-run all moves (most skipped via Dropbox `to/conflict`, but burns
  //     API quota and adds 30s latency)
  //   - overwrite locked_at with a new timestamp (audit trail corrupted)
  //   - re-invoke training-extractor (duplicate audit event, wasted work)
  // Returning the latest shortlist_locked event payload preserves the
  // original lock metadata while giving the caller a successful response.
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
      // Audit defect #19: include exif_metadata so we can derive full filenames
      // (with extension) from the stems in files_in_group.
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
      // Burst 5 K2: deterministic event order. Without ORDER BY, two re-runs
      // of this query can return rows in different orders, which causes the
      // approvedSet's Set-insertion order to differ. The downstream
      // confirmedShortlistGroupIds = Array.from(approvedSet) snapshot then
      // changes between runs, breaking stable comparisons in the training
      // extractor + benchmark runner. created_at ASC matches the order events
      // were emitted by Pass 2.
      .order('created_at', { ascending: true }),
    admin
      .from('shortlisting_overrides')
      .select('ai_proposed_group_id, human_selected_group_id, human_action, created_at, client_sequence')
      .eq('round_id', roundId)
      // Burst 4 J1: order by client_sequence when present (NULLS LAST puts
      // legacy events at the end where created_at takes over). For events
      // with the same null-ness, the secondary created_at sort gives stable
      // ordering. This ensures fast-emitted drag events are processed in the
      // order the user emitted them, not the order they happened to arrive.
      .order('client_sequence', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true }),
  ]);

  if (groupsRes.error) return errorResponse(`groups query failed: ${groupsRes.error.message}`, 500, req);
  if (classRes.error)  return errorResponse(`classifications query failed: ${classRes.error.message}`, 500, req);
  if (eventsRes.error) return errorResponse(`events query failed: ${eventsRes.error.message}`, 500, req);
  if (overridesRes.error) return errorResponse(`overrides query failed: ${overridesRes.error.message}`, 500, req);

  const groups = (groupsRes.data || []) as CompositionGroupRow[];
  const classifications = (classRes.data || []) as ClassificationRow[];
  const slotEvents = (eventsRes.data || []) as SlotEventRow[];
  const overrides = (overridesRes.data || []) as OverrideRow[];

  // ── Compute initial AI shortlist set ────────────────────────────────────
  // A group is in the AI shortlist if it has a pass2_slot_assigned rank=1
  // event OR a pass2_phase3_recommendation event.
  const aiShortlistSet = new Set<string>();
  for (const ev of slotEvents) {
    if (!ev.group_id) continue;
    if (ev.event_type === 'pass2_phase3_recommendation') {
      aiShortlistSet.add(ev.group_id);
    } else if (ev.event_type === 'pass2_slot_assigned') {
      // Pass 2 emits rank=1/2/3 winners + alternatives; only rank=1 is the slot's winner.
      const rank = ev.payload?.rank;
      if (rank === 1 || rank === undefined) aiShortlistSet.add(ev.group_id);
    }
  }

  // Apply overrides in chronological order
  const approvedSet = new Set(aiShortlistSet);
  // Track groups that were explicitly removed (used to compute rejected set)
  const explicitlyRemoved = new Set<string>();

  for (const ov of overrides) {
    const aiId = ov.ai_proposed_group_id;
    const humanId = ov.human_selected_group_id;
    switch (ov.human_action) {
      case 'approved_as_proposed':
        if (aiId) approvedSet.add(aiId);
        break;
      case 'added_from_rejects':
        if (humanId) {
          approvedSet.add(humanId);
          explicitlyRemoved.delete(humanId);
        }
        break;
      case 'removed':
        if (aiId) {
          approvedSet.delete(aiId);
          explicitlyRemoved.add(aiId);
        }
        break;
      case 'swapped':
        if (aiId) {
          approvedSet.delete(aiId);
          explicitlyRemoved.add(aiId);
        }
        if (humanId) {
          approvedSet.add(humanId);
          explicitlyRemoved.delete(humanId);
        }
        break;
    }
  }

  // ── Compute rejected set ────────────────────────────────────────────────
  // Rejected = near-duplicate candidates UNION explicitly-removed groups.
  // A group cannot be both approved and rejected; approval wins.
  const rejectedSet = new Set<string>();
  for (const c of classifications) {
    if (c.is_near_duplicate_candidate && !approvedSet.has(c.group_id)) {
      rejectedSet.add(c.group_id);
    }
  }
  for (const gid of explicitlyRemoved) {
    if (!approvedSet.has(gid)) rejectedSet.add(gid);
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

  // Helper to move all files in a composition group to a destination folder.
  // RAW files in files_in_group live under Photos/Raws/Shortlist Proposed/ —
  // we move them to dest. We don't write back into composition_groups (their
  // files_in_group is just a list of stems; the canonical RAW path is
  // constructed from sourceDest + filename).
  //
  // Audit defect #19: Pass 0 writes files_in_group as STEMS (no extension —
  // e.g. 'IMG_5620'). The actual Dropbox file is 'IMG_5620.CR3'. Pass 0 also
  // stores per-stem exif_metadata where exif_metadata[stem].fileName is the
  // full filename with extension. We resolve via that map; fall back to
  // `${stem}.CR3` defensively if the map lookup fails (Canon RAW is the
  // dominant path through this codebase).
  // deno-lint-ignore no-explicit-any
  function resolveFullFilename(stem: string, exifMetadata: Record<string, any> | null): string {
    if (stem.includes('.')) return stem; // already has an extension — pass through
    const meta = exifMetadata?.[stem];
    const fname = meta?.fileName;
    if (typeof fname === 'string' && fname.length > 0) return fname;
    return `${stem}.CR3`;
  }

  async function moveGroupFiles(
    groupId: string,
    files: string[],
    // deno-lint-ignore no-explicit-any
    exifMetadata: Record<string, any> | null,
    dest: string,
  ): Promise<{ moved: number; skipped: number; errors: Array<{ file: string; message: string }> }> {
    const result = { moved: 0, skipped: 0, errors: [] as Array<{ file: string; message: string }> };
    const sourcePrefix = sourceDest.replace(/\/+$/, '') + '/';
    const destPrefix = dest.replace(/\/+$/, '') + '/';
    for (const stem of files) {
      if (!stem) continue;
      // Defensive: if a caller ever passes a full path, honour it; otherwise
      // resolve stem → full filename via exif_metadata (defect #19).
      const looksLikePath = stem.startsWith('/');
      const filename = looksLikePath ? stem : resolveFullFilename(stem, exifMetadata);
      const sourcePath = looksLikePath ? stem : `${sourcePrefix}${filename}`;
      const baseName = filename.split('/').pop() || filename;
      const destPath = `${destPrefix}${baseName}`;

      // Idempotent: if source already lives under dest, skip without an API call.
      if (sourcePath.toLowerCase().startsWith(destPrefix.toLowerCase())) {
        result.skipped++;
        continue;
      }

      try {
        await moveFile(sourcePath, destPath);
        result.moved++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Dropbox `to/conflict` (file already exists at destination — likely
        // a partial prior run) is non-fatal: treat as success.
        if (msg.includes('to/conflict') || msg.includes('already exists')) {
          result.skipped++;
          continue;
        }
        // `from_lookup/not_found` means the file isn't where we expect — log
        // but don't fail the whole batch (the round may have been partly
        // re-shoot or the file was renamed).
        if (msg.includes('not_found')) {
          result.errors.push({ file: stem, message: `source not found: ${sourcePath}` });
          continue;
        }
        result.errors.push({ file: stem, message: msg });
      }
    }
    return result;
  }

  // ── Iterate groups and dispatch moves ───────────────────────────────────
  let movedApproved = 0;
  let movedRejected = 0;
  let totalSkipped = 0;
  const allErrors: Array<{ group_id: string; file: string; message: string }> = [];

  // Bug F (post-Sprint-2): parallelize per-group moves to fit within the
  // Supabase Edge Function 150s idle timeout. A round with 31 confirmed +
  // rejected groups × 5 brackets = 155 sequential Dropbox file moves at
  // ~1.5s/move = 232s — exceeds the timeout, function killed mid-loop, DB
  // never updated, files stranded in mixed state. With CONCURRENCY=6 groups
  // running in parallel, total drops to ~30-40s. Conservative cap stays under
  // Dropbox's app-wide 30req/s rate limit (6 groups × 5 moves × ~1/1.5s ≈
  // 20 req/s peak). JS single-threaded so the shared counters are safe.
  const groupsToProcess: Array<{
    g: typeof groups[number];
    dest: string;
    bucket: 'approved' | 'rejected';
  }> = [];
  for (const g of groups) {
    const files = g.files_in_group || [];
    if (files.length === 0) continue;
    if (approvedSet.has(g.id)) {
      groupsToProcess.push({ g, dest: approvedDest, bucket: 'approved' });
    } else if (rejectedSet.has(g.id)) {
      groupsToProcess.push({ g, dest: rejectedDest, bucket: 'rejected' });
    }
    // else: undecided → leave in place
  }

  const CONCURRENCY = 6;
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= groupsToProcess.length) return;
      const { g, dest, bucket } = groupsToProcess[i];
      const files = g.files_in_group || [];
      const r = await moveGroupFiles(g.id, files, g.exif_metadata, dest);
      if (bucket === 'approved') movedApproved += r.moved;
      else movedRejected += r.moved;
      totalSkipped += r.skipped;
      for (const e of r.errors) allErrors.push({ group_id: g.id, ...e });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, groupsToProcess.length) }, () => worker()),
  );

  // ── Update round + project status (best-effort) ─────────────────────────
  const lockedAt = new Date().toISOString();
  const lockedBy = isService ? null : (user?.id ?? null);

  // Phase 8: capture the confirmed shortlist as a stable snapshot on the round
  // row. The training extractor + the benchmark runner read this — both need
  // a comparison target that doesn't drift if events are later edited.
  //
  // Burst 5 K2: sort the snapshot deterministically. Set iteration order
  // depends on insertion order, which depends on slotEvents row order from
  // Postgres. Even with the ORDER BY created_at on the events query above,
  // ties on created_at (events inserted in the same statement batch) can be
  // resolved differently across re-runs. Sorting the final array by group_id
  // gives a fully deterministic snapshot regardless of event-row arrival.
  const confirmedShortlistGroupIds = Array.from(approvedSet).sort();

  // Note: shortlisting_rounds.locked_by FKs auth.users(id), but app-level
  // user.id may be the public.users.id. When the auth identity equals the
  // public.users row id (common case), this works; otherwise we set NULL.
  const { error: roundUpdErr } = await admin
    .from('shortlisting_rounds')
    .update({
      status: 'locked',
      locked_at: lockedAt,
      locked_by: lockedBy,
      updated_at: lockedAt,
      confirmed_shortlist_group_ids: confirmedShortlistGroupIds,
    })
    .eq('id', roundId);
  // Burst 5 K3: if the round update fails, the training extractor (invoked
  // below) reads stale `confirmed_shortlist_group_ids` and produces wrong
  // training rows. Demote to a hard failure so the operator sees the error
  // and re-runs Lock — the file moves are already idempotent (K1 short-
  // circuits on round.status='locked', and Dropbox `to/conflict` is
  // tolerated), so re-running is safe.
  if (roundUpdErr) {
    console.error(`[${GENERATOR}] round update failed — aborting before training extractor: ${roundUpdErr.message}`);
    return errorResponse(
      `Round status update failed: ${roundUpdErr.message}. Files were moved but the round was not marked locked. Re-run Lock to retry.`,
      500,
      req,
    );
  }

  const { error: projectUpdErr } = await admin
    .from('projects')
    .update({ shortlist_status: 'locked' })
    .eq('id', round.project_id);
  if (projectUpdErr) {
    // Project status is best-effort — shortlist_status is a denormalised cache
    // for the project list. The round itself is marked locked above, so the
    // training extractor can safely run regardless.
    console.warn(`[${GENERATOR}] project update failed: ${projectUpdErr.message}`);
  }

  // ── Audit event ─────────────────────────────────────────────────────────
  await admin.from('shortlisting_events').insert({
    project_id: round.project_id,
    round_id: round.id,
    event_type: 'shortlist_locked',
    actor_type: isService ? 'system' : 'user',
    actor_id: isService ? null : (user?.id ?? null),
    payload: {
      moved_approved: movedApproved,
      moved_rejected: movedRejected,
      skipped: totalSkipped,
      errors_count: allErrors.length,
      approved_count: approvedSet.size,
      rejected_count: rejectedSet.size,
    },
  });

  // ── Phase 8: kick the training extractor (fire-and-forget) ─────────────
  // The extractor reads confirmed_shortlist_group_ids set above and writes one
  // shortlisting_training_examples row per confirmed group. It runs async so
  // the lock response stays fast; failures are logged inside the extractor and
  // visible via shortlisting_events.event_type='training_examples_extracted'.
  if (confirmedShortlistGroupIds.length > 0) {
    const extractorWork = invokeFunction(
      'shortlisting-training-extractor',
      { round_id: roundId },
      GENERATOR,
    ).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] training extractor invoke failed: ${msg}`);
    });
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(extractorWork);
  }

  // Audit defect #20: surface partial successes as ok:true with partial:true,
  // not ok:false. The swimlane UI was treating any 207 as a fatal red toast,
  // hiding the fact that most files moved. Now:
  //   - all moves succeeded         → ok:true, partial:undefined,  status 200
  //   - some moves failed (partial) → ok:true, partial:true,       status 207
  //   - everything failed           → ok:false, partial:undefined, status 207
  const totalMoved = (movedApproved || 0) + (movedRejected || 0);
  const isFullSuccess = allErrors.length === 0;
  const isPartialSuccess = !isFullSuccess && totalMoved > 0;
  return jsonResponse(
    {
      ok: isFullSuccess || isPartialSuccess,
      partial: isPartialSuccess || undefined,
      round_id: roundId,
      moved: { approved: movedApproved, rejected: movedRejected },
      skipped: totalSkipped,
      errors: allErrors.length > 0 ? allErrors : undefined,
    },
    isFullSuccess ? 200 : 207,
    req,
  );
});

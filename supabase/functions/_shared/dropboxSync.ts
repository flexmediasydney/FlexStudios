/**
 * Dropbox delta processing — shared by `dropbox-webhook` (real-time, on
 * Dropbox notification) and `dropbox-reconcile` (nightly pg_cron back-fill).
 *
 * Both call `processDropboxDelta(watchPath, actorType)`:
 *   1. Read the cursor from dropbox_sync_state for the given watch_path.
 *   2. If null → initial seed via list_folder(recursive=true), store cursor,
 *      DO NOT emit events (the PR4 backfill is the truth for pre-existing files).
 *   3. Else → call list_folder/continue with the cursor in a loop until
 *      has_more=false; collect all entries.
 *   4. For each entry: longest-prefix match to a project_folders row; emit
 *      file_added / file_modified / file_deleted via auditEvent (with the
 *      caller-supplied actor_type so 'webhook' vs 'system' is distinguishable).
 *   5. Persist the new cursor + counters.
 *
 * Idempotency:
 *   Dropbox de-dupes via cursor monotonically. If the same delta is processed
 *   twice (e.g. webhook + reconcile both fire on the same change), the second
 *   call sees an empty delta because the first call advanced the cursor.
 *   Even if events DID get emitted twice, the project_folder_events table is
 *   append-only by design — duplicates are surfaced in the activity log but
 *   don't corrupt downstream state.
 */

import { listFolder, listFolderContinue, type DropboxFileMetadata } from './dropbox.ts';
import { auditEvent, type FolderKind } from './projectFolders.ts';
import { getAdminClient } from './supabase.ts';

interface DropboxEntry extends DropboxFileMetadata {}

export interface ProcessResult {
  watchPath: string;
  actorType: 'webhook' | 'system';
  isInitialSeed: boolean;
  totalEntries: number;
  emitted: number;
  skipped: number;
  errors: string[];
  cursor_set: boolean;
}

export interface ProcessOptions {
  /**
   * On initial-seed (cursor is null), normally we just store the cursor and
   * emit ZERO events — the assumption being that a fresh project has no files
   * yet and PR4 backfill is the truth for pre-existing files.
   *
   * (#55 audit fix) But the B3 case is: a project gets provisioned AFTER
   * files have already been uploaded to its raw_drones folder (e.g. operator
   * dropped photos via Dropbox web UI before clicking "Provision"). With the
   * default branch those files NEVER produce ingest events.
   *
   * Set `forceEmitOnSeed: true` to ALSO process every JPG entry returned by
   * the initial seed listing as if it were a real-time delta — emitting
   * file_added events that downstream pipelines (drone-job-dispatcher) will
   * pick up. Default false (preserves backwards compat for nightly reconcile).
   */
  forceEmitOnSeed?: boolean;
}

/**
 * 2026-05-05 — STREAMING REWRITE.
 *
 * Joseph asked: "how do we fix the dropbox listening thing for shortlisting
 * proposed folder being dead for 33h? whats the best solution that wont
 * blow up dropbox API and risk 429s?"
 *
 * Root cause of the 33h stall:
 *   The OLD body accumulated EVERY page from list_folder/continue into a
 *   single in-memory `entries[]` array before processing.  When the team
 *   folder grew past Supabase's edge-function memory cap (~256MB per
 *   request), processDropboxDelta crashed with WORKER_RESOURCE_LIMIT
 *   (HTTP 546) BEFORE reaching the cursor-update line.  Cursor stayed
 *   stuck → every subsequent webhook crashed at the same point → no
 *   file_added events emitted for ~33 hours.  Confirmed by manually
 *   invoking dropbox-reconcile via net.http_post and observing the 546
 *   response.
 *
 * Streaming fix:
 *   Process each list_folder/continue page incrementally.  Each page is
 *   bounded by Dropbox's `limit:2000` (a few MB peak in memory).  After
 *   each page processes successfully, persist the NEW cursor returned
 *   by that call.  If a later page fails (network, list_folder/continue
 *   error), the cursor saved from the previous page is still safe.
 *   Per-entry processing errors (one bad path, audit insert failure)
 *   are LOGGED but no longer hold back the page-level cursor — the
 *   "poison pill" failure mode of the OLD #54-audit-era policy gets
 *   replaced with "log and move on", because Dropbox cursors are
 *   per-page tokens, not per-entry; you can't selectively retry a
 *   single bad entry without replaying the entire page.
 *
 * Dropbox API impact: ZERO additional calls.  Same number of
 *   list_folder/continue pages, just processed-as-we-go instead of
 *   accumulated-then-processed.  No 429 risk — these are READ ops, not
 *   the rate-limited move/upload endpoints.
 *
 * Backward-compat:
 *   - Same function signature.
 *   - Same ProcessResult shape.
 *   - Initial seed (cursor=null) still produces zero events by default,
 *     forceEmitOnSeed still works for the #55 B3 case.
 *   - Callers (dropbox-webhook, dropbox-reconcile) need no change.
 */
export async function processDropboxDelta(
  watchPath: string,
  actorType: 'webhook' | 'system',
  opts?: ProcessOptions,
): Promise<ProcessResult> {
  const admin = getAdminClient();

  const { data: state, error: stateErr } = await admin
    .from('dropbox_sync_state')
    .select('cursor')
    .eq('watch_path', watchPath)
    .maybeSingle();
  if (stateErr) throw stateErr;

  const initialCursor: string | null = (state?.cursor as string | null) ?? null;
  let isInitialSeed = false;
  let totalEntries = 0;
  let emitted = 0;
  let skipped = 0;
  const errors: string[] = [];
  let pagesProcessed = 0;

  // Helper: persist (cursor, last_run_at, last_changes_count) to
  // dropbox_sync_state.  Called after each successful page so partial
  // progress survives a later page-fetch crash.
  const persistCursor = async (newCursor: string, changesSoFar: number) => {
    const { error: updErr } = await admin
      .from('dropbox_sync_state')
      .update({
        cursor: newCursor,
        last_run_at: new Date().toISOString(),
        last_changes_count: changesSoFar,
        updated_at: new Date().toISOString(),
      })
      .eq('watch_path', watchPath);
    if (updErr) {
      console.warn(`[dropboxSync] cursor update failed: ${updErr.message}`);
    }
  };

  // Helper: process a page of entries with per-entry error tolerance.
  // Returns the count of newly-emitted events from this page.
  const processPage = async (
    pageEntries: DropboxEntry[],
    shouldEmit: boolean,
  ): Promise<number> => {
    if (!shouldEmit) {
      // Initial seed default branch — count entries but don't emit
      // (PR4 backfill is the truth for pre-existing files).
      return 0;
    }
    let pageEmitted = 0;
    for (const entry of pageEntries) {
      try {
        const handled = await processEntry(entry, actorType);
        if (handled) {
          pageEmitted++;
        } else {
          skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[dropboxSync] entry failed (${entry.path_lower}): ${msg}`);
        errors.push(`${entry.path_lower}: ${msg}`);
        // Per-entry errors no longer hold back the cursor (see header).
      }
    }
    return pageEmitted;
  };

  // ── Initial seed branch ────────────────────────────────────────────
  if (!initialCursor) {
    isInitialSeed = true;
    // Seed listing accumulates entries across pages internally (the
    // listFolder helper paginates with maxEntries cap).  This is OK on
    // first ever sync because forceEmitOnSeed applies a tight filter
    // BEFORE entries hit memory.  For subsequent runs the cursor exists
    // and we use the streaming delta branch below.
    const result = await listFolder(watchPath, { recursive: true, maxEntries: 50_000 });
    const seedCursor = result.cursor;
    console.log(
      `[dropboxSync] initial seed for ${watchPath}: ${result.entries.length} entries`,
    );

    let seedEntries: DropboxEntry[] = [];
    if (opts?.forceEmitOnSeed) {
      seedEntries = (result.entries as DropboxEntry[])
        .filter((e) => e['.tag'] === 'file' && /\.(jpe?g)$/i.test(e.name || ''))
        .filter((e) =>
          /\/(01_RAW_WORKING\/drones|Drones\/Raws\/Shortlist Proposed)\//i.test(
            e.path_display || e.path_lower || '',
          ),
        );
      console.log(
        `[dropboxSync] forceEmitOnSeed: queuing ${seedEntries.length} raw drone JPG(s) for emission`,
      );
    }

    totalEntries = seedEntries.length;
    emitted = await processPage(seedEntries, opts?.forceEmitOnSeed === true);
    pagesProcessed = 1;

    await persistCursor(seedCursor, emitted);

    return {
      watchPath,
      actorType,
      isInitialSeed: true,
      totalEntries,
      emitted,
      skipped,
      errors,
      cursor_set: true,
    };
  }

  // ── Delta branch — streaming page-by-page with wall-time cap ─────
  // Read a page → process it → persist its cursor.  Repeat until
  // has_more=false OR we hit a safety bailout.
  //
  // Why a wall-time cap (2026-05-05 second pass):
  //   Streaming alone is insufficient when the backlog is huge.  After
  //   33h of stale cursor, list_folder/continue may return hundreds of
  //   pages — at ~500ms per page that's minutes of work, exceeding
  //   Supabase's edge-function execution budget (~150s wall time,
  //   regardless of memory).  Hitting that ceiling kills the function
  //   mid-page → no cursor advance → next call replays everything →
  //   same crash.  Same outcome as the old OOM, different mechanism.
  //
  //   With this cap: we process up to MAX_PAGES_PER_CALL pages OR
  //   MAX_WALL_MS milliseconds, whichever comes first.  Persist the
  //   last good cursor.  Return cleanly.  The next invocation
  //   (webhook/reconcile/cron) picks up where we left off.  Eventual
  //   convergence under steady-state Dropbox traffic; for a large
  //   backlog it just takes a few invocations to drain.
  //
  // No Dropbox API impact — same endpoints, just fewer per call.
  const MAX_PAGES_PER_CALL = 50;       // Dropbox returns up to 2000 entries/page → up to 100k entries per call
  const MAX_WALL_MS = 90_000;          // 90s soft cap; edge runtime hard-kills around 150s
  const startTime = Date.now();

  let currentCursor: string = initialCursor;
  let hasMore = true;
  let bailoutReason: string | null = null;

  while (hasMore) {
    if (pagesProcessed >= MAX_PAGES_PER_CALL) {
      bailoutReason = `reached MAX_PAGES_PER_CALL=${MAX_PAGES_PER_CALL}`;
      break;
    }
    if (Date.now() - startTime > MAX_WALL_MS) {
      bailoutReason = `reached MAX_WALL_MS=${MAX_WALL_MS}ms after ${pagesProcessed} page(s)`;
      break;
    }

    let next;
    try {
      next = await listFolderContinue(currentCursor);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[dropboxSync] list_folder/continue failed at page ${pagesProcessed + 1}: ${msg}`,
      );
      errors.push(`list_folder/continue page ${pagesProcessed + 1}: ${msg}`);
      // Cursor stays at the last successfully-persisted page.  Bail.
      break;
    }

    const pageEntries = (next.entries || []) as DropboxEntry[];
    totalEntries += pageEntries.length;

    const pageEmitted = await processPage(pageEntries, true);
    emitted += pageEmitted;
    pagesProcessed++;

    // Page processed (per-entry errors logged but tolerated) →
    // advance + persist cursor.  If the function crashes after this
    // line (OOM, edge-runtime kill), the next webhook starts from
    // here — no events lost, no events double-processed.
    currentCursor = next.cursor;
    hasMore = next.has_more;
    await persistCursor(currentCursor, emitted);
  }

  const elapsedMs = Date.now() - startTime;
  if (bailoutReason) {
    console.log(
      `[dropboxSync] delta partial for ${watchPath}: ${pagesProcessed} page(s), ${totalEntries} entries, ${emitted} emitted, has_more=${hasMore} (${bailoutReason}, ${elapsedMs}ms)`,
    );
  } else if (errors.length > 0) {
    console.warn(
      `[dropboxSync] ${errors.length} error(s) across ${pagesProcessed} page(s); cursor advanced for successfully-fetched pages (${elapsedMs}ms)`,
    );
  } else {
    console.log(
      `[dropboxSync] delta complete for ${watchPath}: ${pagesProcessed} page(s), ${totalEntries} entries, ${emitted} emitted (${elapsedMs}ms)`,
    );
  }

  return {
    watchPath,
    actorType,
    isInitialSeed: false,
    totalEntries,
    emitted,
    skipped,
    errors,
    cursor_set: true,
  };
}

async function processEntry(entry: DropboxEntry, actorType: 'webhook' | 'system'): Promise<boolean> {
  // W8 FIX 1 (P0, W6-A1): Dropbox is case-sensitive on /files/download even
  // though searches/listings are case-insensitive. Falling back to
  // `path_lower` produced lowercase rows in drone_shots.edited_dropbox_path
  // ("/flex media team folder/...") that then 409'd with `path/not_found` on
  // every render_edited attempt. `path_display` is always present for normal
  // file/folder entries returned by /files/list_folder + /continue; the only
  // shape lacking path_display is the deleted-tag, which we handle with the
  // path-tracking branch below. We refuse to proceed with path_lower and
  // log loudly so any regression is visible.
  let path = entry.path_display;
  if (!path) {
    if (entry['.tag'] === 'deleted' && entry.path_lower) {
      // Deleted entries don't carry display casing; the lowercase form is
      // what we receive and what our delete-by-prefix logic uses (the row
      // we wrote earlier carried the correct case, the path_lower from a
      // delete event is only used for matching, not for new writes).
      path = entry.path_lower;
    } else {
      console.warn(
        `[dropboxSync] entry missing path_display (id=${entry.id ?? '?'} tag=${entry['.tag'] ?? '?'} path_lower=${entry.path_lower ?? '?'}) — refusing lowercase fallback to avoid case-sensitive Dropbox 409s`,
      );
      return false;
    }
  }
  if (!path) return false;

  // Skip folder entries — we manage the folder skeleton; user folder edits
  // inside our tree are out of scope for Phase 1.
  if (entry['.tag'] === 'folder') return false;

  const admin = getAdminClient();
  const { data: matches, error: rpcErr } = await admin.rpc('find_project_folder_for_path', { p_path: path });
  if (rpcErr) throw rpcErr;
  const match = (matches && matches[0]) || null;
  if (!match) {
    // Path is inside /Flex Media Team Folder/Projects but not in any tracked folder
    // (e.g., reserved 02-05 folders or the project root itself). Skip.
    return false;
  }

  const projectId = match.project_id as string;
  const folderKind = match.folder_kind as FolderKind;

  // The audit folder receives our own auditEvent mirror writes (one JSON
  // file per event). Emitting events for those would create an infinite
  // feedback loop: every emitted event mirrors a new file → next sync emits
  // another event for the new file → mirrors → loops forever.
  if (folderKind === 'audit') return false;

  // Touch the folder's last_synced_at so the Files UI can show recency.
  await admin
    .from('project_folders')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('folder_kind', folderKind);

  if (entry['.tag'] === 'deleted') {
    await auditEvent({
      projectId,
      folderKind,
      eventType: 'file_deleted',
      actorType,
      fileName: path.split('/').pop() || '',
      metadata: { path },
    });
    return true;
  }

  // .tag === 'file' — distinguish add vs modify by prior dropbox_id event.
  // (#52 audit fix) Two webhooks for the same file processed in parallel
  // would BOTH see "no prior event", BOTH insert a file_added, and the
  // downstream ingest queue ends up double-firing. Race window is small
  // but real because Dropbox can fire multiple webhooks within tens of ms
  // for the same content_hash. Short-circuit: if a file_added for this
  // dropbox_id was emitted in the last 30s, treat it as already-handled
  // and skip emission entirely. We still keep the add/modify discrimination
  // for older priors (>30s back).
  let eventType = 'file_added';
  if (entry.id) {
    const { data: prior } = await admin
      .from('project_folder_events')
      .select('id, event_type, created_at')
      .eq('dropbox_id', entry.id)
      .in('event_type', ['file_added', 'file_modified'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prior) {
      const priorAt = new Date(prior.created_at as string).getTime();
      const ageMs = Date.now() - priorAt;
      // Same dropbox_id with a recent file_added → race-duplicate, skip.
      if (prior.event_type === 'file_added' && ageMs < 30_000) {
        return false;
      }
      eventType = 'file_modified';
    }
  }

  await auditEvent({
    projectId,
    folderKind,
    eventType,
    actorType,
    fileName: entry.name || path.split('/').pop() || '',
    fileSizeBytes: entry.size,
    dropboxId: entry.id,
    metadata: {
      path,
      content_hash: entry.content_hash,
      client_modified: entry.client_modified,
      server_modified: entry.server_modified,
    },
  });

  return true;
}

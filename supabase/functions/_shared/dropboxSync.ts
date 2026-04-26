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

  let cursor: string | null = (state?.cursor as string | null) ?? null;
  let entries: DropboxEntry[] = [];
  let isInitialSeed = false;

  if (!cursor) {
    isInitialSeed = true;
    const result = await listFolder(watchPath, { recursive: true, maxEntries: 50_000 });
    cursor = result.cursor;
    console.log(`[dropboxSync] initial seed for ${watchPath}: ${result.entries.length} entries`);
    // If the caller opted in (#55 fix), surface the seed entries to the
    // event-emission loop below so pre-existing JPGs in raw_drones folders
    // produce file_added events on first sync.
    if (opts?.forceEmitOnSeed) {
      entries = result.entries
        .filter((e) => e['.tag'] === 'file' && /\.(jpe?g)$/i.test(e.name || ''))
        // Match BOTH the legacy path (01_RAW_WORKING/drones/) and the new
        // post-restructure path (Drones/Raws/Shortlist Proposed/) so seeds
        // for backfilled projects also surface raw drone JPGs.
        .filter((e) =>
          /\/(01_RAW_WORKING\/drones|Drones\/Raws\/Shortlist Proposed)\//i.test(
            e.path_display || e.path_lower || '',
          ),
        );
      console.log(`[dropboxSync] forceEmitOnSeed: queuing ${entries.length} raw drone JPG(s) for emission`);
    }
  } else {
    let hasMore = true;
    let currentCursor: string = cursor;
    while (hasMore) {
      const next = await listFolderContinue(currentCursor);
      entries = entries.concat(next.entries as DropboxEntry[]);
      currentCursor = next.cursor;
      hasMore = next.has_more;
    }
    cursor = currentCursor;
  }

  let emitted = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Emit when this is a real delta OR when the caller asked for forced
  // emission on the initial seed. Default initial-seed branch still emits 0.
  const shouldEmit = !isInitialSeed || (opts?.forceEmitOnSeed === true);
  if (shouldEmit) {
    for (const entry of entries) {
      try {
        const handled = await processEntry(entry, actorType);
        if (handled) emitted++;
        else skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[dropboxSync] entry failed (${entry.path_lower}): ${msg}`);
        errors.push(`${entry.path_lower}: ${msg}`);
      }
    }
  }

  // Cursor advance policy: only persist the new cursor when ALL entries in
  // this batch processed cleanly. If any entry threw (DB outage, audit-event
  // insert failure, etc.) we keep the OLD cursor so the next webhook/reconcile
  // pass re-processes the failed entries. Without this, transient failures
  // silently lose file events forever. (#54 audit fix)
  const cursorToPersist = errors.length === 0 ? cursor : (state?.cursor as string | null) ?? cursor;
  const { error: updErr } = await admin
    .from('dropbox_sync_state')
    .update({
      cursor: cursorToPersist,
      last_run_at: new Date().toISOString(),
      last_changes_count: emitted,
      updated_at: new Date().toISOString(),
    })
    .eq('watch_path', watchPath);
  if (updErr) console.warn(`[dropboxSync] cursor update failed: ${updErr.message}`);
  if (errors.length > 0) {
    console.warn(`[dropboxSync] ${errors.length} entry error(s) — cursor held back so next sync retries`);
  }

  return {
    watchPath,
    actorType,
    isInitialSeed,
    totalEntries: entries.length,
    emitted,
    skipped,
    errors,
    cursor_set: cursor !== null,
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

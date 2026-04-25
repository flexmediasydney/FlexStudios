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

export async function processDropboxDelta(
  watchPath: string,
  actorType: 'webhook' | 'system',
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

  if (!isInitialSeed) {
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

  const { error: updErr } = await admin
    .from('dropbox_sync_state')
    .update({
      cursor,
      last_run_at: new Date().toISOString(),
      last_changes_count: emitted,
      updated_at: new Date().toISOString(),
    })
    .eq('watch_path', watchPath);
  if (updErr) console.warn(`[dropboxSync] cursor update failed: ${updErr.message}`);

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
  const path = entry.path_display || entry.path_lower;
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
  let eventType = 'file_added';
  if (entry.id) {
    const { data: prior } = await admin
      .from('project_folder_events')
      .select('id')
      .eq('dropbox_id', entry.id)
      .in('event_type', ['file_added', 'file_modified'])
      .limit(1)
      .maybeSingle();
    if (prior) eventType = 'file_modified';
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

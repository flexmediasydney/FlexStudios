/**
 * dropbox-webhook
 * ───────────────
 * Receives Dropbox file change notifications and emits project_folder_events
 * for files inside our managed `/FlexMedia/Projects/` tree.
 *
 * Dropbox webhook protocol:
 *   GET ?challenge=X  →  return X as text/plain (verification handshake on
 *                        registration; Dropbox re-runs this periodically)
 *   POST /            →  notification body { list_folder: { accounts: [...] } }
 *                        Dropbox just signals "something changed" — we then
 *                        call /files/list_folder/continue with our stored
 *                        cursor to fetch the actual diff.
 *
 * Auth: Dropbox webhooks don't carry JWT. Authenticity is enforced via
 * HMAC-SHA256 signature in the `X-Dropbox-Signature` header (the app secret
 * is the HMAC key). Function is deployed verify_jwt=false.
 *
 * Event emission:
 *   - .tag = 'file' + no prior dropbox_id event → 'file_added'
 *   - .tag = 'file' + prior dropbox_id event → 'file_modified'
 *   - .tag = 'deleted' → 'file_deleted'
 *   - .tag = 'folder' → skipped (we manage folders ourselves; user folder
 *                        edits inside our tree are noise for Phase 1)
 *
 * Move detection (delete-then-add for the same content_hash) is DEFERRED.
 * Phase 1 emits two separate events; the user can correlate visually.
 *
 * Performance: returns 200 within ~1s by deferring the actual diff +
 * processing to EdgeRuntime.waitUntil(). Dropbox times out at 10s.
 */

import {
  handleCors,
  errorResponse,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { listFolder, listFolderContinue } from '../_shared/dropbox.ts';
import { auditEvent, type FolderKind } from '../_shared/projectFolders.ts';

const GENERATOR = 'dropbox-webhook';
const WATCH_PATH = '/FlexMedia/Projects';

interface DropboxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
  content_hash?: string;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // ── Dropbox verification handshake ───────────────────────────────────────
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const challenge = url.searchParams.get('challenge') || '';
    return new Response(challenge, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, req);
  }

  // ── HMAC verification ────────────────────────────────────────────────────
  const bodyText = await req.text();
  const signature = req.headers.get('X-Dropbox-Signature') || '';
  const secret = Deno.env.get('DROPBOX_APP_SECRET') || '';

  if (!secret) {
    console.error(`[${GENERATOR}] DROPBOX_APP_SECRET not set`);
    return errorResponse('Webhook secret not configured', 500, req);
  }

  const expectedSig = await computeHmacSha256Hex(bodyText, secret);
  if (!constantTimeEquals(signature, expectedSig)) {
    console.warn(`[${GENERATOR}] signature mismatch (expected ${expectedSig.slice(0, 8)}.., got ${signature.slice(0, 8)}..)`);
    return errorResponse('Invalid signature', 401, req);
  }

  // ── Parse + defer processing ─────────────────────────────────────────────
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(bodyText); } catch { /* empty body is OK */ }

  const work = processNotification().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] processing failed: ${msg}`);
  });

  // Keep the isolate alive while async work runs (Dropbox needs <10s response).
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(work);

  return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
});

// ─── HMAC helpers ────────────────────────────────────────────────────────────

async function computeHmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ─── Notification processing ─────────────────────────────────────────────────

async function processNotification(): Promise<void> {
  const admin = getAdminClient();

  const { data: state, error: stateErr } = await admin
    .from('dropbox_sync_state')
    .select('cursor')
    .eq('watch_path', WATCH_PATH)
    .maybeSingle();
  if (stateErr) throw stateErr;

  let cursor: string | null = (state?.cursor as string | null) ?? null;
  let entries: DropboxEntry[] = [];
  let isInitialSeed = false;

  if (!cursor) {
    // First-ever run: list everything to seed the cursor. Don't emit events
    // for files that already exist — the backfill (PR4) is the source of
    // truth for what was in Dropbox at provisioning time.
    isInitialSeed = true;
    const result = await listFolder(WATCH_PATH, { recursive: true, maxEntries: 50_000 });
    cursor = result.cursor;
    console.log(`[${GENERATOR}] initial seed: ${result.entries.length} entries, cursor stored`);
  } else {
    // Pull all changes since last cursor.
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

  let processedCount = 0;
  if (!isInitialSeed) {
    for (const entry of entries) {
      try {
        const handled = await processEntry(entry);
        if (handled) processedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] entry failed (${entry.path_lower}): ${msg}`);
      }
    }
  }

  await admin
    .from('dropbox_sync_state')
    .update({
      cursor,
      last_run_at: new Date().toISOString(),
      last_changes_count: processedCount,
      updated_at: new Date().toISOString(),
    })
    .eq('watch_path', WATCH_PATH);

  console.log(`[${GENERATOR}] done — ${processedCount} events emitted from ${entries.length} entries`);
}

async function processEntry(entry: DropboxEntry): Promise<boolean> {
  const path = entry.path_display || entry.path_lower;
  if (!path) return false;

  // Skip folder events — we manage the folder skeleton ourselves; user folder
  // edits inside our tree are out of scope for Phase 1.
  if (entry['.tag'] === 'folder') return false;

  const admin = getAdminClient();

  const { data: matches, error: rpcErr } = await admin.rpc('find_project_folder_for_path', { p_path: path });
  if (rpcErr) throw rpcErr;
  const match = (matches && matches[0]) || null;
  if (!match) {
    // File is inside /FlexMedia/Projects but not in any tracked folder
    // (e.g., the project root itself, or a reserved 02-05 folder). Skip.
    return false;
  }

  const projectId = match.project_id as string;
  const folderKind = match.folder_kind as FolderKind;

  if (entry['.tag'] === 'deleted') {
    await auditEvent({
      projectId,
      folderKind,
      eventType: 'file_deleted',
      actorType: 'webhook',
      fileName: path.split('/').pop() || '',
      metadata: { path },
    });
    return true;
  }

  // .tag === 'file'
  // Distinguish add vs modify by checking if we've seen this dropbox id before.
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
    actorType: 'webhook',
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

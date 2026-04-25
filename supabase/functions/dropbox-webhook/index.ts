/**
 * dropbox-webhook
 * ───────────────
 * Receives Dropbox file change notifications and emits project_folder_events
 * for files inside our managed `/Flex Media Team Folder/Projects/` tree.
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
 * Delta processing logic lives in `_shared/dropboxSync.ts` and is shared
 * with `dropbox-reconcile` (nightly cron back-fill).
 *
 * Performance: returns 200 within ~1s by deferring the actual diff +
 * processing to EdgeRuntime.waitUntil(). Dropbox times out at 10s.
 */

import {
  handleCors,
  errorResponse,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { processDropboxDelta } from '../_shared/dropboxSync.ts';

const GENERATOR = 'dropbox-webhook';
const WATCH_PATH = '/Flex Media Team Folder/Projects';
// 2-min debounce so a 50-image bulk upload of a drone shoot collapses into
// a single ingest job rather than 50× back-to-back runs. See migration 228
// (uniq_drone_jobs_pending_ingest_per_project) for the constraint that
// enforces at-most-one pending ingest per project.
const INGEST_DEBOUNCE_SECONDS = 120;

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
    console.warn(`[${GENERATOR}] signature mismatch`);
    return errorResponse('Invalid signature', 401, req);
  }

  // ── Defer processing — Dropbox needs a fast response ────────────────────
  // forceEmitOnSeed: true so that if our cursor is null (first webhook ever
  // OR sync_state was reset) and there are pre-existing JPGs in raw_drones,
  // they still produce file_added events. Without this, files uploaded BEFORE
  // a project's webhook starts watching would never trigger ingest.
  // (#55 audit fix — B3 case.)
  //
  // QC8 D-10 fix: previously the post-delta helpers each used a fixed 60s
  // lookback. processDropboxDelta can take >60s on a large initial reconcile
  // (saw ~120s on a fresh project with thousands of pre-existing files), so
  // events emitted near the start of the delta would be older than 60s by the
  // time linkRecentEditorDrops / enqueueIngestForRecentRawDrones queried —
  // and they'd be silently missed. Capture the webhook start timestamp BEFORE
  // we kick off the delta and pass it through, so the helpers see "everything
  // since this webhook started" no matter how long the delta takes.
  const webhookStartIso = new Date().toISOString();
  const work = processDropboxDelta(WATCH_PATH, 'webhook', { forceEmitOnSeed: true })
    .then(async (r) => {
      console.log(`[${GENERATOR}] processed: emitted=${r.emitted} skipped=${r.skipped} errors=${r.errors.length}`);
      // After the delta lands, scan project_folder_events for raw_drones
      // file_added events emitted since this webhook started (was: last 60s)
      // and enqueue debounced ingest jobs per distinct project_id.
      try {
        const queued = await enqueueIngestForRecentRawDrones(webhookStartIso);
        if (queued > 0) {
          console.log(`[${GENERATOR}] enqueued ingest for ${queued} project(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] ingest enqueue failed: ${msg}`);
      }
      // Editor-folder watcher: link Edited Post Production drops to the
      // matching drone_shots row and (when all raw_accepted shots are
      // covered) enqueue a render job. Same start-timestamp window.
      try {
        const linked = await linkRecentEditorDrops(webhookStartIso);
        if (linked > 0) {
          console.log(`[${GENERATOR}] linked ${linked} editor file(s) to drone_shots`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] editor-link failed: ${msg}`);
      }
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] processing failed: ${msg}`);
    });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(work);

  return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
});

/**
 * Find any raw_drones file_added events emitted in the last 60 seconds
 * (covering this webhook run + a small buffer) and enqueue a debounced
 * `kind='ingest'` job per distinct project_id.
 *
 * Why a time-window query rather than threading the project_ids through
 * processDropboxDelta?
 *   - Keeps the delta processor unchanged (it's also called by reconcile,
 *     where the queue semantics are different).
 *   - Naturally idempotent under the unique partial index from migration 228:
 *     repeated calls within the same window upsert the same pending row.
 *
 * The webhook fires multiple times during a 50-file upload. Each call advances
 * the cursor by the new chunk and enqueues. Migration 228's unique partial
 * index collapses all those enqueues into a single pending row whose
 * `scheduled_for` is ratcheted forward by 2 minutes from the latest webhook
 * invocation — i.e. ingest fires once, ~2 minutes after the last file lands.
 */
async function enqueueIngestForRecentRawDrones(sinceIso: string): Promise<number> {
  const admin = getAdminClient();
  // Window: events created at or after the webhook started (was: last 60s).
  // QC8 D-10 — see top of handler for rationale.
  const since = sinceIso;
  const { data, error } = await admin
    .from('project_folder_events')
    .select('project_id')
    .in('folder_kind', ['drones_raws_shortlist_proposed', 'raw_drones'])
    .eq('event_type', 'file_added')
    .gte('created_at', since);
  if (error) throw error;

  const projectIds = Array.from(new Set((data || []).map((r) => r.project_id as string).filter(Boolean)));
  for (const pid of projectIds) {
    const { error: rpcErr } = await admin.rpc('enqueue_drone_ingest_job', {
      p_project_id: pid,
      p_debounce_seconds: INGEST_DEBOUNCE_SECONDS,
    });
    if (rpcErr) {
      console.warn(`[${GENERATOR}] enqueue_drone_ingest_job failed for ${pid}: ${rpcErr.message}`);
    }
  }
  return projectIds.length;
}

/**
 * Editor-folder watcher.
 *
 * After every webhook delta, scan project_folder_events for `file_added` /
 * `file_modified` rows in `drones_editors_edited_post_production` emitted in
 * the last 60 seconds and:
 *
 *   1. Look up the matching `drone_shots` row in the same project by exact
 *      filename (basename match). v1 only does exact match — _edited / (1)
 *      suffix stripping is out of scope.
 *   2. UPDATE drone_shots.edited_dropbox_path = '<full path>'.
 *   3. Insert `drone_events` row (event_type='editor_file_added').
 *   4. After the link, check whether ALL `lifecycle_state='raw_accepted'`
 *      shots in the shoot now have edited_dropbox_path. If yes, enqueue a
 *      `kind='render'` drone_jobs row (deduped via the partial unique index
 *      from migration 240).
 *
 * Returns count of linked files. Logs warnings (no throw) for files that
 * don't match a known shot — they may be a NEW shot the editor introduced
 * (out of scope for v1).
 */
async function linkRecentEditorDrops(sinceIso: string): Promise<number> {
  const admin = getAdminClient();
  // Window: events created at or after the webhook started (was: last 60s).
  // QC8 D-10 — see top of handler for rationale.
  const since = sinceIso;
  const { data: events, error } = await admin
    .from('project_folder_events')
    .select('project_id, file_name, metadata, event_type, created_at')
    .eq('folder_kind', 'drones_editors_edited_post_production')
    .in('event_type', ['file_added', 'file_modified'])
    .gte('created_at', since);
  if (error) throw error;
  if (!events || events.length === 0) return 0;

  let linkedCount = 0;
  // De-dup: a single file modified twice in the same window should only
  // produce one update + one drone_event. Key on (project_id, basename).
  const seen = new Set<string>();
  // Track which shoots got a link this pass so we only re-evaluate the
  // "all shots ready?" gate once per shoot.
  const touchedShoots = new Set<string>();

  for (const ev of events) {
    const projectId = ev.project_id as string | null;
    const fileName = ev.file_name as string | null;
    const metadata = (ev.metadata || {}) as Record<string, unknown>;
    const fullPath = (metadata.path as string | undefined) || null;
    if (!projectId || !fileName || !fullPath) continue;

    // Skip non-image entries that may have crept in (e.g. .DS_Store).
    if (!/\.(jpe?g|png|tiff?)$/i.test(fileName)) continue;

    const dedupKey = `${projectId}|${fileName.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Look up the matching raw shot via shoot.project_id JOIN. v1 = exact
    // match on filename. We need shot_id + shoot_id for the audit row +
    // downstream render-gate check.
    const { data: candidates, error: shotErr } = await admin
      .from('drone_shots')
      .select('id, filename, shoot_id, drone_shoots!inner(project_id)')
      .eq('drone_shoots.project_id', projectId)
      .eq('filename', fileName);
    if (shotErr) {
      console.warn(`[${GENERATOR}] editor-link shot lookup failed for ${fileName}: ${shotErr.message}`);
      continue;
    }
    if (!candidates || candidates.length === 0) {
      console.warn(`[${GENERATOR}] editor file '${fileName}' (project ${projectId}) has no matching raw shot — likely a new shot introduced by editor (out of scope for v1).`);
      continue;
    }
    if (candidates.length > 1) {
      console.warn(`[${GENERATOR}] editor file '${fileName}' (project ${projectId}) matched ${candidates.length} shots — using first.`);
    }
    const shot = candidates[0] as { id: string; shoot_id: string };

    // Update the raw shot's edited_dropbox_path. Idempotent — if the value
    // is already set to fullPath this is a no-op write.
    const { error: updErr } = await admin
      .from('drone_shots')
      .update({ edited_dropbox_path: fullPath })
      .eq('id', shot.id);
    if (updErr) {
      console.warn(`[${GENERATOR}] edited_dropbox_path update failed for shot ${shot.id}: ${updErr.message}`);
      continue;
    }

    await admin.from('drone_events').insert({
      project_id: projectId,
      shoot_id: shot.shoot_id,
      shot_id: shot.id,
      event_type: 'editor_file_added',
      actor_type: 'system',
      actor_id: null,
      payload: {
        shot_id: shot.id,
        raw_filename: fileName,
        edited_path: fullPath,
      },
    });

    linkedCount++;
    touchedShoots.add(shot.shoot_id);
  }

  // ── Per-shoot render-readiness gate ─────────────────────────────────
  // For each shoot we touched, count raw_accepted shots that still have NO
  // edited_dropbox_path. If zero → all editor work is in → enqueue render.
  // Use the partial unique index from migration 240 to dedupe.
  for (const shootId of touchedShoots) {
    try {
      const { count: missing, error: cntErr } = await admin
        .from('drone_shots')
        .select('id', { count: 'exact', head: true })
        .eq('shoot_id', shootId)
        .eq('lifecycle_state', 'raw_accepted')
        .is('edited_dropbox_path', null);
      if (cntErr) {
        console.warn(`[${GENERATOR}] render-gate count failed for shoot ${shootId}: ${cntErr.message}`);
        continue;
      }
      if ((missing || 0) > 0) continue;

      // Need project_id for the drone_jobs row.
      const { data: shootRow } = await admin
        .from('drone_shoots')
        .select('id, project_id')
        .eq('id', shootId)
        .maybeSingle();
      if (!shootRow?.project_id) continue;

      // Insert a render job. The partial unique index
      // idx_drone_jobs_unique_pending_render (migration 240) covers
      // (shoot_id) WHERE status IN (pending,running) AND kind='render'; a
      // duplicate insert raises 23505 which we treat as a successful debounce
      // (same pattern as drone-pins-save).
      const { error: jobErr } = await admin
        .from('drone_jobs')
        .insert({
          project_id: shootRow.project_id,
          shoot_id: shootId,
          kind: 'render',
          status: 'pending',
          payload: {
            shoot_id: shootId,
            kind: 'poi_plus_boundary',
            reason: 'edited_files_complete',
          },
        });
      if (jobErr) {
        const code = (jobErr as { code?: string }).code;
        if (code === '23505') {
          console.info(`[${GENERATOR}] render job debounced for shoot ${shootId} (existing pending/running)`);
        } else {
          console.warn(`[${GENERATOR}] render enqueue failed for shoot ${shootId}: ${jobErr.message}`);
        }
        continue;
      }
      console.log(`[${GENERATOR}] all editor files complete for shoot ${shootId} — render enqueued`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] render-gate failed for shoot ${shootId}: ${msg}`);
    }
  }

  return linkedCount;
}

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

/**
 * Constant-time string comparison.
 *
 * (#53 audit fix) The previous version returned false early on length
 * mismatch, which leaks the length of `b` (the secret-derived expected
 * signature) via timing. For Dropbox HMAC-SHA256 signatures both inputs are
 * always 64 hex chars so the leak is theoretical, but the attack surface is
 * trivial to close: pad both inputs to the longer length with a sentinel char
 * (NUL) and iterate the full length, XORing every byte. The mismatch in
 * length is then implicitly captured by the XOR (the sentinel won't match
 * the real char) without short-circuiting.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    result |= ca ^ cb;
  }
  return result === 0;
}

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
const WATCH_PATH = '/FlexMedia/Projects';
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
  const work = processDropboxDelta(WATCH_PATH, 'webhook')
    .then(async (r) => {
      console.log(`[${GENERATOR}] processed: emitted=${r.emitted} skipped=${r.skipped} errors=${r.errors.length}`);
      // After the delta lands, scan project_folder_events for any raw_drones
      // file_added events emitted in the last 60 seconds (this run + buffer)
      // and enqueue debounced ingest jobs per distinct project_id.
      try {
        const queued = await enqueueIngestForRecentRawDrones();
        if (queued > 0) {
          console.log(`[${GENERATOR}] enqueued ingest for ${queued} project(s)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] ingest enqueue failed: ${msg}`);
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
async function enqueueIngestForRecentRawDrones(): Promise<number> {
  const admin = getAdminClient();
  const since = new Date(Date.now() - 60_000).toISOString();
  const { data, error } = await admin
    .from('project_folder_events')
    .select('project_id')
    .eq('folder_kind', 'raw_drones')
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

/**
 * dropbox-reconcile
 * ─────────────────
 * Nightly back-fill for Dropbox file events that the webhook may have missed
 * (network blip, function 500, Dropbox webhook drop, etc).
 *
 * Calls the same `processDropboxDelta` as the webhook but with
 * `actor_type='system'` so the activity log differentiates real-time webhook
 * events from cron back-fills.
 *
 * Idempotent: Dropbox's cursor advances monotonically. A nightly run after a
 * normally-functioning webhook day will see an empty delta (cursor already
 * past everything) and emit zero events.
 *
 * Schedule: pg_cron at 02:30 UTC nightly (12:30 AEST). See migration 224.
 *
 * Auth: __service_role__ (cron) OR master_admin/admin (manual re-sync from
 * Files UI in PR7). Deployed verify_jwt=false; we do our own check.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { processDropboxDelta } from '../_shared/dropboxSync.ts';

const GENERATOR = 'dropbox-reconcile';
const WATCH_PATH = '/FlexMedia/Projects';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  try {
    const startedAt = Date.now();
    const result = await processDropboxDelta(WATCH_PATH, 'system');
    return jsonResponse({
      success: true,
      ...result,
      elapsed_ms: Date.now() - startedAt,
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed: ${msg}`);
    return errorResponse(`Reconcile failed: ${msg}`, 500, req);
  }
});

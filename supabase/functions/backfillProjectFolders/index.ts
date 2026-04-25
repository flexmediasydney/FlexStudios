/**
 * backfillProjectFolders
 * ──────────────────────
 * One-shot helper for the Phase 1 PR4 backfill: provisions Dropbox folders
 * for projects that don't yet have a `dropbox_root_path`.
 *
 * Processes projects SEQUENTIALLY in a single Edge Function isolate, which
 * keeps Dropbox API calls naturally rate-limited (~14 calls per project at
 * ~200ms each = ~3-5s/project, well under Dropbox burst limits). The
 * alternative — firing pg_net.http_post for all pending projects in
 * parallel — caused 429s.
 *
 * Auth: master_admin / admin only (manual operator action).
 *
 * Body:
 *   { batch_size?: number = 10, max_runtime_ms?: number = 90000 }
 *
 * Response:
 *   { processed: number, errors: { project_id, error }[], remaining: number }
 *
 * Re-invoke until `remaining: 0`.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { createProjectFolders } from '../_shared/projectFolders.ts';

const GENERATOR = 'backfillProjectFolders';
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_RUNTIME_MS = 90_000;

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed. Use POST.', 405, req);
  }

  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required.', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden: master_admin/admin only.', 403, req);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const batchSize = typeof body.batch_size === 'number' ? body.batch_size : DEFAULT_BATCH_SIZE;
  const maxRuntimeMs = typeof body.max_runtime_ms === 'number' ? body.max_runtime_ms : DEFAULT_MAX_RUNTIME_MS;

  const admin = getAdminClient();
  const startedAt = Date.now();
  const errors: Array<{ project_id: string; error: string }> = [];
  let processed = 0;

  // Pull a candidate batch; we'll process sequentially and stop early on time.
  const { data: candidates, error: candErr } = await admin
    .from('projects')
    .select('id, property_address')
    .is('dropbox_root_path', null)
    .order('created_at', { ascending: true })
    .limit(batchSize);
  if (candErr) return errorResponse(`Candidate fetch failed: ${candErr.message}`, 500, req);

  for (const proj of candidates || []) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      console.log(`[${GENERATOR}] hit max_runtime_ms after ${processed} projects`);
      break;
    }
    try {
      await createProjectFolders(proj.id, proj.property_address || null, { actorType: 'system' });
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] project ${proj.id} failed: ${msg}`);
      errors.push({ project_id: proj.id, error: msg });
    }
  }

  // How many still need provisioning?
  const { count: remaining } = await admin
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .is('dropbox_root_path', null);

  return jsonResponse({
    processed,
    errors,
    remaining: remaining ?? 0,
    elapsed_ms: Date.now() - startedAt,
  }, 200, req);
});

/**
 * provisionProjectFolders
 * ───────────────────────
 * Wraps `createProjectFolders` from `_shared/projectFolders.ts` as an Edge
 * Function so the AFTER INSERT trigger on `projects` (migration 222) and the
 * one-shot backfill can both call it via pg_net.
 *
 * Idempotent — safe to retry. Each call provisions all 9 managed folders for
 * one project (and inserts project_folders rows + audits the action).
 *
 * Auth (verify_jwt=false; we do our own check):
 *   - service_role (trigger / pg_net + vault) — primary path
 *   - master_admin / admin (manual backfill from a future Files UI button)
 *
 * Body:
 *   { project_id: string, address?: string | null, _health_check?: boolean }
 *
 * Response:
 *   200 { success: true, project_id, root_path, folder_count }
 *   400 { error: 'project_id required' }
 *   401/403 { error: 'unauthorized'/'forbidden' }
 *   500 { error: 'provisioning failed: <msg>' } — caller should retry
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { createProjectFolders } from '../_shared/projectFolders.ts';

const GENERATOR = 'provisionProjectFolders';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed. Use POST.', 405, req);
  }

  // Auth gate: service_role (trigger/cron) OR master_admin/admin (manual).
  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required.', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden: master_admin/admin only.', 403, req);
    }
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = typeof body.project_id === 'string' ? body.project_id : null;
  if (!projectId) return errorResponse('project_id required', 400, req);

  const address = typeof body.address === 'string' ? body.address : null;

  try {
    const result = await createProjectFolders(projectId, address, {
      actorType: isServiceRole ? 'system' : 'user',
      actorId: isServiceRole ? undefined : user?.id,
    });
    return jsonResponse({
      success: true,
      project_id: projectId,
      root_path: result.rootPath,
      folder_count: result.folders.length,
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for ${projectId}: ${msg}`);
    return errorResponse(`Provisioning failed: ${msg}`, 500, req);
  }
});

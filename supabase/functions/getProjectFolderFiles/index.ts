/**
 * getProjectFolderFiles
 * ─────────────────────
 * POST { project_id, folder_kind } → { success, files: FileEntry[] }
 *
 * Wraps `_shared/projectFolders.ts::listFiles()` for the Files tab UI.
 * Returns the current Dropbox state of one folder for one project.
 *
 * Auth:
 *   - Authenticated user
 *   - master_admin / admin: any project
 *   - Other roles: project must be visible via existing `projects` RLS
 *     (we issue a SELECT against projects with the user's JWT to check)
 *
 * Deployed verify_jwt=false; we do our own auth via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getUserClient,
} from '../_shared/supabase.ts';
import { listFiles, ALL_FOLDER_KINDS, type FolderKind } from '../_shared/projectFolders.ts';

const GENERATOR = 'getProjectFolderFiles';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);

  let body: { project_id?: string; folder_kind?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  if (!body.project_id) return errorResponse('project_id required', 400, req);
  if (!body.folder_kind || !ALL_FOLDER_KINDS.includes(body.folder_kind as FolderKind)) {
    return errorResponse(
      `Invalid folder_kind — must be one of: ${ALL_FOLDER_KINDS.join(', ')}`,
      400,
      req,
    );
  }

  // Authz: master_admin/admin always; others must have RLS visibility of the project
  if (!['master_admin', 'admin'].includes(user.role || '')) {
    const userClient = getUserClient(req);
    const { data: visibleProject, error: rlsErr } = await userClient
      .from('projects')
      .select('id')
      .eq('id', body.project_id)
      .maybeSingle();

    if (rlsErr) {
      console.error(`[${GENERATOR}] RLS check failed:`, rlsErr);
      return errorResponse('Project access check failed', 500, req);
    }
    if (!visibleProject) return errorResponse('Forbidden — project not visible', 403, req);
  }

  try {
    const files = await listFiles(body.project_id, body.folder_kind as FolderKind);
    return jsonResponse({ success: true, files }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // (W6-T2) Distinguish "folder kind not provisioned for this project" from
    // generic Dropbox/upstream errors. mig 247/291 dropped the legacy drone
    // folder kinds; FE clients that still list them (e.g. ProjectFilesTab.jsx
    // ALL_FOLDER_KINDS — see W6-T2 ticket) hit getFolderPath's "No folder of
    // kind 'X' for project Y" throw. Surfacing 404 + the kind lets the FE
    // gracefully render "folder not provisioned" instead of a generic error
    // banner, and stops the call counting as a server error in metrics.
    if (/^No folder of kind /.test(msg)) {
      console.warn(`[${GENERATOR}] folder kind not provisioned: ${msg}`);
      return errorResponse(
        `Folder kind '${body.folder_kind}' is not provisioned for this project`,
        404,
        req,
      );
    }
    console.error(`[${GENERATOR}] listFiles failed:`, msg);
    return errorResponse(`Failed to list files: ${msg}`, 500, req);
  }
});

/**
 * setProjectFolderOverride
 * ────────────────────────
 * POST { project_id, folder_kind, new_path } → { success }
 *
 * Wraps `_shared/projectFolders.ts::overrideFolderPath()`. Allows a
 * master_admin to point a project's `folder_kind` at a different Dropbox
 * path. Existing files at the OLD path are NOT moved — this is a
 * pointer change. Use case: relocating a project's working folder when
 * something has been manually re-organised in Dropbox.
 *
 * Audit: overrideFolderPath() emits an `override_applied` event with the
 * actor_id supplied here.
 *
 * Auth: master_admin only.
 *
 * Deployed verify_jwt=false; auth verified via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { overrideFolderPath, ALL_FOLDER_KINDS, type FolderKind } from '../_shared/projectFolders.ts';

const GENERATOR = 'setProjectFolderOverride';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);
  if (user.role !== 'master_admin') {
    return errorResponse('Forbidden — master_admin role required', 403, req);
  }

  let body: {
    project_id?: string;
    folder_kind?: string;
    new_path?: string;
    _health_check?: boolean;
  } = {};
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
  if (!body.new_path || typeof body.new_path !== 'string') {
    return errorResponse('new_path required (string)', 400, req);
  }
  if (!body.new_path.startsWith('/')) {
    return errorResponse('new_path must be an absolute Dropbox path (must start with /)', 400, req);
  }
  if (body.new_path.length > 500) {
    return errorResponse('new_path too long (max 500 chars)', 400, req);
  }

  try {
    await overrideFolderPath(
      body.project_id,
      body.folder_kind as FolderKind,
      body.new_path,
      user.id,
    );
    return jsonResponse(
      {
        success: true,
        project_id: body.project_id,
        folder_kind: body.folder_kind,
        new_path: body.new_path,
      },
      200,
      req,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] override failed:`, msg);
    return errorResponse(`Override failed: ${msg}`, 500, req);
  }
});

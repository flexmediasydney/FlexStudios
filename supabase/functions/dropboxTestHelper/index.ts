/**
 * dropboxTestHelper
 * ─────────────────
 * Admin-only helper for end-to-end webhook testing. Uploads a test file to a
 * project folder using the same Dropbox account (via DROPBOX_REFRESH_TOKEN)
 * that the webhook listens on, so subsequent /list_folder/continue actually
 * sees the change.
 *
 * Used by:
 *   - PR5 manual smoke test (this conversation)
 *   - PR8 end-to-end acceptance smoke test
 *
 * Body:
 *   { project_id: string, folder_kind?: FolderKind = 'raw_drones',
 *     filename?: string = '_smoketest_<ts>.txt',
 *     content?: string = 'smoke test <ts>' }
 *
 * Auth: master_admin / admin only.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { writeFile, type FolderKind, ALL_FOLDER_KINDS } from '../_shared/projectFolders.ts';

const GENERATOR = 'dropboxTestHelper';

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

  const projectId = typeof body.project_id === 'string' ? body.project_id : null;
  if (!projectId) return errorResponse('project_id required', 400, req);

  const folderKind = (typeof body.folder_kind === 'string' ? body.folder_kind : 'raw_drones') as FolderKind;
  if (!ALL_FOLDER_KINDS.includes(folderKind)) {
    return errorResponse(`Invalid folder_kind. Must be one of: ${ALL_FOLDER_KINDS.join(', ')}`, 400, req);
  }

  const ts = Date.now();
  const filename = (typeof body.filename === 'string' ? body.filename : `_smoketest_${ts}.txt`);
  const content = (typeof body.content === 'string' ? body.content : `smoke test ${new Date(ts).toISOString()}`);

  try {
    const meta = await writeFile(projectId, folderKind, filename, content);
    return jsonResponse({
      success: true,
      uploaded: {
        project_id: projectId,
        folder_kind: folderKind,
        filename,
        path: meta.path_display,
        id: meta.id,
        size: meta.size,
      },
    }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`Upload failed: ${msg}`, 500, req);
  }
});

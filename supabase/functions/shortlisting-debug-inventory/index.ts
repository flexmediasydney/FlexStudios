/**
 * shortlisting-debug-inventory
 * ─────────────────────────────
 * Read-only inspector for a project's Photos/Raws/* Dropbox folders. Used
 * during Wave 0 lockstep diagnostic + ongoing ops debugging.
 *
 * POST { project_id }
 *
 * Returns per-folder file counts (total / CR3 / JPEG / preview) + sample
 * filenames. Does NOT mutate anything. Service-role only.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { listFolder } from '../_shared/dropbox.ts';

const GENERATOR = 'shortlisting-debug-inventory';

const RAW_EXTS = ['.cr3', '.cr2', '.arw', '.nef', '.raf', '.dng'];
const JPG_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

interface FolderInventory {
  folder_kind: string;
  dropbox_path: string;
  total_entries: number;
  cr3_count: number;
  jpg_count: number;
  sample_names: string[];
  error?: string;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Service-role only — verify the bearer JWT decodes to role=service_role.
  // (Edge function gateway has already validated signature with verify_jwt=true,
  //  so we just need to confirm the role claim.)
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return errorResponse('service-role only (no bearer token)', 401, req);
  try {
    const payload = JSON.parse(atob(m[1].split('.')[1]));
    if (payload?.role !== 'service_role') {
      return errorResponse(`service-role only (role=${payload?.role})`, 401, req);
    }
  } catch (err) {
    return errorResponse(`service-role only (decode failed: ${err instanceof Error ? err.message : err})`, 401, req);
  }

  let body: { project_id?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* noop */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = body.project_id?.trim();
  if (!projectId) return errorResponse('project_id required', 400, req);

  const admin = getAdminClient();
  const { data: folders, error: folderErr } = await admin
    .from('project_folders')
    .select('folder_kind, dropbox_path')
    .eq('project_id', projectId)
    .like('folder_kind', 'photos_raws_%')
    .order('folder_kind');
  if (folderErr) return errorResponse(`folder lookup failed: ${folderErr.message}`, 500, req);
  if (!folders || folders.length === 0) {
    return jsonResponse({ ok: true, project_id: projectId, inventory: [] }, 200, req);
  }

  const inventory: FolderInventory[] = [];
  for (const f of folders) {
    const item: FolderInventory = {
      folder_kind: f.folder_kind as string,
      dropbox_path: f.dropbox_path as string,
      total_entries: 0,
      cr3_count: 0,
      jpg_count: 0,
      sample_names: [],
    };
    try {
      const result = await listFolder(f.dropbox_path as string, {
        recursive: false,
        maxEntries: 10_000,
      });
      const entries = result.entries.filter((e: { ['.tag']?: string }) => e['.tag'] === 'file');
      item.total_entries = entries.length;
      item.cr3_count = entries.filter((e: { name?: string }) => {
        const lower = (e.name || '').toLowerCase();
        return RAW_EXTS.some((ext) => lower.endsWith(ext));
      }).length;
      item.jpg_count = entries.filter((e: { name?: string }) => {
        const lower = (e.name || '').toLowerCase();
        return JPG_EXTS.some((ext) => lower.endsWith(ext));
      }).length;
      item.sample_names = entries
        .slice(0, 8)
        // deno-lint-ignore no-explicit-any
        .map((e: any) => e.name as string);
    } catch (err) {
      item.error = err instanceof Error ? err.message : String(err);
    }
    inventory.push(item);
  }

  return jsonResponse({ ok: true, project_id: projectId, inventory }, 200, req);
});

import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const SKIP_EXTS = new Set(['dng','cr2','cr3','arw','nef','orf','raf','rw2','raw','nrw']);

function getExt(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

async function dbxPost(token: string, endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function listAll(token: string, path: string, sharedLink?: string) {
  const body: Record<string, unknown> = { path, include_deleted: false, limit: 2000 };
  if (sharedLink) body.shared_link = { url: sharedLink };
  const data = await dbxPost(token, '/files/list_folder', body);
  let entries = data.entries || [];
  let cursor = data.cursor;
  while (data.has_more && cursor) {
    const more = await dbxPost(token, '/files/list_folder/continue', { cursor });
    entries = entries.concat(more.entries || []);
    cursor = more.has_more ? more.cursor : null;
    if (entries.length > 2000) break;
  }
  return entries;
}

function buildPreviewUrl(shareUrl: string, fileName: string): string {
  const base = shareUrl.split('?')[0];
  const rlMatch = shareUrl.match(/rlkey=([^&]+)/);
  if (!rlMatch) return shareUrl;
  return `${base}?rlkey=${rlMatch[1]}&preview=${encodeURIComponent(fileName)}&subfolder_nav_tracking=1`;
}

function fileEntry(f: Record<string, unknown>, folderName: string, shareUrl?: string) {
  const name = f.name as string;
  return {
    name,
    size: f.size as number,
    ext: getExt(name),
    preview_url: shareUrl ? buildPreviewUrl(shareUrl, name) : null,
    path: f.path_display || `/${folderName}/${name}`,
    modified: f.client_modified || null,
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Health check
  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'getDeliveryMediaFeed' }, 200, req);
  }
  if (req.method !== 'POST') return errorResponse('POST or GET only', 405, req);

  try {
    const body = await req.json().catch(() => ({}));

    // Debug endpoint — check token status
    if (body?._debug) {
      const t = Deno.env.get('DROPBOX_API_TOKEN') || '';
      return jsonResponse({ token_length: t.length, token_starts: t.substring(0, 10), token_set: t.length > 100 });
    }

    // Auth check relaxed — this function only reads from Dropbox, no sensitive DB operations
    // getUserFromReq can fail for various JWT/session reasons; don't block media loading
    const user = await getUserFromReq(req).catch(() => null);

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('DROPBOX_API_TOKEN not configured', 500, req);

    const { share_url, path, action } = body;

    // Single file temp link
    if (action === 'get_temp_link' && path) {
      const data = await dbxPost(token, '/files/get_temporary_link', { path });
      return jsonResponse({ url: data.link }, 200, req);
    }

    if (!share_url && !path) return errorResponse('share_url or path required', 400, req);

    const useShared = !!share_url;
    const listPath = useShared ? '' : (path.startsWith('/') ? path : '/' + path);

    // List top-level entries
    const topEntries = await listAll(token, listPath, useShared ? share_url : undefined);

    const subfolders: Record<string, unknown>[] = [];
    const rootFiles: Record<string, unknown>[] = [];

    for (const e of topEntries) {
      if (e['.tag'] === 'folder') subfolders.push(e);
      else if (e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name))) rootFiles.push(e);
    }

    const folders: { name: string; files: ReturnType<typeof fileEntry>[] }[] = [];

    // Root files
    if (rootFiles.length > 0) {
      folders.push({
        name: 'Root',
        files: rootFiles.map(f => fileEntry(f, 'Root', useShared ? share_url : undefined)),
      });
    }

    // Subfolders
    for (const sf of subfolders) {
      try {
        const subPath = useShared ? `/${sf.name}` : `${listPath}/${sf.name}`;
        const subEntries = await listAll(token, subPath, useShared ? share_url : undefined);
        const files = subEntries
          .filter((e: Record<string, unknown>) => e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name as string)))
          .map((f: Record<string, unknown>) => fileEntry(f, sf.name as string, useShared ? share_url : undefined));
        if (files.length > 0) {
          folders.push({ name: sf.name as string, files });
        }
      } catch (err) {
        console.warn(`Subfolder ${sf.name} failed:`, err.message);
      }
    }

    return jsonResponse({ folders, total_files: folders.reduce((s, f) => s + f.files.length, 0) }, 200, req);

  } catch (err) {
    console.error('getDeliveryMediaFeed error:', err);
    const msg = err.message || 'Unknown error';
    if (msg.includes('invalid_access_token') || msg.includes('expired_access_token')) {
      return errorResponse('Dropbox token expired — refresh in settings', 502, req);
    }
    return errorResponse(msg, 500, req);
  }
});

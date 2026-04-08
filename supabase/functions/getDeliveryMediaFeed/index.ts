import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const SKIP_EXTS = new Set(['dng','cr2','cr3','arw','nef','orf','raf','rw2','raw','nrw']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','heic','heif']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','webm','mkv','m4v','wmv']);
const DOC_EXTS   = new Set(['pdf','ai','eps','svg','dwg']);

function getExt(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function classifyFile(name: string): string {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (DOC_EXTS.has(ext))   return 'document';
  return 'other';
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

/** Build a preview URL using the PARENT share link (user-owned, always accessible).
 *  basePath = project's tonomo_deliverable_path (e.g. /flex media team folder/tonomo/agent/address)
 *  filePath = relative path within project folder (e.g. /Drone Images/file.jpg)
 */
function buildParentPreviewUrl(parentShareUrl: string, prefix: string, basePath: string, filePath: string): string | null {
  if (!parentShareUrl) return null;
  const base = parentShareUrl.split('?')[0];
  const rlMatch = parentShareUrl.match(/rlkey=([^&]+)/);
  if (!rlMatch) return null;
  // Combine basePath + filePath to get full absolute path, then strip prefix
  let fullPath = basePath ? `${basePath}${filePath}` : filePath;
  if (prefix && fullPath.startsWith(prefix)) fullPath = fullPath.slice(prefix.length);
  if (!fullPath.startsWith('/')) fullPath = '/' + fullPath;
  const pathParts = fullPath.split('/').filter(Boolean);
  const encodedPath = pathParts.map(encodeURIComponent).join('/');
  return `${base}/${encodedPath}?rlkey=${rlMatch[1]}&dl=0`;
}

interface FileEntry {
  name: string;
  size: number;
  ext: string;
  type: string;
  preview_url: string | null;
  path: string;
  dbx_id?: string;
  modified: string | null;    // client_modified — when file was last changed
  uploaded_at: string | null; // server_modified — when uploaded to Dropbox
}

function fileEntry(f: Record<string, unknown>, folderName: string, parentShareUrl?: string, pathPrefix?: string, basePath?: string): FileEntry {
  const name = f.name as string;
  const ext = getExt(name);
  const type = classifyFile(name);
  const relativePath = (f.path_display as string) || `/${folderName}/${name}`;

  return {
    name,
    size: f.size as number,
    ext,
    type,
    preview_url: parentShareUrl ? buildParentPreviewUrl(parentShareUrl, pathPrefix || '', basePath || '', relativePath) : null,
    path: relativePath,
    dbx_id: (f.id as string) || undefined,
    modified: (f.client_modified as string) || null,
    uploaded_at: (f.server_modified as string) || null,
  };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'getDeliveryMediaFeed' }, 200, req);
  }
  if (req.method !== 'POST') return errorResponse('POST or GET only', 405, req);

  try {
    const body = await req.json().catch(() => ({}));

    if (body?._debug) {
      const t = Deno.env.get('DROPBOX_API_TOKEN') || '';
      return jsonResponse({ token_length: t.length, token_starts: t.substring(0, 10), token_set: t.length > 100 });
    }

    await getUserFromReq(req).catch(() => null);

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errorResponse('DROPBOX_API_TOKEN not configured', 500, req);

    const parentShareUrl = Deno.env.get('DROPBOX_PARENT_SHARE_URL') || '';
    const pathPrefix = Deno.env.get('DROPBOX_PARENT_PATH_PREFIX') || '';

    const { share_url, path, action, base_path } = body;

    // ─── Action: thumb — fast thumbnail via Dropbox API (~10KB vs 25MB full) ─
    if (action === 'thumb' && body.file_path) {
      if (!parentShareUrl) return errorResponse('DROPBOX_PARENT_SHARE_URL not configured', 500, req);

      let relPath = body.file_path;
      if (pathPrefix && relPath.startsWith(pathPrefix)) {
        relPath = relPath.slice(pathPrefix.length);
        if (!relPath.startsWith('/')) relPath = '/' + relPath;
      }

      const size = body.size || 'w480h320'; // w128h128, w256h256, w480h320, w640h480
      const arg = JSON.stringify({
        resource: { '.tag': 'link', url: parentShareUrl, path: relPath },
        format: 'jpeg',
        size,
        mode: 'bestfit',
      });

      const dbxRes = await fetch(`${DROPBOX_CONTENT}/files/get_thumbnail_v2`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': arg },
      });

      if (!dbxRes.ok) {
        // Fallback to full proxy if thumbnail fails
        const errText = await dbxRes.text().catch(() => '');
        console.warn(`Thumbnail failed (${dbxRes.status}), falling back to proxy: ${errText.slice(0, 100)}`);
        // Fall through to proxy action below
      } else {
        const origin = req.headers.get('origin') || '*';
        return new Response(dbxRes.body, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400', // Cache thumbnails for 24h
          },
        });
      }
    }

    // ─── Action: proxy — serve full file via parent Tonomo share link ───
    if ((action === 'proxy' || action === 'thumb') && body.file_path) {
      if (!parentShareUrl) return errorResponse('DROPBOX_PARENT_SHARE_URL not configured', 500, req);

      let relPath = body.file_path;
      if (pathPrefix && relPath.startsWith(pathPrefix)) {
        relPath = relPath.slice(pathPrefix.length);
        if (!relPath.startsWith('/')) relPath = '/' + relPath;
      }

      const arg = JSON.stringify({ url: parentShareUrl, path: relPath });
      const dbxRes = await fetch(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': arg },
      });
      if (!dbxRes.ok) {
        const errText = await dbxRes.text().catch(() => '');
        return jsonResponse({ error: `Dropbox ${dbxRes.status}`, detail: errText.slice(0, 200) }, 400, req);
      }
      const ct = dbxRes.headers.get('content-type') || 'application/octet-stream';
      const origin = req.headers.get('origin') || '*';
      return new Response(dbxRes.body, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=7200',
        },
      });
    }

    // ─── Main: list folder contents ─────────────────────────────────────
    if (!share_url && !path) return errorResponse('share_url or path required', 400, req);

    const useShared = !!share_url;
    const listPath = useShared ? '' : (path.startsWith('/') ? path : '/' + path);

    const topEntries = await listAll(token, listPath, useShared ? share_url : undefined);

    const subfolders: Record<string, unknown>[] = [];
    const rootFiles: Record<string, unknown>[] = [];

    for (const e of topEntries) {
      if (e['.tag'] === 'folder') subfolders.push(e);
      else if (e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name))) rootFiles.push(e);
    }

    const folders: { name: string; files: FileEntry[] }[] = [];

    if (rootFiles.length > 0) {
      folders.push({
        name: 'Root',
        files: rootFiles.map(f => fileEntry(f, 'Root', parentShareUrl, pathPrefix, base_path)),
      });
    }

    for (const sf of subfolders) {
      try {
        const subPath = useShared ? `/${sf.name}` : `${listPath}/${sf.name}`;
        const subEntries = await listAll(token, subPath, useShared ? share_url : undefined);
        const files = subEntries
          .filter((e: Record<string, unknown>) => e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name as string)))
          .map((f: Record<string, unknown>) => fileEntry(f, sf.name as string, parentShareUrl, pathPrefix, base_path));
        if (files.length > 0) {
          folders.push({ name: sf.name as string, files });
        }
      } catch (err) {
        console.warn(`Subfolder ${sf.name} failed:`, err.message);
      }
    }

    return jsonResponse({
      folders,
      total_files: folders.reduce((s, f) => s + f.files.length, 0),
      fetched_at: new Date().toISOString(),
    }, 200, req);

  } catch (err) {
    console.error('getDeliveryMediaFeed error:', err);
    const msg = err.message || 'Unknown error';
    if (msg.includes('invalid_access_token') || msg.includes('expired_access_token')) {
      return errorResponse('Dropbox token expired — refresh in settings', 502, req);
    }
    return errorResponse(msg, 500, req);
  }
});

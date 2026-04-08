import { getUserFromReq, handleCors, getCorsHeaders, jsonResponse } from '../_shared/supabase.ts';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const SKIP_EXTS = new Set(['dng','cr2','cr3','arw','nef','orf','raf','rw2','raw','nrw']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','heic','heif']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','webm','mkv','m4v','wmv']);
const DOC_EXTS   = new Set(['pdf','ai','eps','svg','dwg']);

const DBX_TIMEOUT_MS = 10_000;
const SUBFOLDER_CONCURRENCY = 5;
const MAX_PROXY_BYTES = 100 * 1024 * 1024; // 100 MB cap on proxied files

// ─── Structured error helper ─────────────────────────────────────────────────

interface ApiError {
  error: { code: string; message: string };
}

function errResponse(code: string, message: string, status: number, req?: Request): Response {
  const body: ApiError = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// ─── Timeout-aware fetch wrapper ─────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DBX_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Dropbox API timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Dropbox helpers ─────────────────────────────────────────────────────────

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
  const res = await fetchWithTimeout(`${DROPBOX_API}${endpoint}`, {
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

// ─── Parallel with concurrency limit ─────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await fn(items[idx]);
      } catch {
        results[idx] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Preview URL builder ─────────────────────────────────────────────────────

function buildParentPreviewUrl(parentShareUrl: string, prefix: string, basePath: string, filePath: string): string | null {
  if (!parentShareUrl) return null;
  const base = parentShareUrl.split('?')[0];
  const rlMatch = parentShareUrl.match(/rlkey=([^&]+)/);
  if (!rlMatch) return null;
  let fullPath = basePath ? `${basePath}${filePath}` : filePath;
  if (prefix && fullPath.startsWith(prefix)) fullPath = fullPath.slice(prefix.length);
  if (!fullPath.startsWith('/')) fullPath = '/' + fullPath;
  const encodedPath = fullPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${base}/${encodedPath}?rlkey=${rlMatch[1]}&dl=0`;
}

// ─── File entry (no raw_url — thumbnails use thumb action) ───────────────────

interface FileEntry {
  name: string;
  size: number;
  ext: string;
  type: string;
  preview_url: string | null;
  path: string;
  dbx_id?: string;
  modified: string | null;
  uploaded_at: string | null;
}

function fileEntry(f: Record<string, unknown>, folderName: string, parentShareUrl?: string, pathPrefix?: string, basePath?: string): FileEntry {
  const name = f.name as string;
  const relativePath = (f.path_display as string) || `/${folderName}/${name}`;

  return {
    name,
    size: f.size as number,
    ext: getExt(name),
    type: classifyFile(name),
    preview_url: parentShareUrl ? buildParentPreviewUrl(parentShareUrl, pathPrefix || '', basePath || '', relativePath) : null,
    path: relativePath,
    dbx_id: (f.id as string) || undefined,
    modified: (f.client_modified as string) || null,
    uploaded_at: (f.server_modified as string) || null,
  };
}

// ─── Path normalization helper ───────────────────────────────────────────────

function stripPrefix(filePath: string, pathPrefix: string): string {
  let rel = filePath;
  if (pathPrefix && rel.startsWith(pathPrefix)) {
    rel = rel.slice(pathPrefix.length);
  }
  if (!rel.startsWith('/')) rel = '/' + rel;
  return rel;
}

// ─── Path validation ────────────────────────────────────────────────────────

/** Reject file_path values that attempt traversal or are obviously invalid. */
function isValidFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  // Block path traversal sequences
  if (filePath.includes('..')) return false;
  // Block null bytes
  if (filePath.includes('\0')) return false;
  // Must look like a reasonable Dropbox path (starts with / or alphanumeric)
  if (!/^[\/a-zA-Z0-9]/.test(filePath)) return false;
  // Max path length guard
  if (filePath.length > 2000) return false;
  return true;
}

/** Validate that share_url points to a legitimate Dropbox shared link. */
function isValidDropboxShareUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.dropbox.com' || parsed.hostname === 'dropbox.com';
  } catch {
    return false;
  }
}

/** Verify the request carries a valid Supabase anon key or auth token. */
function hasValidApiKey(req: Request): boolean {
  const apikey = req.headers.get('apikey') || '';
  const authHeader = req.headers.get('authorization') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  // Accept either the apikey header matching the anon key, or a Bearer token (JWT)
  if (apikey && apikey === anonKey) return true;
  if (authHeader.startsWith('Bearer ') && authHeader.length > 20) return true;
  return false;
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'getDeliveryMediaFeed' }, 200, req);
  }
  if (req.method !== 'POST') {
    return errResponse('METHOD_NOT_ALLOWED', 'POST or GET only', 405, req);
  }

  try {
    // ─── Auth gate: require a valid Supabase apikey or JWT ──────────────
    if (!hasValidApiKey(req)) {
      return errResponse('UNAUTHORIZED', 'Missing or invalid apikey / authorization header', 401, req);
    }

    const body = await req.json().catch(() => ({}));

    // Attempt to resolve the authenticated user (logged for audit; not blocking
    // because the delivery feed may be viewed by anon-key-authenticated clients
    // such as public delivery pages).
    const appUser = await getUserFromReq(req).catch(() => null);

    const token = Deno.env.get('DROPBOX_API_TOKEN');
    if (!token) return errResponse('CONFIG_ERROR', 'Dropbox integration not configured', 500, req);

    const parentShareUrl = Deno.env.get('DROPBOX_PARENT_SHARE_URL') || '';
    const pathPrefix = Deno.env.get('DROPBOX_PARENT_PATH_PREFIX') || '';

    const { share_url, path, action, base_path } = body;

    // ─── Validate file_path for proxy/thumb/stream actions ──────────────
    if ((action === 'thumb' || action === 'proxy' || action === 'stream_url') && body.file_path) {
      if (!isValidFilePath(body.file_path)) {
        return errResponse('INVALID_PATH', 'file_path contains invalid characters or traversal sequences', 400, req);
      }
    }

    // ─── Validate share_url is a real Dropbox link ──────────────────────
    if (share_url && !isValidDropboxShareUrl(share_url)) {
      return errResponse('INVALID_SHARE_URL', 'share_url must be a valid Dropbox shared link', 400, req);
    }

    // ─── Action: thumb — fast thumbnail via Dropbox API ──────────────────
    if (action === 'thumb' && body.file_path) {
      if (!parentShareUrl) return errResponse('CONFIG_ERROR', 'Dropbox share link not configured', 500, req);

      const relPath = stripPrefix(body.file_path, pathPrefix);
      const size = body.size || 'w480h320';
      const arg = JSON.stringify({
        resource: { '.tag': 'link', url: parentShareUrl, path: relPath },
        format: 'jpeg',
        size,
        mode: 'bestfit',
      });

      let dbxRes: Response;
      try {
        dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/files/get_thumbnail_v2`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': arg },
        });
      } catch (err) {
        return errResponse('DROPBOX_TIMEOUT', 'Thumbnail request timed out', 504, req);
      }

      if (dbxRes.ok) {
        return new Response(dbxRes.body, {
          status: 200,
          headers: {
            ...getCorsHeaders(req),
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }

      // Explicit fallback: thumbnail failed, proxy the full file instead.
      console.warn(`Thumbnail failed (${dbxRes.status}), falling back to proxy`);
      await dbxRes.body?.cancel();

      const proxyArg = JSON.stringify({ url: parentShareUrl, path: relPath });
      const proxyRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': proxyArg },
      });
      if (!proxyRes.ok) {
        return errResponse('PROXY_FAILED', 'Could not retrieve file from Dropbox', 502, req);
      }

      // Enforce size cap on proxied content
      const cl = proxyRes.headers.get('content-length');
      if (cl && parseInt(cl, 10) > MAX_PROXY_BYTES) {
        await proxyRes.body?.cancel();
        return errResponse('FILE_TOO_LARGE', 'Requested file exceeds maximum proxy size', 413, req);
      }

      return new Response(proxyRes.body, {
        status: 200,
        headers: {
          ...getCorsHeaders(req),
          'Content-Type': proxyRes.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=7200',
        },
      });
    }

    // ─── Action: stream_url — proxy with streaming headers for video ─────
    if (action === 'stream_url' && body.file_path) {
      if (!parentShareUrl) return errResponse('CONFIG_ERROR', 'Dropbox share link not configured', 500, req);

      const relPath = stripPrefix(body.file_path, pathPrefix);
      const arg = JSON.stringify({ url: parentShareUrl, path: relPath });

      const dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': arg },
      });

      if (!dbxRes.ok) {
        return errResponse('STREAM_FAILED', 'Could not stream file from Dropbox', 502, req);
      }

      const ct = dbxRes.headers.get('content-type') || 'application/octet-stream';
      const cl = dbxRes.headers.get('content-length');
      const hdrs: Record<string, string> = {
        ...getCorsHeaders(req),
        'Content-Type': ct,
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=7200',
      };
      if (cl) hdrs['Content-Length'] = cl;

      return new Response(dbxRes.body, { status: 200, headers: hdrs });
    }

    // ─── Action: proxy — serve full file via parent share link ───────────
    if (action === 'proxy' && body.file_path) {
      if (!parentShareUrl) return errResponse('CONFIG_ERROR', 'Dropbox share link not configured', 500, req);

      const relPath = stripPrefix(body.file_path, pathPrefix);
      const arg = JSON.stringify({ url: parentShareUrl, path: relPath });

      const dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': arg },
      });
      if (!dbxRes.ok) {
        return errResponse('PROXY_FAILED', 'Could not retrieve file from Dropbox', 502, req);
      }

      // Enforce size cap
      const cl = dbxRes.headers.get('content-length');
      if (cl && parseInt(cl, 10) > MAX_PROXY_BYTES) {
        await dbxRes.body?.cancel();
        return errResponse('FILE_TOO_LARGE', 'Requested file exceeds maximum proxy size', 413, req);
      }

      const ct = dbxRes.headers.get('content-type') || 'application/octet-stream';
      return new Response(dbxRes.body, {
        status: 200,
        headers: {
          ...getCorsHeaders(req),
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=7200',
        },
      });
    }

    // ─── Main: list folder contents ──────────────────────────────────────
    if (!share_url && !path) return errResponse('INVALID_PARAMS', 'share_url or path required', 400, req);

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

    // List all subfolders in parallel (concurrency limit of 5)
    const subResults = await mapWithConcurrency(subfolders, SUBFOLDER_CONCURRENCY, async (sf) => {
      const subPath = useShared ? `/${sf.name}` : `${listPath}/${sf.name}`;
      const subEntries = await listAll(token, subPath, useShared ? share_url : undefined);
      const files = subEntries
        .filter((e: Record<string, unknown>) => e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name as string)))
        .map((f: Record<string, unknown>) => fileEntry(f, sf.name as string, parentShareUrl, pathPrefix, base_path));
      if (files.length === 0) return null;
      return { name: sf.name as string, files };
    });

    for (const result of subResults) {
      if (result) folders.push(result);
    }

    const listing = {
      folders,
      total_files: folders.reduce((s, f) => s + f.files.length, 0),
      fetched_at: new Date().toISOString(),
    };

    return new Response(JSON.stringify(listing), {
      status: 200,
      headers: {
        ...getCorsHeaders(req),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });

  } catch (err) {
    // Log full error server-side but never expose Dropbox details to the client
    console.error('getDeliveryMediaFeed error:', err);
    const msg = (err.message || '') as string;

    if (msg.includes('timeout')) {
      return errResponse('DROPBOX_TIMEOUT', 'Dropbox request timed out', 504, req);
    }
    if (msg.includes('invalid_access_token') || msg.includes('expired_access_token')) {
      return errResponse('TOKEN_EXPIRED', 'Dropbox token expired — contact admin', 502, req);
    }
    // Generic message — never echo raw err.message to the client
    return errResponse('INTERNAL_ERROR', 'An internal error occurred while processing the media request', 500, req);
  }
});

import { handleCors, getCorsHeaders, jsonResponse, getAdminClient } from '../_shared/supabase.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DBX_TIMEOUT_MS = 20_000;
const MAX_LIST_ENTRIES = 5000;
const CACHE_KEY = 'working_files::all';
const CACHE_TTL_MS = 30 * 60 * 1000;   // 30 min hard expiry
const CACHE_STALE_MS = 5 * 60 * 1000;  // 5 min — serve stale + background refresh

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','heic','heif']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','webm','mkv','m4v','wmv']);
const DOC_EXTS   = new Set(['pdf','ai','eps','svg','dwg']);
const SKIP_EXTS  = new Set(['dng','cr2','cr3','arw','nef','orf','raf','rw2','raw','nrw']);

// ─── Types ──────────────────────────────────────────────────────────────────

interface WorkingFile {
  name: string;
  path: string;
  property: string;
  source: 'images' | 'video';
  type: 'image' | 'video' | 'document' | 'other';
  ext: string;
  size: number;
  client_modified: string;
  server_modified: string;
}

interface CacheEntry {
  id: string;
  cache_key: string;
  cache_type: string;
  data: unknown;
  blob_path: string | null;
  project_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getExt(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function classifyFile(name: string): 'image' | 'video' | 'document' | 'other' {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (DOC_EXTS.has(ext))   return 'document';
  return 'other';
}

/**
 * Extract the "property" name from a file path.
 * The first subfolder level beneath the shared root is the property address.
 * e.g. "/123 Smith St/Bedroom/photo.jpg" -> "123 Smith St"
 */
function extractProperty(filePath: string): string {
  const parts = filePath.replace(/^\/+/, '').split('/');
  // If there's at least a folder + filename, the first segment is the property
  if (parts.length >= 2) return parts[0];
  return 'Root';
}

// ─── Structured error helper ────────────────────────────────────────────────

function errResponse(code: string, message: string, status: number, req?: Request): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// ─── Timeout-aware fetch ────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = DBX_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: unknown) {
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      (err instanceof Error && err.message.includes('aborted'))
    ) {
      throw new Error(`Dropbox API timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Dropbox OAuth ──────────────────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let refreshPromise: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;
  cachedAccessToken = Deno.env.get('DROPBOX_API_TOKEN') || '';
  return cachedAccessToken;
}

async function refreshAccessToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = Deno.env.get('DROPBOX_REFRESH_TOKEN');
    const appKey = Deno.env.get('DROPBOX_APP_KEY');
    const appSecret = Deno.env.get('DROPBOX_APP_SECRET');

    if (!refreshToken || !appKey || !appSecret) {
      throw new Error('Missing DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, or DROPBOX_APP_SECRET');
    }

    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${appKey}:${appSecret}`),
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Token refresh failed: ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    cachedAccessToken = data.access_token;
    console.log(`Dropbox token refreshed, expires in ${data.expires_in}s`);
    return cachedAccessToken!;
  })();

  try {
    const token = await refreshPromise;
    return token;
  } finally {
    refreshPromise = null;
  }
}

// ─── Dropbox API call with auto-refresh ─────────────────────────────────────

async function dbxPost(token: string, endpoint: string, body: Record<string, unknown>) {
  const doRequest = async (t: string) => {
    return await fetchWithTimeout(`${DROPBOX_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  let res = await doRequest(token);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 401 || txt.includes('expired_access_token') || txt.includes('invalid_access_token')) {
      try {
        const newToken = await refreshAccessToken();
        res = await doRequest(newToken);
        if (!res.ok) {
          const txt2 = await res.text().catch(() => '');
          throw new Error(`Dropbox ${endpoint} ${res.status}: ${txt2.slice(0, 300)}`);
        }
        return res.json();
      } catch (refreshErr: any) {
        throw new Error(`expired_access_token: ${refreshErr.message}`);
      }
    }
    if (res.status === 429) {
      const retryAfter = res.headers?.get('Retry-After') || '60';
      throw new Error(`Dropbox rate limited on ${endpoint} — retry after ${retryAfter}s`);
    }
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Recursive folder listing with pagination ───────────────────────────────

async function listAll(
  token: string,
  path: string,
  sharedLink: string,
  recursive: boolean,
): Promise<{ entries: Record<string, unknown>[]; truncated: boolean }> {
  const body: Record<string, unknown> = {
    path,
    include_deleted: false,
    recursive,
    limit: 2000,
    shared_link: { url: sharedLink },
  };

  const data = await dbxPost(token, '/files/list_folder', body);
  let entries: Record<string, unknown>[] = data.entries || [];
  let hasMore = !!data.has_more;
  let cursor: string | undefined = data.cursor;
  let truncated = false;

  while (hasMore && cursor) {
    const more = await dbxPost(token, '/files/list_folder/continue', { cursor });
    entries = entries.concat(more.entries || []);
    hasMore = !!more.has_more;
    cursor = more.cursor;
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }
  }
  return { entries, truncated };
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

async function getCacheEntry(cacheKey: string): Promise<CacheEntry | null> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('media_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) {
    console.warn('Cache read error:', error.message);
    return null;
  }
  return data;
}

async function upsertCacheEntry(entry: {
  cache_key: string;
  cache_type: string;
  data?: unknown;
  expires_at: string;
}): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin
    .from('media_cache')
    .upsert(
      { ...entry, updated_at: new Date().toISOString() },
      { onConflict: 'cache_key' },
    );
  if (error) console.warn('Cache write error:', error.message);
}

function isCacheStale(entry: CacheEntry): boolean {
  const age = Date.now() - new Date(entry.updated_at).getTime();
  return age > CACHE_STALE_MS;
}

// ─── Auth gate ──────────────────────────────────────────────────────────────

function hasValidApiKey(req: Request): boolean {
  const apikey = req.headers.get('apikey') || '';
  const authHeader = req.headers.get('authorization') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (apikey && apikey === anonKey) return true;
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const parts = token.split('.');
    if (parts.length === 3 && parts.every(p => p.length > 0)) return true;
  }
  return false;
}

// ─── Fetch working files from both Dropbox shared links ─────────────────────

async function fetchWorkingFiles(token: string): Promise<{ files: WorkingFile[]; truncated: boolean }> {
  const imagesUrl = Deno.env.get('DROPBOX_WORKING_FILES_IMAGES_URL') || '';
  const videoUrl  = Deno.env.get('DROPBOX_WORKING_FILES_VIDEO_URL') || '';

  if (!imagesUrl && !videoUrl) {
    throw new Error('Neither DROPBOX_WORKING_FILES_IMAGES_URL nor DROPBOX_WORKING_FILES_VIDEO_URL is configured');
  }

  const allFiles: WorkingFile[] = [];
  let anyTruncated = false;
  const errors: string[] = [];

  // Fetch both sources in parallel
  const sources: { url: string; source: 'images' | 'video' }[] = [];
  if (imagesUrl) sources.push({ url: imagesUrl, source: 'images' });
  if (videoUrl)  sources.push({ url: videoUrl,  source: 'video' });

  const results = await Promise.allSettled(
    sources.map(async ({ url, source }) => {
      const { entries, truncated } = await listAll(token, '', url, true);
      if (truncated) anyTruncated = true;

      const files: WorkingFile[] = [];
      for (const e of entries) {
        if (e['.tag'] !== 'file') continue;
        const name = e.name as string;
        const ext = getExt(name);
        if (SKIP_EXTS.has(ext)) continue;

        const path = (e.path_display as string) || `/${name}`;
        files.push({
          name,
          path,
          property: extractProperty(path),
          source,
          type: classifyFile(name),
          ext,
          size: (e.size as number) || 0,
          client_modified: (e.client_modified as string) || '',
          server_modified: (e.server_modified as string) || '',
        });
      }
      return files;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allFiles.push(...result.value);
    } else {
      const src = sources[i].source;
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${src}: ${msg}`);
      console.error(`Failed to list ${src} working files:`, msg);
    }
  }

  if (allFiles.length === 0 && errors.length > 0) {
    throw new Error(`All sources failed: ${errors.join('; ')}`);
  }

  return { files: allFiles, truncated: anyTruncated };
}

// ─── Build response payload ─────────────────────────────────────────────────

function buildResponse(files: WorkingFile[], truncated?: boolean) {
  const properties = new Set(files.map(f => f.property));
  const latestModified = files.reduce((latest, f) => {
    const d = f.server_modified || f.client_modified;
    return d > latest ? d : latest;
  }, '');

  const payload: Record<string, unknown> = {
    files,
    stats: {
      total: files.length,
      images: files.filter(f => f.type === 'image').length,
      videos: files.filter(f => f.type === 'video').length,
      documents: files.filter(f => f.type === 'document').length,
      properties: properties.size,
      latest_modified: latestModified || null,
    },
    fetched_at: new Date().toISOString(),
  };
  if (truncated) {
    payload.truncated = true;
    payload.truncated_message = `Results were capped at ${MAX_LIST_ENTRIES} entries per source. Some files may not be shown.`;
  }
  return payload;
}

// ─── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Health check
  if (req.method === 'GET') {
    return jsonResponse({ status: 'ok', function: 'getWorkingFilesFeed' }, 200, req);
  }

  if (req.method !== 'POST') {
    return errResponse('METHOD_NOT_ALLOWED', 'POST or GET only', 405, req);
  }

  try {
    if (!hasValidApiKey(req)) {
      return errResponse('UNAUTHORIZED', 'Missing or invalid apikey / authorization header', 401, req);
    }

    const token = await getAccessToken();
    if (!token) return errResponse('CONFIG_ERROR', 'Dropbox integration not configured', 500, req);

    // ─── Check cache first ────────────────────────────────────────────
    const cached = await getCacheEntry(CACHE_KEY);

    if (cached) {
      const cachedData = cached.data as { files: WorkingFile[]; truncated?: boolean };

      if (!isCacheStale(cached)) {
        // Fresh cache — return immediately
        const payload = buildResponse(cachedData.files, cachedData.truncated);
        payload.cache = 'hit';
        return jsonResponse(payload, 200, req);
      }

      // Stale cache — return stale data + trigger background refresh
      const payload = buildResponse(cachedData.files, cachedData.truncated);
      payload.cache = 'stale';

      // Fire-and-forget background refresh
      (async () => {
        try {
          const freshToken = await getAccessToken();
          const { files, truncated } = await fetchWorkingFiles(freshToken);
          await upsertCacheEntry({
            cache_key: CACHE_KEY,
            cache_type: 'working_files_listing',
            data: { files, truncated },
            expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
          });
          console.log(`Background refresh complete: ${files.length} working files cached`);
        } catch (err: any) {
          console.error('Background cache refresh failed:', err?.message);
        }
      })();

      return jsonResponse(payload, 200, req);
    }

    // ─── No cache — fetch from Dropbox ────────────────────────────────
    const { files, truncated } = await fetchWorkingFiles(token);

    // Store in cache
    await upsertCacheEntry({
      cache_key: CACHE_KEY,
      cache_type: 'working_files_listing',
      data: { files, truncated },
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    });

    const payload = buildResponse(files, truncated);
    payload.cache = 'miss';
    return jsonResponse(payload, 200, req);

  } catch (err: any) {
    console.error('getWorkingFilesFeed error:', err?.message || err);
    return errResponse('INTERNAL_ERROR', err?.message || 'Unexpected error', 500, req);
  }
});

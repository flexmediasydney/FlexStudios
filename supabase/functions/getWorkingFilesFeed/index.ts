import { handleCors, getCorsHeaders, jsonResponse, getAdminClient } from '../_shared/supabase.ts';

// ─── Constants ──────────────────────────────────────────────────────────────

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DBX_TIMEOUT_MS = 20_000;
const MAX_LIST_ENTRIES = 5000;
const CACHE_KEY = 'working_files::all';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hour hard expiry (was 30 min — too aggressive, causes rate limits)
const CACHE_STALE_MS = 15 * 60 * 1000;   // 15 min — serve stale + background refresh

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','heic','heif','cr2','cr3','dng','arw','nef','orf','raf','rw2','raw','nrw']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','webm','mkv','m4v','wmv']);
const DOC_EXTS   = new Set(['pdf','ai','eps','svg','dwg']);
const SKIP_EXTS  = new Set<string>(); // Show ALL files including RAW/CR3

// ─── Types ──────────────────────────────────────────────────────────────────

interface WorkingFile {
  name: string;
  path: string;
  property: string;
  source: 'images' | 'video';
  type: 'image' | 'video' | 'document' | 'other';
  extension: string;
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
          // Don't mask 429 as auth error
          if (res.status === 429) {
            const retryAfter = res.headers?.get('Retry-After') || '60';
            throw new Error(`Dropbox rate limited on ${endpoint} — retry after ${retryAfter}s`);
          }
          throw new Error(`Dropbox ${endpoint} ${res.status}: ${txt2.slice(0, 300)}`);
        }
        return res.json();
      } catch (refreshErr: any) {
        // Pass through rate limit errors without wrapping
        if (refreshErr.message?.includes('rate limited')) throw refreshErr;
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

// ─── Listing strategy: resolve shared link → recursive list via actual path ──
// This uses ONE paginated API call instead of dozens of folder-by-folder calls,
// avoiding rate limits and discovering all files at any depth.

/**
 * Resolve a shared link to its actual folder path (team namespace).
 * Once we have the real path, we can use recursive=true which is
 * forbidden on shared_link but allowed on actual paths.
 */
async function resolveSharedLinkPath(token: string, sharedLink: string): Promise<string> {
  const meta = await dbxPost(token, '/sharing/get_shared_link_metadata', { url: sharedLink });
  // path_lower is the canonical team-namespace path
  const path = meta.path_lower || meta.path_display || '';
  if (!path) {
    throw new Error(`Could not resolve path from shared link — got: ${JSON.stringify({ tag: meta['.tag'], name: meta.name, id: meta.id }).slice(0, 200)}`);
  }
  console.log(`Resolved shared link → ${path} (${meta.name})`);
  return path;
}

/**
 * List ALL files recursively under a folder path using Dropbox recursive=true.
 * Single paginated API call — no folder-by-folder walking needed.
 */
async function listRecursive(
  token: string,
  folderPath: string,
): Promise<{ entries: Record<string, unknown>[]; truncated: boolean }> {
  const body: Record<string, unknown> = {
    path: folderPath,
    recursive: true,
    include_deleted: false,
    limit: 2000,
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

  console.log(`Recursive list of ${folderPath}: ${entries.length} entries (has_more=${hasMore})`);
  return { entries, truncated };
}

/**
 * Fallback: list via shared link (walks subfolders recursively with concurrency).
 * Used when direct path access fails (e.g. app doesn't have team scope).
 * Dropbox blocks recursive=true on shared links, so we walk manually.
 */
const SUBFOLDER_CONCURRENCY = 5;

async function listViaSharedLink(
  token: string,
  sharedLink: string,
  maxDepth = 6,
): Promise<{ entries: Record<string, unknown>[]; truncated: boolean }> {
  const allFiles: Record<string, unknown>[] = [];
  let anyTruncated = false;

  async function listPage(path: string) {
    const body: Record<string, unknown> = {
      path,
      include_deleted: false,
      limit: 2000,
      shared_link: { url: sharedLink },
    };
    const data = await dbxPost(token, '/files/list_folder', body);
    let entries: Record<string, unknown>[] = data.entries || [];
    let hasMore = !!data.has_more;
    let cursor: string | undefined = data.cursor;
    while (hasMore && cursor) {
      const more = await dbxPost(token, '/files/list_folder/continue', { cursor });
      entries = entries.concat(more.entries || []);
      hasMore = !!more.has_more;
      cursor = more.cursor;
      if (entries.length >= 5000) break;
    }
    return entries;
  }

  async function walk(path: string, depth: number) {
    if (allFiles.length >= MAX_LIST_ENTRIES) return;

    let entries: Record<string, unknown>[];
    try {
      entries = await listPage(path);
    } catch (err: any) {
      console.warn(`Shared-link walk failed at ${path || '/'}: ${err?.message}`);
      return;
    }

    const subfolders: { path: string; name: string }[] = [];
    for (const e of entries) {
      if (e['.tag'] === 'file') {
        if (!e.path_display) {
          e.path_display = path ? `${path}/${e.name}` : `/${e.name}`;
        }
        allFiles.push(e);
      } else if (e['.tag'] === 'folder' && depth < maxDepth) {
        const name = e.name as string;
        if (name.includes('SHELL')) continue;
        const folderPath = (e.path_display as string) || (e.path_lower as string) || (path ? `${path}/${name}` : `/${name}`);
        subfolders.push({ path: folderPath, name });
      }
    }

    // Walk subfolders with bounded concurrency
    if (subfolders.length > 0) {
      let next = 0;
      async function worker() {
        while (next < subfolders.length) {
          if (allFiles.length >= MAX_LIST_ENTRIES) break;
          const idx = next++;
          await walk(subfolders[idx].path, depth + 1);
        }
      }
      const workers = Array.from(
        { length: Math.min(SUBFOLDER_CONCURRENCY, subfolders.length) },
        () => worker()
      );
      await Promise.all(workers);
    }
  }

  await walk('', 0);
  return { entries: allFiles, truncated: anyTruncated || allFiles.length >= MAX_LIST_ENTRIES };
}

/**
 * List all files under a shared link — tries recursive direct-path first,
 * falls back to shared-link walk if direct access fails.
 */
async function listAllUnderSharedLink(
  token: string,
  sharedLink: string,
): Promise<{ entries: Record<string, unknown>[]; truncated: boolean }> {
  // Strategy 1: Resolve shared link → recursive listing (1 API call, all depths)
  try {
    const folderPath = await resolveSharedLinkPath(token, sharedLink);
    const result = await listRecursive(token, folderPath);
    const fileEntries = result.entries.filter(e => e['.tag'] === 'file');

    if (fileEntries.length > 0) {
      // Strip the resolved folder prefix from path_display so paths are relative
      const prefix = folderPath.toLowerCase();
      for (const e of result.entries) {
        const pd = (e.path_display as string) || '';
        const pl = (e.path_lower as string) || '';
        if (pl.toLowerCase().startsWith(prefix)) {
          e.path_display = pd.slice(folderPath.length) || `/${e.name}`;
        }
      }
      // Return only files (recursive includes folders too)
      return { entries: fileEntries, truncated: result.truncated };
    }
    console.warn(`Recursive listing found 0 files at ${folderPath} — falling back to shared-link walk`);
  } catch (err: any) {
    console.warn(`Recursive listing failed, falling back to shared-link walk: ${err?.message}`);
  }

  // Strategy 2: Shared-link walk (folder by folder, works with team namespaces)
  return listViaSharedLink(token, sharedLink);
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
      const { entries, truncated } = await listAllUnderSharedLink(token, url);
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
          extension: ext,
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

    const body = await req.json().catch(() => ({}));
    const token = await getAccessToken();
    if (!token) return errResponse('CONFIG_ERROR', 'Dropbox integration not configured', 500, req);

    // Debug mode — show env config status and Dropbox link metadata
    if (body?._debug) {
      const imagesUrl = Deno.env.get('DROPBOX_WORKING_FILES_IMAGES_URL') || '';
      const videoUrl  = Deno.env.get('DROPBOX_WORKING_FILES_VIDEO_URL') || '';
      const debug: Record<string, unknown> = {
        token_set: token.length > 10,
        images_url_set: !!imagesUrl,
        images_url_len: imagesUrl.length,
        video_url_set: !!videoUrl,
        video_url_len: videoUrl.length,
      };
      // Probe each shared link
      for (const [label, url] of [['images', imagesUrl], ['video', videoUrl]] as const) {
        if (!url) continue;
        try {
          const meta = await dbxPost(token, '/sharing/get_shared_link_metadata', { url });
          debug[`${label}_meta`] = { tag: meta['.tag'], name: meta.name, path: meta.path_lower, id: meta.id };
          // Also try listing root
          const listResult = await dbxPost(token, '/files/list_folder', {
            path: '', shared_link: { url }, include_deleted: false, limit: 20,
          });
          debug[`${label}_root_entries`] = (listResult.entries || []).length;
          debug[`${label}_root_sample`] = (listResult.entries || []).slice(0, 5).map((e: any) => ({
            tag: e['.tag'], name: e.name, path_display: e.path_display, path_lower: e.path_lower, id: e.id,
          }));
        } catch (err: any) {
          debug[`${label}_error`] = err?.message;
        }
      }
      return jsonResponse(debug, 200, req);
    }

    const forceRefresh = !!body?.force_refresh;

    // ─── Always check cache — even on force_refresh we need fallback ──
    const cached = await getCacheEntry(CACHE_KEY);

    if (cached && !forceRefresh) {
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
          if (files.length > 0) {
            await upsertCacheEntry({
              cache_key: CACHE_KEY,
              cache_type: 'working_files_listing',
              data: { files, truncated },
              expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
            });
            console.log(`Background refresh complete: ${files.length} working files cached`);
          } else {
            console.warn('Background refresh returned 0 files — keeping stale cache');
          }
        } catch (err: any) {
          console.error('Background cache refresh failed:', err?.message);
        }
      })();

      return jsonResponse(payload, 200, req);
    }

    // ─── Force refresh or no cache — fetch from Dropbox ───────────────
    let files: WorkingFile[] = [];
    let truncated = false;
    try {
      const result = await fetchWorkingFiles(token);
      files = result.files;
      truncated = result.truncated;
    } catch (err: any) {
      console.error('Dropbox fetch failed:', err?.message);
      // If fetch fails but we have stale cache, serve it
      if (cached) {
        const cachedData = cached.data as { files: WorkingFile[]; truncated?: boolean };
        const payload = buildResponse(cachedData.files, cachedData.truncated);
        payload.cache = 'stale_fallback';
        payload.refresh_error = err?.message;
        return jsonResponse(payload, 200, req);
      }
      throw err;
    }

    // If Dropbox returned 0 files (rate limit / error) but cache exists, use cache
    if (files.length === 0 && cached) {
      const cachedData = cached.data as { files: WorkingFile[]; truncated?: boolean };
      const payload = buildResponse(cachedData.files, cachedData.truncated);
      payload.cache = 'stale_fallback';
      payload.refresh_error = 'Dropbox returned 0 files (possible rate limit)';
      return jsonResponse(payload, 200, req);
    }

    // Store in cache (only if we got real data)
    if (files.length > 0) {
      await upsertCacheEntry({
        cache_key: CACHE_KEY,
        cache_type: 'working_files_listing',
        data: { files, truncated },
        expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      });
    }

    const payload = buildResponse(files, truncated);
    payload.cache = 'miss';
    return jsonResponse(payload, 200, req);

  } catch (err: any) {
    console.error('getWorkingFilesFeed error:', err?.message || err);
    return errResponse('INTERNAL_ERROR', err?.message || 'Unexpected error', 500, req);
  }
});

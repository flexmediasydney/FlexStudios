import { handleCors, getCorsHeaders, jsonResponse, getAdminClient } from '../_shared/supabase.ts';
import { getDropboxAccessToken, getOrCreateSharedLink } from '../_shared/dropbox.ts';

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';

/**
 * Dropbox-API-Path-Root header. Required for every API call when the connected
 * account is a Dropbox Business team member — without it, calls scope to the
 * user's personal home namespace and team folders are invisible. Set
 * DROPBOX_TEAM_NAMESPACE_ID to root_info.root_namespace_id from
 * /users/get_current_account.
 */
function dbxPathRootHeader(): Record<string, string> {
  const ns = Deno.env.get('DROPBOX_TEAM_NAMESPACE_ID');
  if (!ns) return {};
  return { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: ns }) };
}
const SKIP_EXTS = new Set(['dng','cr2','cr3','arw','nef','orf','raf','rw2','raw','nrw']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp','tiff','tif','heic','heif']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','webm','mkv','m4v','wmv']);
const DOC_EXTS   = new Set(['pdf','ai','eps','svg','dwg']);

const DBX_TIMEOUT_MS = 20_000;
const DBX_CONTENT_TIMEOUT_MS = 60_000; // 60s for binary content (videos can be 100MB+)
const SUBFOLDER_CONCURRENCY = 5;
const MAX_PROXY_BYTES = 100 * 1024 * 1024; // 100 MB cap on proxied files

const LISTING_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LISTING_STALE_MS = 5 * 60 * 1000;      // 5 minutes — background refresh threshold
const THUMB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for thumbnails
const THUMB_BUCKET = 'media-thumbs';

// ─── Media cache helpers ────────────────────────────────────────────────────

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
  blob_path?: string;
  project_id?: string;
  expires_at: string;
}): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin
    .from('media_cache')
    .upsert(
      {
        ...entry,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'cache_key' }
    );
  if (error) console.warn('Cache write error:', error.message);
}

async function ensureThumbBucket(): Promise<void> {
  const admin = getAdminClient();
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = buckets?.some((b: { name: string }) => b.name === THUMB_BUCKET);
  if (!exists) {
    const { error } = await admin.storage.createBucket(THUMB_BUCKET, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024, // 5 MB max per thumbnail
    });
    if (error && !error.message?.includes('already exists')) {
      console.warn('Failed to create thumb bucket:', error.message);
    }
  }
}

/** Convert a file_path to a safe storage key for the thumbs bucket. */
function thumbStorageKey(filePath: string): string {
  // Strip leading slash, replace remaining slashes with double underscores
  return filePath.replace(/^\/+/, '').replace(/\//g, '__');
}

function isCacheStale(entry: CacheEntry): boolean {
  const age = Date.now() - new Date(entry.updated_at).getTime();
  return age > LISTING_STALE_MS;
}

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

// Dropbox auth — token mgmt + OAuth refresh live in `_shared/dropbox.ts`.
// Local helpers below exist to keep the existing dbxPost retry/backoff
// behaviour on this function intact (the shared lib's dropboxApi has slightly
// different retry semantics; folding them in is a separate cleanup).
const getAccessToken = () => getDropboxAccessToken();
const refreshAccessToken = () => getDropboxAccessToken({ forceRefresh: true });

async function dbxPost(token: string, endpoint: string, body: Record<string, unknown>) {
  const doRequest = async (t: string) => {
    const res = await fetchWithTimeout(`${DROPBOX_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json', ...dbxPathRootHeader() },
      body: JSON.stringify(body),
    });
    return res;
  };

  // Retry loop: up to 3 attempts to handle 429s and transient 5xx from Dropbox.
  const MAX_ATTEMPTS = 3;
  let lastErr = '';
  let activeToken = token;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await doRequest(activeToken);
    if (res.ok) return res.json();

    const txt = await res.text().catch(() => '');
    lastErr = `${res.status}: ${txt.slice(0, 300)}`;

    // Auto-refresh on 401 and retry once (counts as an attempt)
    if (res.status === 401 || txt.includes('expired_access_token') || txt.includes('invalid_access_token')) {
      try {
        activeToken = await refreshAccessToken();
        continue; // retry with new token
      } catch (refreshErr: unknown) {
        const m = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        throw new Error(`expired_access_token: ${m}`);
      }
    }

    // Rate limited — DO NOT retry from inside the Edge fn.
    //
    // 2026-05-03 hotfix — the prior code retried up to 3× with Retry-After
    // CAPPED at 5s.  When Dropbox is sending retry_after=300 (which it does
    // for an app whose recent burst pattern tripped the adaptive limiter),
    // a 5s wait is FAR too short.  Each premature retry extends the
    // cool-off window, so 3 retries × 5s = 15s of compounded damage that
    // keeps the bucket permanently hot.  We saw exactly this pattern on
    // the 46 Brays engine investigation (modal:photos-extract logged
    // 10 cascading 429s for a 5-file burst).
    //
    // New behaviour: surface 429 to the caller IMMEDIATELY with the real
    // retry_after captured from the header / body.  The browser-side
    // mediaPerf.fetchMediaProxy now negative-caches the failure for the
    // duration so click-spam can't re-hammer the bucket.  When a few
    // hundred seconds pass, the next click succeeds naturally.
    //
    // Best-effort observability — log the 429 to dropbox_429_log so the
    // dispatcher's circuit breaker also sees UI-side pressure (Wave 2
    // mig 464 schema).  Logging is fire-and-forget; failures don't
    // affect the response.
    if (res.status === 429) {
      const retryAfterHdr = parseInt(res.headers?.get('Retry-After') || '0', 10);
      const retryAfter = Number.isFinite(retryAfterHdr) && retryAfterHdr > 0 ? retryAfterHdr : null;
      console.warn(
        `Dropbox 429 on ${endpoint} (retry_after=${retryAfter ?? 'unspecified'}) — ` +
          `surfacing to caller WITHOUT retry to avoid compounding the cool-off window`,
      );
      // Fire-and-forget logging.  Lazy-import the supabase admin client
      // helper to avoid pulling it into every getDeliveryMediaFeed cold-
      // start when no 429 actually occurs.
      try {
        const { getAdminClient } = await import('../_shared/supabase.ts');
        const admin = getAdminClient();
        admin
          .from('dropbox_429_log')
          .insert({
            bucket: 'files',
            retry_after_s: retryAfter,
            source: 'edge:getDeliveryMediaFeed',
            context: { endpoint, attempt: attempt + 1 },
          })
          .then(({ error }) => {
            if (error) {
              console.warn(`dropbox_429_log insert failed (non-fatal): ${error.message}`);
            }
          });
      } catch (logErr) {
        console.warn(`dropbox_429_log import failed (non-fatal): ${logErr}`);
      }
      // Custom error so the Edge handler can surface a proper 429 to
      // the browser (with a retry_after_s field in the JSON body).
      const err: Error & { dropbox_429?: boolean; retry_after_s?: number | null } = new Error(
        `Dropbox rate limited on ${endpoint}` +
          (retryAfter ? ` — retry after ~${retryAfter}s` : ''),
      );
      err.dropbox_429 = true;
      err.retry_after_s = retryAfter;
      throw err;
    }

    // Transient 5xx — exponential backoff
    if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s
      console.warn(`Dropbox ${res.status} on ${endpoint}, retrying after ${delayMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    // Non-retryable — throw immediately
    if (res.status === 429) {
      throw new Error(`Dropbox rate limited on ${endpoint} — retry shortly`);
    }
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${txt.slice(0, 300)}`);
  }

  throw new Error(`Dropbox ${endpoint} exhausted retries: ${lastErr}`);
}

/**
 * If the response is 401, attempt to refresh the Dropbox token and return the
 * new access token so the caller can transparently retry.
 * Returns:
 *   - `{ newToken }` on successful refresh (caller should retry with this token)
 *   - An error `Response` if refresh failed (502) — client should surface error
 *   - `null` if the response was not a 401 (not a token issue, fall through)
 *
 * Note: 2026-04 fix — previously returned a 503 TOKEN_REFRESHED asking the
 * browser to retry, but delivery-page clients don't auto-retry on 503 so end
 * users saw broken thumbnails. Server-side retry eliminates that.
 */
async function handleTokenExpiry(
  res: Response,
  req: Request,
): Promise<{ newToken: string } | Response | null> {
  if (res.status === 401) {
    await res.body?.cancel();
    try {
      const newToken = await refreshAccessToken();
      return { newToken };
    } catch {
      return errResponse('TOKEN_EXPIRED', 'Dropbox token expired and refresh failed', 502, req);
    }
  }
  return null;
}

const MAX_LIST_ENTRIES = 5000;

async function listAll(token: string, path: string, sharedLink?: string): Promise<{ entries: Record<string, unknown>[]; truncated: boolean }> {
  const body: Record<string, unknown> = { path, include_deleted: false, limit: 2000 };
  if (sharedLink) body.shared_link = { url: sharedLink };
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`mapWithConcurrency: item ${idx} failed: ${msg}`);
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
    preview_url: null, // Preview URLs are constructed client-side using the project's deliverableLink
    path: relativePath,
    dbx_id: (f.id as string) || undefined,
    modified: (f.client_modified as string) || null,
    uploaded_at: (f.server_modified as string) || null,
  };
}

// ─── Path normalization helper ───────────────────────────────────────────────

function stripPrefix(filePath: string, pathPrefix: string): string {
  let rel = filePath;
  if (pathPrefix) {
    // Normalize the prefix: remove trailing slash so boundary check is consistent
    const normPrefix = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;

    // Helper: strip prefix only if it matches at a path boundary (followed by / or end-of-string).
    // Prevents "/foo" from incorrectly matching "/foobar".
    const tryStrip = (path: string, prefix: string): string | null => {
      if (!path.startsWith(prefix)) return null;
      const rest = path.slice(prefix.length);
      // Valid boundary: nothing left, or remainder starts with '/'
      if (rest === '' || rest.startsWith('/')) return rest;
      return null;
    };

    // Try matching the prefix as-is first
    const stripped = tryStrip(rel, normPrefix);
    if (stripped !== null) {
      rel = stripped;
    } else {
      // Try URL-decoded comparison on both sides
      try {
        const decodedRel = decodeURIComponent(rel);
        const decodedPrefix = decodeURIComponent(normPrefix);
        const decodedStripped = tryStrip(decodedRel, decodedPrefix);
        if (decodedStripped !== null) {
          rel = decodedStripped;
        }
      } catch { /* not URL-encoded, leave as-is */ }
    }
  }
  if (!rel.startsWith('/')) rel = '/' + rel;
  // Collapse any double (or more) slashes into single slashes
  rel = rel.replace(/\/\/+/g, '/');
  return rel;
}

// ─── Per-project share-link resolver ────────────────────────────────────────
//
// Drone module files live under /Flex Media Team Folder/Projects/<uuid>_<slug>/...
// (canonical case). Dropbox returns path_lower in API responses, so the file_path
// arriving here is usually lowercased: /flex media team folder/projects/<uuid>_...
//
// The legacy parent share URL only covers /flex media team folder/tonomo, so files
// outside that subtree need their own per-project shared link. We mint one against
// projects.dropbox_root_path (cached via dropbox_root_shared_link) and serve files
// inside it via /sharing/get_shared_link_file with a path relative to the project root.

const PROJECTS_PATH_RE = /^\/flex media team folder\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[^/]+\//i;

interface ProjectShare {
  share_url: string;
  /** Path relative to the project root, with leading slash. */
  rel_path: string;
}

/**
 * If `filePath` lives under /Flex Media Team Folder/Projects/<uuid>_*, return
 * the project's root shared link + the path relative to that root. Mints the
 * shared link on demand and persists it to projects.dropbox_root_shared_link.
 * Returns null if the path is not a project-tree path.
 */
async function resolveProjectShare(filePath: string): Promise<ProjectShare | null> {
  const m = PROJECTS_PATH_RE.exec(filePath);
  if (!m) return null;
  const projectId = m[1];
  const admin = getAdminClient();
  const { data: proj, error } = await admin
    .from('projects')
    .select('dropbox_root_path, dropbox_root_shared_link')
    .eq('id', projectId)
    .maybeSingle();
  if (error) {
    console.warn(`[resolveProjectShare] db error for ${projectId}:`, error.message);
    return null;
  }
  if (!proj?.dropbox_root_path) {
    console.warn(`[resolveProjectShare] no dropbox_root_path for ${projectId}`);
    return null;
  }

  let shareUrl = proj.dropbox_root_shared_link as string | null;
  if (!shareUrl) {
    try {
      shareUrl = await getOrCreateSharedLink(proj.dropbox_root_path as string);
      await admin
        .from('projects')
        .update({ dropbox_root_shared_link: shareUrl })
        .eq('id', projectId);
    } catch (e) {
      console.warn(`[resolveProjectShare] mint failed for ${projectId} at ${proj.dropbox_root_path}:`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  // Compute path relative to project root (case-insensitive prefix strip).
  const rootLower = (proj.dropbox_root_path as string).toLowerCase();
  const fileLower = filePath.toLowerCase();
  let rel = fileLower.startsWith(rootLower) ? fileLower.slice(rootLower.length) : filePath;
  if (!rel.startsWith('/')) rel = '/' + rel;
  return { share_url: shareUrl, rel_path: rel };
}

// ─── Path validation ────────────────────────────────────────────────────────

/** Reject file_path values that attempt traversal or are obviously invalid. */
function isValidFilePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  // Block actual path traversal sequences (/../ or /.. at end or leading ../)
  // but allow legitimate filenames containing ".." like "report..2024.pdf"
  if (/(^|\/)\.\.(\/|$)/.test(filePath)) return false;
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
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Validate JWT structure: must have 3 dot-separated segments (header.payload.signature)
    // This prevents accepting arbitrary strings like "Bearer AAAA" as valid auth
    const parts = token.split('.');
    if (parts.length === 3 && parts.every(p => p.length > 0)) return true;
  }
  return false;
}

// ─── Listing fetcher (extracted for reuse in cache-miss + background refresh) ─

async function fetchListingFromDropbox(
  token: string,
  share_url: string | undefined,
  path: string | undefined,
  base_path: string | undefined,
  parentShareUrl: string,
  pathPrefix: string,
): Promise<Record<string, unknown>> {
  const useShared = !!share_url;
  const listPath = useShared ? '' : ((path || '').startsWith('/') ? path! : '/' + path);

  const { entries: topEntries, truncated: topTruncated } = await listAll(token, listPath, useShared ? share_url : undefined);

  const subfolders: Record<string, unknown>[] = [];
  const rootFiles: Record<string, unknown>[] = [];

  for (const e of topEntries) {
    if (e['.tag'] === 'folder') subfolders.push(e);
    else if (e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name as string))) rootFiles.push(e);
  }

  const folders: { name: string; files: FileEntry[] }[] = [];
  let anyTruncated = topTruncated;

  if (rootFiles.length > 0) {
    folders.push({
      name: 'Root',
      files: rootFiles.map(f => fileEntry(f, 'Root', parentShareUrl, pathPrefix, base_path)),
    });
  }

  // Per-subfolder result is a tagged union: ok | empty | fail. This keeps
  // the ambiguity out of `null` (was: "could mean empty OR failed").  When a
  // subfolder list 429s or otherwise throws, we MUST flag the parent listing
  // as degraded so the cache layer doesn't write the empty result as a 30-min
  // success — that's the cache-poisoning bug that left every Project Media
  // tab / DeliveryFeed / LiveMediaFeed showing "Empty folder" once Dropbox
  // entered adaptive throttle.
  type SubResult =
    | { kind: 'ok'; data: { name: string; files: FileEntry[] } }
    | { kind: 'empty' }
    | { kind: 'fail'; error: string; rate_limited: boolean };

  const subResults = await mapWithConcurrency(subfolders, SUBFOLDER_CONCURRENCY, async (sf): Promise<SubResult> => {
    try {
      const sfPath = (sf.path_display as string) || (sf.path_lower as string) || '';
      const subPath = useShared
        ? (sfPath ? sfPath : `/${sf.name}`)
        : (sfPath ? sfPath : `${listPath}/${sf.name}`);
      const { entries: subEntries, truncated: subTruncated } = await listAll(token, subPath, useShared ? share_url : undefined);
      if (subTruncated) anyTruncated = true;
      const files = subEntries
        .filter((e: Record<string, unknown>) => e['.tag'] === 'file' && !SKIP_EXTS.has(getExt(e.name as string)))
        .map((f: Record<string, unknown>) => fileEntry(f, sf.name as string, parentShareUrl, pathPrefix, base_path));
      if (files.length === 0) return { kind: 'empty' };
      return { kind: 'ok', data: { name: sf.name as string, files } };
    } catch (err) {
      const e = err as Error & { dropbox_429?: boolean };
      const error = e?.message || String(err);
      const rate_limited = e?.dropbox_429 === true || error.includes('rate limited') || error.includes('429');
      return { kind: 'fail', error, rate_limited };
    }
  });

  let failedSubfolders = 0;
  let rateLimitedSubfolders = 0;
  for (const result of subResults) {
    if (!result) continue; // mapWithConcurrency only nulls on its own catch, which we now bypass
    if (result.kind === 'ok') folders.push(result.data);
    else if (result.kind === 'fail') {
      failedSubfolders++;
      if (result.rate_limited) rateLimitedSubfolders++;
    }
  }

  const totalFiles = folders.reduce((s, f) => s + f.files.length, 0);
  const listing: Record<string, unknown> = {
    folders,
    total_files: totalFiles,
    fetched_at: new Date().toISOString(),
  };
  if (anyTruncated) {
    listing.truncated = true;
    listing.truncated_message = `Results were capped at ${MAX_LIST_ENTRIES} entries per folder. Some files may not be shown.`;
  }
  // Critical: surface partial-failure state so the caller skips the cache
  // write.  Without this, every empty (rate-limited) listing was being upserted
  // for 30 min, locking out every downstream view from getting fresh data.
  if (failedSubfolders > 0) {
    listing.degraded = true;
    listing.degraded_subfolder_failures = failedSubfolders;
    listing.degraded_reason = rateLimitedSubfolders > 0
      ? `${rateLimitedSubfolders}/${subfolders.length} subfolders rate-limited by Dropbox`
      : `${failedSubfolders}/${subfolders.length} subfolders failed to list`;
  }

  return listing;
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === 'GET') {
    // GET with ?stream= param: stream a file directly for <video src="..."> usage
    const url = new URL(req.url);
    const streamPath = url.searchParams.get('stream');
    if (streamPath) {
      const token = await getAccessToken();
      const parentShareUrl = Deno.env.get('DROPBOX_PARENT_SHARE_URL') || '';
      const pathPrefix = Deno.env.get('DROPBOX_PARENT_PATH_PREFIX') || '';
      if (!token || !parentShareUrl) {
        return errResponse('CONFIG_ERROR', 'Not configured', 500, req);
      }

      let rel = streamPath;
      if (pathPrefix && rel.startsWith(pathPrefix)) rel = rel.slice(pathPrefix.length);
      if (!rel.startsWith('/')) rel = '/' + rel;

      const arg = JSON.stringify({ url: parentShareUrl, path: rel });
      const dbxRes = await fetch(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
      }, );

      if (!dbxRes.ok) {
        // Try refresh
        try {
          const newToken = await refreshAccessToken();
          const retryRes = await fetch(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${newToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
          });
          if (!retryRes.ok) return errResponse('STREAM_FAILED', 'Could not stream file', 502, req);
          const retryExt = (streamPath.split('.').pop() || '').toLowerCase();
          const retryMime: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/mp4' };
          const ct = retryMime[retryExt] || retryRes.headers.get('content-type') || 'application/octet-stream';
          const cl = retryRes.headers.get('content-length');
          const headers: Record<string, string> = {
            ...getCorsHeaders(req),
            'Content-Type': ct,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': 'inline',
            'Cache-Control': 'public, max-age=3600',
          };
          if (cl) headers['Content-Length'] = cl;
          return new Response(retryRes.body, { status: 200, headers });
        } catch {
          return errResponse('STREAM_FAILED', 'Could not stream file', 502, req);
        }
      }

      // Dropbox often returns generic application/octet-stream — override based on extension
      const ext = (streamPath.split('.').pop() || '').toLowerCase();
      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', webm: 'video/webm',
        mkv: 'video/x-matroska', m4v: 'video/mp4',
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        pdf: 'application/pdf', svg: 'image/svg+xml',
      };
      const ct = mimeMap[ext] || dbxRes.headers.get('content-type') || 'application/octet-stream';
      const cl = dbxRes.headers.get('content-length');
      const headers: Record<string, string> = {
        ...getCorsHeaders(req),
        'Content-Type': ct,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=3600',
      };
      if (cl) headers['Content-Length'] = cl;
      return new Response(dbxRes.body, { status: 200, headers });
    }

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

    // Note: getUserFromReq is available if audit logging is needed in the future,
    // but is intentionally not called here to avoid a wasted Supabase RPC round-trip
    // on every media feed request (including unauthenticated public delivery pages).

    const token = await getAccessToken();
    if (!token) return errResponse('CONFIG_ERROR', 'Dropbox integration not configured', 500, req);

    const parentShareUrl = Deno.env.get('DROPBOX_PARENT_SHARE_URL') || '';
    const pathPrefix = Deno.env.get('DROPBOX_PARENT_PATH_PREFIX') || '';

    const { share_url, path, action, base_path } = body;

    // Safe debug — only shows token status, not the token itself
    if (body?._debug) {
      const debugInfo: Record<string, unknown> = {
        token_set: token.length > 100,
        token_length: token.length,
        token_starts: token.substring(0, 10),
        path_prefix: pathPrefix,
        share_url_set: !!parentShareUrl,
        share_url_starts: parentShareUrl ? parentShareUrl.substring(0, 60) : null,
      };
      if (body?._listroot) {
        try {
          const lsPath = typeof body._lspath === 'string' ? body._lspath : '';
          const lr = await fetch(`${DROPBOX_API}/files/list_folder`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...dbxPathRootHeader() },
            body: JSON.stringify({ path: lsPath, recursive: false, limit: 100 }),
          });
          const lrTxt = await lr.text();
          debugInfo.list_status = lr.status;
          try {
            const lrJson = JSON.parse(lrTxt);
            debugInfo.root_entries = (lrJson.entries || []).map((e: { '.tag': string; name: string; path_display?: string }) => ({ tag: e['.tag'], name: e.name, path_display: e.path_display }));
          } catch {
            debugInfo.list_raw = lrTxt;
          }
        } catch (e) {
          debugInfo.list_error = e instanceof Error ? e.message : String(e);
        }
        return jsonResponse(debugInfo, 200, req);
      }
      if (body?._whoami) {
        try {
          const acctRes = await fetch(`${DROPBOX_API}/users/get_current_account`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const acctTxt = await acctRes.text();
          debugInfo.account_status = acctRes.status;
          try {
            const acct = JSON.parse(acctTxt);
            debugInfo.account_email = acct?.email;
            debugInfo.account_name = acct?.name?.display_name;
            debugInfo.account_type = acct?.account_type?.['.tag'];
            debugInfo.is_team_member = !!acct?.team;
            debugInfo.team_name = acct?.team?.name;
            debugInfo.team_id = acct?.team?.id;
            debugInfo.root_namespace_id = acct?.root_info?.root_namespace_id;
            debugInfo.home_namespace_id = acct?.home_namespace_id;
          } catch {
            debugInfo.account_raw = acctTxt;
          }
        } catch (e) {
          debugInfo.account_error = e instanceof Error ? e.message : String(e);
        }
        return jsonResponse(debugInfo, 200, req);
      }
      if (body.file_path) {
        debugInfo.input_path = body.file_path;
        const m = PROJECTS_PATH_RE.exec(body.file_path);
        debugInfo.regex_matched = !!m;
        debugInfo.regex_project_id = m?.[1] || null;
        // Inline diagnostics — bypass try/catch in resolveProjectShare so we can
        // see exactly which step fails.
        if (m) {
          const adminD = getAdminClient();
          const { data: dProj, error: dErr } = await adminD.from('projects').select('dropbox_root_path, dropbox_root_shared_link').eq('id', m[1]).maybeSingle();
          debugInfo.db_err = dErr?.message || null;
          debugInfo.db_root_path = dProj?.dropbox_root_path || null;
          debugInfo.db_existing_share = dProj?.dropbox_root_shared_link || null;
          if (dProj?.dropbox_root_path && !dProj.dropbox_root_shared_link) {
            try {
              const minted = await getOrCreateSharedLink(dProj.dropbox_root_path as string);
              debugInfo.mint_url_starts = minted.substring(0, 60);
              await adminD.from('projects').update({ dropbox_root_shared_link: minted }).eq('id', m[1]);
            } catch (mintErr) {
              debugInfo.mint_error = mintErr instanceof Error ? mintErr.message : String(mintErr);
            }
          }
        }
        const projShare = await resolveProjectShare(body.file_path).catch((e) => {
          debugInfo.resolver_error = e instanceof Error ? e.message : String(e);
          return null;
        });
        debugInfo.resolver = projShare ? { share_url_starts: projShare.share_url.substring(0, 60), rel_path: projShare.rel_path } : null;
        const useShareUrl = projShare?.share_url || parentShareUrl;
        const relPath = projShare?.rel_path || stripPrefix(body.file_path, pathPrefix);
        debugInfo.use_share_url_starts = useShareUrl ? useShareUrl.substring(0, 60) : null;
        debugInfo.rel_path = relPath;
        try {
          const proxyArg = JSON.stringify({ url: useShareUrl, path: relPath });
          const proxyRes = await fetch(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': proxyArg, ...dbxPathRootHeader() },
          });
          debugInfo.proxy_status = proxyRes.status;
          if (!proxyRes.ok) {
            debugInfo.proxy_body = await proxyRes.text();
          } else {
            await proxyRes.body?.cancel();
            debugInfo.proxy_ok = true;
          }
        } catch (e) {
          debugInfo.proxy_error = e instanceof Error ? e.message : String(e);
        }
      }
      return jsonResponse(debugInfo, 200, req);
    }

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

    // ─── Action: invalidate_cache — clear all cache for a project ───────
    if (action === 'invalidate_cache') {
      const projectId = body.project_id;
      if (!projectId) return errResponse('INVALID_PARAMS', 'project_id required for cache invalidation', 400, req);
      const admin = getAdminClient();
      const { error: delErr, count } = await admin
        .from('media_cache')
        .delete({ count: 'exact' })
        .eq('project_id', projectId);
      if (delErr) {
        console.warn('Cache invalidation error:', delErr.message);
        return errResponse('CACHE_ERROR', 'Failed to invalidate cache', 500, req);
      }
      console.log(`Invalidated ${count ?? 0} cache entries for project ${projectId}`);
      return jsonResponse({ invalidated: count ?? 0 }, 200, req);
    }

    // ─── Action: thumb — cached thumbnail via Supabase Storage + Dropbox API ──
    if (action === 'thumb' && body.file_path) {
      if (!parentShareUrl) return errResponse('CONFIG_ERROR', 'Dropbox share link not configured', 500, req);

      const thumbCacheKey = `thumb::${body.file_path}`;
      const storageKey = thumbStorageKey(body.file_path);

      // 1. Check if thumbnail is cached in Supabase Storage
      const cached = await getCacheEntry(thumbCacheKey);
      if (cached?.blob_path) {
        const admin = getAdminClient();
        const { data: publicUrlData } = admin.storage.from(THUMB_BUCKET).getPublicUrl(cached.blob_path);
        if (publicUrlData?.publicUrl) {
          // Redirect to CDN-served thumbnail — instant response
          return new Response(null, {
            status: 302,
            headers: {
              ...getCorsHeaders(req),
              'Location': publicUrlData.publicUrl,
              'Cache-Control': 'public, max-age=86400',
            },
          });
        }
      }

      // 2. Not cached — fetch from Dropbox.
      // Drone module files live outside the legacy parent share — resolve a
      // per-project shared link first, fall back to the parent share URL.
      const projShare = await resolveProjectShare(body.file_path);
      const useShareUrl = projShare?.share_url || parentShareUrl;
      const relPath = projShare?.rel_path || stripPrefix(body.file_path, pathPrefix);
      const size = body.size || 'w480h320';
      const arg = JSON.stringify({
        resource: { '.tag': 'link', url: useShareUrl, path: relPath },
        format: 'jpeg',
        size,
        mode: 'bestfit',
      });

      let dbxRes: Response;
      let activeToken = token;
      try {
        dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/files/get_thumbnail_v2`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
        });
      } catch (_err: unknown) {
        return errResponse('DROPBOX_TIMEOUT', 'Thumbnail request timed out', 504, req);
      }

      // On 401, refresh token and retry the thumbnail fetch server-side so the
      // client never sees a 503 TOKEN_REFRESHED bounce.
      if (dbxRes.status === 401) {
        const refreshed = await handleTokenExpiry(dbxRes, req);
        if (refreshed && 'newToken' in refreshed) {
          activeToken = refreshed.newToken;
          try {
            dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/files/get_thumbnail_v2`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
            });
          } catch (_err: unknown) {
            return errResponse('DROPBOX_TIMEOUT', 'Thumbnail request timed out', 504, req);
          }
        } else if (refreshed instanceof Response) {
          return refreshed;
        }
      }

      if (dbxRes.ok) {
        // Read the thumbnail bytes so we can both return them AND upload to storage
        const thumbBytes = new Uint8Array(await dbxRes.arrayBuffer());

        // Upload to Supabase Storage in background (don't block the response)
        const uploadPromise = (async () => {
          try {
            await ensureThumbBucket();
            const admin = getAdminClient();
            const { error: uploadErr } = await admin.storage
              .from(THUMB_BUCKET)
              .upload(storageKey, thumbBytes, {
                contentType: 'image/jpeg',
                upsert: true,
              });
            if (uploadErr) {
              console.warn('Thumb upload error:', uploadErr.message);
              return;
            }
            // Store cache entry pointing to the storage path
            await upsertCacheEntry({
              cache_key: thumbCacheKey,
              cache_type: 'thumbnail',
              blob_path: storageKey,
              project_id: body.project_id || undefined,
              expires_at: new Date(Date.now() + THUMB_CACHE_TTL_MS).toISOString(),
            });
          } catch (e) {
            console.warn('Thumb cache write failed:', e instanceof Error ? e.message : e);
          }
        })();

        // Use waitUntil if available (Deno Deploy), otherwise just let it run
        try {
          // deno-lint-ignore no-explicit-any
          (globalThis as any).EdgeRuntime?.waitUntil?.(uploadPromise);
        } catch {
          // Fire and forget — the response is already being sent
        }

        return new Response(thumbBytes, {
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

      // Reuse the same per-project share resolution as the thumbnail attempt.
      const proxyArg = JSON.stringify({ url: useShareUrl, path: relPath });
      let proxyRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': proxyArg, ...dbxPathRootHeader() },
      }, DBX_CONTENT_TIMEOUT_MS);
      // Retry server-side on 401
      if (proxyRes.status === 401) {
        const refreshed = await handleTokenExpiry(proxyRes, req);
        if (refreshed && 'newToken' in refreshed) {
          activeToken = refreshed.newToken;
          proxyRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': proxyArg, ...dbxPathRootHeader() },
          }, DBX_CONTENT_TIMEOUT_MS);
        } else if (refreshed instanceof Response) {
          return refreshed;
        }
      }
      if (!proxyRes.ok) {
        await proxyRes.body?.cancel();
        return errResponse('PROXY_FAILED', 'Could not retrieve file from Dropbox', 502, req);
      }

      // BEFORE downloading the file, check if it's too large for thumbnail fallback
      const cl = proxyRes.headers.get('content-length');
      if (cl && parseInt(cl, 10) > 10_000_000) { // 10MB max for thumbnail fallback
        await proxyRes.body?.cancel();
        return errResponse('THUMB_FALLBACK_TOO_LARGE', 'File too large for thumbnail fallback', 413, req);
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
      const projShare = await resolveProjectShare(body.file_path);
      const useShareUrl = projShare?.share_url || parentShareUrl;
      if (!useShareUrl) return errResponse('CONFIG_ERROR', 'Dropbox share link not configured', 500, req);

      const relPath = projShare?.rel_path || stripPrefix(body.file_path, pathPrefix);
      const arg = JSON.stringify({ url: useShareUrl, path: relPath });

      // Use longer timeout for video content which can be large
      let activeToken = token;
      let dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
      }, DBX_CONTENT_TIMEOUT_MS);

      // Server-side retry on 401 instead of bouncing 503 to client
      if (dbxRes.status === 401) {
        const refreshed = await handleTokenExpiry(dbxRes, req);
        if (refreshed && 'newToken' in refreshed) {
          activeToken = refreshed.newToken;
          dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
          }, DBX_CONTENT_TIMEOUT_MS);
        } else if (refreshed instanceof Response) {
          return refreshed;
        }
      }

      if (!dbxRes.ok) {
        await dbxRes.body?.cancel();
        return errResponse('STREAM_FAILED', 'Could not stream file from Dropbox', 502, req);
      }

      // Enforce size cap on streamed content (same as proxy action)
      const streamCl = dbxRes.headers.get('content-length');
      if (streamCl && parseInt(streamCl, 10) > MAX_PROXY_BYTES) {
        await dbxRes.body?.cancel();
        return errResponse('FILE_TOO_LARGE', 'Requested file exceeds maximum proxy size', 413, req);
      }

      const ct = dbxRes.headers.get('content-type') || 'application/octet-stream';
      const cl = dbxRes.headers.get('content-length');
      const hdrs: Record<string, string> = {
        ...getCorsHeaders(req),
        'Content-Type': ct,
        'Content-Disposition': 'inline',
        // Note: Accept-Ranges not advertised because this proxy does not support
        // Range requests. Video players should use the full download.
        'Cache-Control': 'public, max-age=7200',
      };
      if (cl) hdrs['Content-Length'] = cl;

      return new Response(dbxRes.body, { status: 200, headers: hdrs });
    }

    // ─── Action: proxy — serve full file via parent share link ───────────
    if (action === 'proxy' && body.file_path) {
      const projShare = await resolveProjectShare(body.file_path);
      const useShareUrl = projShare?.share_url || parentShareUrl;
      if (!useShareUrl) return errResponse('CONFIG_ERROR', 'Dropbox share link not configured', 500, req);

      const relPath = projShare?.rel_path || stripPrefix(body.file_path, pathPrefix);
      const arg = JSON.stringify({ url: useShareUrl, path: relPath });

      let activeToken = token;
      let dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
      }, DBX_CONTENT_TIMEOUT_MS);

      // Server-side retry on 401 instead of bouncing 503 to client
      if (dbxRes.status === 401) {
        const refreshed = await handleTokenExpiry(dbxRes, req);
        if (refreshed && 'newToken' in refreshed) {
          activeToken = refreshed.newToken;
          dbxRes = await fetchWithTimeout(`${DROPBOX_CONTENT}/sharing/get_shared_link_file`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${activeToken}`, 'Dropbox-API-Arg': arg, ...dbxPathRootHeader() },
          }, DBX_CONTENT_TIMEOUT_MS);
        } else if (refreshed instanceof Response) {
          return refreshed;
        }
      }

      if (!dbxRes.ok) {
        await dbxRes.body?.cancel();
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

    // ─── Main: list folder contents (with server-side cache) ──────────────
    if (!share_url && !path) return errResponse('INVALID_PARAMS', 'share_url or path required', 400, req);

    const listingCacheKey = `listing::${share_url || path}`;

    // 1. Check media_cache for a non-expired listing (skip if force_refresh)
    const forceRefresh = body.force_refresh === true;
    const cachedListing = forceRefresh ? null : await getCacheEntry(listingCacheKey);
    if (cachedListing?.data) {
      const cachedData = cachedListing.data as Record<string, unknown>;
      cachedData.cached = true;
      cachedData.cached_at = cachedListing.updated_at;

      // If cache is stale (>5 min old), trigger background Dropbox refresh
      if (isCacheStale(cachedListing)) {
        console.log(`Listing cache stale (key=${listingCacheKey}), triggering background refresh`);
        const refreshPromise = (async () => {
          try {
            const freshListing = await fetchListingFromDropbox(
              token, share_url, path, base_path, parentShareUrl, pathPrefix
            );
            // Don't poison the cache with degraded results.  When subfolders
            // 429 we get an empty listing that looks successful — caching
            // that for 30 min locks every downstream view into "Empty folder"
            // until Dropbox cools off AND the TTL expires.
            if (freshListing.degraded) {
              console.warn(
                `Background refresh degraded (key=${listingCacheKey}, reason=${freshListing.degraded_reason}), skipping cache write`,
              );
              return;
            }
            await upsertCacheEntry({
              cache_key: listingCacheKey,
              cache_type: 'listing',
              data: freshListing,
              project_id: body.project_id || undefined,
              expires_at: new Date(Date.now() + LISTING_CACHE_TTL_MS).toISOString(),
            });
            console.log(`Background listing refresh complete (key=${listingCacheKey})`);
          } catch (e) {
            console.warn('Background listing refresh failed:', e instanceof Error ? e.message : e);
          }
        })();
        // Fire and forget — don't block the cached response
        try {
          // deno-lint-ignore no-explicit-any
          (globalThis as any).EdgeRuntime?.waitUntil?.(refreshPromise);
        } catch { /* ignore */ }
      }

      return new Response(JSON.stringify(cachedData), {
        status: 200,
        headers: {
          ...getCorsHeaders(req),
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Cache': isCacheStale(cachedListing) ? 'STALE' : 'HIT',
        },
      });
    }

    // 2. No cache — fetch from Dropbox and store
    //
    // Graceful degradation: if Dropbox is transiently down (timeout / rate limit /
    // network error) the delivery page should still render with an empty state
    // rather than 5xx'ing the user. Return {folders:[], total_files:0, degraded:true}
    // with a short cache so the page is usable and we retry soon. Non-transient
    // errors (config missing, invalid token) still surface as errors.
    let listing: Record<string, unknown>;
    try {
      listing = await fetchListingFromDropbox(
        token, share_url, path, base_path, parentShareUrl, pathPrefix
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('timeout') ||
        msg.includes('rate limited') ||
        msg.includes('Dropbox /files/list_folder 5') || // 5xx from Dropbox
        msg.includes('Dropbox /files/list_folder/continue 5') ||
        msg.includes('fetch failed') ||
        msg.includes('network');

      if (isTransient) {
        console.warn('getDeliveryMediaFeed: Dropbox transient failure, returning empty listing:', msg);
        const degraded = {
          folders: [],
          total_files: 0,
          fetched_at: new Date().toISOString(),
          degraded: true,
          degraded_reason: 'Dropbox temporarily unavailable',
        };
        return new Response(JSON.stringify(degraded), {
          status: 200,
          headers: {
            ...getCorsHeaders(req),
            'Content-Type': 'application/json',
            // Short cache so we retry soon
            'Cache-Control': 'public, max-age=30',
            'X-Cache': 'DEGRADED',
          },
        });
      }
      // Non-transient — rethrow so outer catch emits the right error
      throw err;
    }

    // Store in cache (don't block the response).  Skip when degraded so a
    // partial-failure listing doesn't get pinned for 30 min — every empty
    // listing was being cached as success during Dropbox throttle storms,
    // which is what poisoned every Project Media tab on 2026-05-03.
    const isDegraded = listing.degraded === true;
    if (!isDegraded) {
      const cacheWritePromise = upsertCacheEntry({
        cache_key: listingCacheKey,
        cache_type: 'listing',
        data: listing,
        project_id: body.project_id || undefined,
        expires_at: new Date(Date.now() + LISTING_CACHE_TTL_MS).toISOString(),
      });
      try {
        // deno-lint-ignore no-explicit-any
        (globalThis as any).EdgeRuntime?.waitUntil?.(cacheWritePromise);
      } catch { /* ignore */ }
    } else {
      console.warn(
        `Foreground listing degraded (key=${listingCacheKey}, reason=${listing.degraded_reason}), skipping cache write`,
      );
    }

    return new Response(JSON.stringify(listing), {
      status: 200,
      headers: {
        ...getCorsHeaders(req),
        'Content-Type': 'application/json',
        // Short browser cache for degraded so the user gets a real retry
        // soon; full TTL for healthy listings (matches client-side staleness).
        'Cache-Control': isDegraded ? 'public, max-age=30' : 'public, max-age=300',
        'X-Cache': isDegraded ? 'DEGRADED-PARTIAL' : 'MISS',
      },
    });

  } catch (err: unknown) {
    // Log full error server-side but never expose Dropbox details to the client
    console.error('getDeliveryMediaFeed error:', err);
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('timeout')) {
      return errResponse('DROPBOX_TIMEOUT', 'Dropbox request timed out', 504, req);
    }
    if (msg.includes('invalid_access_token') || msg.includes('expired_access_token')) {
      return errResponse('TOKEN_EXPIRED', 'Dropbox token expired — contact admin', 502, req);
    }
    // 2026-05-03 — surface retry_after_s on Dropbox 429s so the browser
    // can negative-cache for the right duration.  The new dbxPost throws
    // an Error with .dropbox_429=true and .retry_after_s set when we
    // observe a 429 from /files (typically retry_after=300 right now
    // because the app is in adaptive throttle).  Including the seconds
    // hint in the JSON body lets fetchMediaProxy decide how long to
    // suppress further calls for this path.
    const dbx429 = err && typeof err === 'object' && (err as Record<string, unknown>).dropbox_429 === true;
    if (dbx429 || msg.includes('rate limited')) {
      const retryAfterS = (err && typeof err === 'object'
        ? ((err as Record<string, unknown>).retry_after_s as number | null | undefined)
        : null) ?? null;
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'RATE_LIMITED',
          message: 'Dropbox API rate limit reached — try again shortly',
          retry_after_s: retryAfterS,
        }),
        {
          status: 429,
          headers: {
            ...getCorsHeaders(req),
            'Content-Type': 'application/json',
            // Standard Retry-After header so browsers and intermediaries
            // honour the back-off too.
            ...(retryAfterS ? { 'Retry-After': String(retryAfterS) } : {}),
          },
        },
      );
    }
    // Generic message — never echo raw err.message to the client
    return errResponse('INTERNAL_ERROR', 'An internal error occurred while processing the media request', 500, req);
  }
});

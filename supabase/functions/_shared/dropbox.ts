/**
 * Shared Dropbox API client for Edge Functions.
 *
 * Single source of truth for Dropbox auth + low-level API calls. Drone-module
 * Phase 1 lock-in: no direct calls to api.dropboxapi.com or content.dropboxapi.com
 * outside this module. Higher-level project-folder semantics live in
 * `./projectFolders.ts` (which builds on these primitives).
 *
 * Auth: OAuth2 refresh-token flow using DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY
 * + DROPBOX_APP_SECRET secrets. Access tokens are cached at module scope and
 * concurrent refresh calls are deduped via a single in-flight promise.
 *
 * Retry behaviour for `dropboxApi`:
 *   - 401 → refresh token, retry once with new token
 *   - 429 → honour Retry-After (capped 5s), retry up to MAX_ATTEMPTS
 *   - 5xx → exponential backoff (500ms, 1s, 2s), retry up to MAX_ATTEMPTS
 *   - 4xx (other) → throw immediately
 *
 * Used by:
 *   - getDeliveryMediaFeed, getWorkingFilesFeed (refactored Phase 1 PR2)
 *   - projectFolders.ts (PR3) → createProjectFolders, audit mirror
 *   - dropbox-webhook (PR5), dropbox-reconcile (PR6)
 */

const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const DROPBOX_OAUTH = 'https://api.dropboxapi.com/oauth2/token';

const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONTENT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

// ─── Token management ─────────────────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let refreshPromise: Promise<string> | null = null;

/**
 * Returns a valid Dropbox access token, refreshing if needed.
 * Concurrent callers share the same in-flight refresh.
 */
export async function getDropboxAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (cachedAccessToken && !opts?.forceRefresh) return cachedAccessToken;
  return refreshDropboxAccessToken();
}

async function refreshDropboxAccessToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = Deno.env.get('DROPBOX_REFRESH_TOKEN');
    const appKey = Deno.env.get('DROPBOX_APP_KEY');
    const appSecret = Deno.env.get('DROPBOX_APP_SECRET');

    if (!refreshToken || !appKey || !appSecret) {
      throw new Error('Missing DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, or DROPBOX_APP_SECRET');
    }

    const res = await fetch(DROPBOX_OAUTH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(`${appKey}:${appSecret}`),
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Dropbox token refresh failed: ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    cachedAccessToken = data.access_token as string;
    console.log(`[dropbox] token refreshed, expires in ${data.expires_in}s`);
    return cachedAccessToken!;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// ─── Low-level fetch helper ──────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function isExpiredTokenError(status: number, bodyText: string): boolean {
  return status === 401
    || bodyText.includes('expired_access_token')
    || bodyText.includes('invalid_access_token');
}

// ─── RPC API call ─────────────────────────────────────────────────────────────

interface DropboxApiOpts {
  timeoutMs?: number;
  /** Skip retries (useful for idempotency-checking calls). */
  noRetry?: boolean;
}

/**
 * Call a Dropbox RPC endpoint (https://api.dropboxapi.com/2/...).
 * Handles auth, refresh-on-401, 429 backoff, 5xx retry. Returns parsed JSON.
 */
export async function dropboxApi<T = unknown>(
  endpoint: string,
  body: Record<string, unknown> | null,
  opts?: DropboxApiOpts,
): Promise<T> {
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const maxAttempts = opts?.noRetry ? 1 : MAX_ATTEMPTS;

  let token = await getDropboxAccessToken();
  let lastErr = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchWithTimeout(`${DROPBOX_API}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    }, timeoutMs);

    if (res.ok) return res.json() as Promise<T>;

    const txt = await res.text().catch(() => '');
    lastErr = `${res.status}: ${txt.slice(0, 300)}`;

    if (isExpiredTokenError(res.status, txt)) {
      try {
        token = await getDropboxAccessToken({ forceRefresh: true });
        continue;
      } catch (refreshErr) {
        const m = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        throw new Error(`Dropbox auth failed for ${path}: ${m}`);
      }
    }

    if (res.status === 429 && attempt < maxAttempts - 1) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
      const delayMs = Math.min(Math.max(retryAfter, 1), 5) * 1000;
      console.warn(`[dropbox] 429 on ${path}, retrying after ${delayMs}ms (${attempt + 1}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if (res.status >= 500 && res.status < 600 && attempt < maxAttempts - 1) {
      const delayMs = 500 * Math.pow(2, attempt);
      console.warn(`[dropbox] ${res.status} on ${path}, retrying after ${delayMs}ms (${attempt + 1}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if (res.status === 429) {
      throw new Error(`Dropbox rate limited on ${path} — retry shortly`);
    }
    throw new Error(`Dropbox ${path} ${res.status}: ${txt.slice(0, 300)}`);
  }

  throw new Error(`Dropbox ${path} exhausted ${maxAttempts} attempts: ${lastErr}`);
}

// ─── Content API call (binary) ───────────────────────────────────────────────

interface DropboxContentOpts {
  timeoutMs?: number;
}

/**
 * Call a Dropbox Content endpoint (https://content.dropboxapi.com/2/...).
 * Used for binary uploads/downloads/thumbnails. Returns the raw Response so
 * the caller can stream/read it.
 *
 * The `args` object is JSON-serialised into the `Dropbox-API-Arg` header
 * (per Dropbox content API convention). `body` is the raw bytes; null for
 * download endpoints, ArrayBuffer/Uint8Array/string for upload.
 */
export async function dropboxContent(
  endpoint: string,
  args: Record<string, unknown>,
  body: BodyInit | null = null,
  opts?: DropboxContentOpts,
): Promise<Response> {
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONTENT_TIMEOUT_MS;

  let token = await getDropboxAccessToken();
  let attempt = 0;

  while (true) {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify(args),
    };
    if (body !== null) headers['Content-Type'] = 'application/octet-stream';

    const res = await fetchWithTimeout(`${DROPBOX_CONTENT}${path}`, {
      method: 'POST',
      headers,
      body,
    }, timeoutMs);

    if (res.ok) return res;

    // Peek at body for token-expiry detection without consuming if we'll retry.
    const txt = await res.text().catch(() => '');

    if (attempt === 0 && isExpiredTokenError(res.status, txt)) {
      token = await getDropboxAccessToken({ forceRefresh: true });
      attempt++;
      continue;
    }

    throw new Error(`Dropbox ${path} ${res.status}: ${txt.slice(0, 300)}`);
  }
}

// ─── High-level folder operations (used by projectFolders.ts) ────────────────

export interface DropboxFolderMetadata {
  id: string;
  name: string;
  path_lower: string;
  path_display: string;
}

export interface DropboxFileMetadata {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
  content_hash?: string;
}

/**
 * Create a folder. Idempotent: returns existing folder metadata if it
 * already exists (Dropbox `path/conflict/folder` error is treated as success).
 */
export async function createFolder(path: string): Promise<DropboxFolderMetadata> {
  try {
    const res = await dropboxApi<{ metadata: DropboxFolderMetadata }>('/files/create_folder_v2', {
      path,
      autorename: false,
    });
    return res.metadata;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Already-exists is success for our use case.
    if (msg.includes('path/conflict/folder')) {
      const meta = await getMetadata(path);
      return meta as DropboxFolderMetadata;
    }
    throw err;
  }
}

/** Get metadata for a path (file or folder). */
export async function getMetadata(path: string): Promise<DropboxFileMetadata | DropboxFolderMetadata> {
  return dropboxApi('/files/get_metadata', { path });
}

interface ListFolderResult {
  entries: DropboxFileMetadata[];
  has_more: boolean;
  cursor: string;
}

/**
 * List a folder, paginated. Returns all entries up to `maxEntries` (default 5000).
 * Set `recursive: true` to list subfolders too.
 *
 * The returned `cursor` is always the latest one — even when pagination has
 * fully drained — so callers doing delta tracking (webhook + reconcile) can
 * pass it to `listFolderContinue` later to receive only changes since this
 * point. `truncated=true` indicates we hit `maxEntries` mid-stream.
 */
export async function listFolder(
  path: string,
  opts?: { recursive?: boolean; maxEntries?: number },
): Promise<{ entries: DropboxFileMetadata[]; truncated: boolean; cursor: string }> {
  const max = opts?.maxEntries ?? 5000;
  const first = await dropboxApi<ListFolderResult>('/files/list_folder', {
    path,
    recursive: opts?.recursive ?? false,
    include_deleted: false,
    limit: 2000,
  });

  let entries = first.entries;
  let cursor = first.cursor;
  let hasMore = first.has_more;
  let truncated = false;

  while (hasMore && entries.length < max) {
    const next = await dropboxApi<ListFolderResult>('/files/list_folder/continue', { cursor });
    entries = entries.concat(next.entries);
    cursor = next.cursor;
    hasMore = next.has_more;
    if (entries.length >= max) {
      truncated = true;
      break;
    }
  }
  return { entries, truncated, cursor };
}

/** Continue a list_folder cursor (used by reconcile). */
export async function listFolderContinue(cursor: string): Promise<ListFolderResult> {
  return dropboxApi<ListFolderResult>('/files/list_folder/continue', { cursor });
}

/** Move (rename) a file or folder. */
export async function moveFile(fromPath: string, toPath: string): Promise<DropboxFileMetadata> {
  const res = await dropboxApi<{ metadata: DropboxFileMetadata }>('/files/move_v2', {
    from_path: fromPath,
    to_path: toPath,
    autorename: false,
  });
  return res.metadata;
}

/**
 * Get an existing shared link for a path, or create one if none exists.
 * Returns the public URL.
 */
export async function getOrCreateSharedLink(path: string): Promise<string> {
  // Try existing first — cheaper than create when one already exists.
  const existing = await dropboxApi<{ links: Array<{ url: string }> }>('/sharing/list_shared_links', {
    path,
    direct_only: true,
  });
  if (existing.links.length > 0) return existing.links[0].url;

  const created = await dropboxApi<{ url: string }>('/sharing/create_shared_link_with_settings', {
    path,
    settings: { requested_visibility: 'team_only' },
  });
  return created.url;
}

/**
 * Upload a file. `mode` controls conflict behaviour:
 *   - 'add' (default): fail if file exists
 *   - 'overwrite': replace existing file
 *   - 'update': only overwrite if rev matches
 */
export async function uploadFile(
  path: string,
  body: ArrayBuffer | Uint8Array | string,
  mode: 'add' | 'overwrite' = 'add',
): Promise<DropboxFileMetadata> {
  const res = await dropboxContent('/files/upload', {
    path,
    mode,
    autorename: false,
    mute: true,
  }, body);
  return res.json();
}

/** Download a file. Returns the raw Response (caller streams or reads body). */
export async function downloadFile(path: string): Promise<Response> {
  return dropboxContent('/files/download', { path });
}

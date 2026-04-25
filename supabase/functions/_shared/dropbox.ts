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

// Module-scoped — assumes single-tenant Dropbox (FlexStudios is single-tenant).
// If FlexStudios ever multi-tenants, key by tenant_id (Map<tenantId, token>).
// (#56 audit — kept as-is intentionally.)
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

/**
 * Window during which a freshly-resolved refresh promise is still shared with
 * concurrent callers. Picked to be long enough that requests arriving within
 * the same "burst" share the in-flight refresh, but short enough that a stale
 * cached promise never blocks a future refresh attempt.
 *
 * (#57 audit fix.)
 */
const REFRESH_PROMISE_TTL_MS = 1000;

async function refreshDropboxAccessToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  // Kick off the refresh and assign immediately so concurrent callers see it.
  const local = (async () => {
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

  refreshPromise = local;

  // Schedule cleanup AFTER a short window so a second-but-quickly-arrived
  // caller still finds and shares this in-flight promise. (#57 audit fix.)
  // The previous `finally { refreshPromise = null; }` raced — by the time the
  // first caller reached `finally`, a second caller blocked behind it would
  // see `null` and kick off a duplicate refresh. We must NOT null the promise
  // synchronously on completion. If the refresh fails, we still want to clear
  // it so the next caller can retry — handled by attaching the timer
  // unconditionally.
  local
    .catch(() => { /* swallow here; original caller awaits and re-throws */ })
    .finally(() => {
      setTimeout(() => {
        // Only null if we're still pointing at THIS promise. A subsequent
        // refresh (e.g. another forceRefresh) would have already reassigned.
        if (refreshPromise === local) refreshPromise = null;
      }, REFRESH_PROMISE_TTL_MS);
    });

  return local;
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
/**
 * Path-root header for team-folder access.
 *
 * On a Dropbox Business account, calls default to the user's personal home
 * namespace (where their My Files live). Team folders sit in the team root
 * namespace and are only visible if every API call carries:
 *
 *   Dropbox-API-Path-Root: {".tag":"root","root":"<team_root_namespace_id>"}
 *
 * Set DROPBOX_TEAM_NAMESPACE_ID = the team's root_namespace_id (from
 * /users/get_current_account → root_info.root_namespace_id) to enable.
 */
function pathRootHeader(): Record<string, string> {
  const ns = Deno.env.get('DROPBOX_TEAM_NAMESPACE_ID');
  if (!ns) return {};
  return { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: ns }) };
}

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
        ...pathRootHeader(),
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
  let refreshed = false;
  let lastErr = '';

  // (#58 audit fix) Bounded loop with 5xx exponential backoff matching
  // dropboxApi. Previously a 5xx on the content endpoint would throw on the
  // first attempt — uploads/downloads of binary blobs would lose to transient
  // upstream blips. We honour MAX_ATTEMPTS overall, with one extra slot
  // reserved for the post-refresh retry on 401.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify(args),
      ...pathRootHeader(),
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
    lastErr = `${res.status}: ${txt.slice(0, 300)}`;

    if (!refreshed && isExpiredTokenError(res.status, txt)) {
      token = await getDropboxAccessToken({ forceRefresh: true });
      refreshed = true;
      // Don't count this as one of the retry attempts — back off the loop
      // counter so we still get MAX_ATTEMPTS retries on the new token.
      attempt--;
      continue;
    }

    if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '2', 10);
      const delayMs = Math.min(Math.max(retryAfter, 1), 5) * 1000;
      console.warn(`[dropbox-content] 429 on ${path}, retrying after ${delayMs}ms (${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = 500 * Math.pow(2, attempt);
      console.warn(`[dropbox-content] ${res.status} on ${path}, retrying after ${delayMs}ms (${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    throw new Error(`Dropbox ${path} ${res.status}: ${txt.slice(0, 300)}`);
  }

  throw new Error(`Dropbox ${path} exhausted ${MAX_ATTEMPTS} attempts: ${lastErr}`);
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
 * Delete a file or folder. Idempotent: a path/not_found error is treated as
 * success (file already gone). Used by drone-render-approve when un-approving
 * a Final render to clean up the orphaned copy in 07_FINAL_DELIVERY/drones/.
 */
export async function deleteFile(path: string): Promise<void> {
  try {
    await dropboxApi('/files/delete_v2', { path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('path_lookup/not_found') || msg.includes('not_found')) return;
    throw err;
  }
}

/**
 * Copy a file or folder. Used by drone-render-approve to promote a render
 * from 06_ENRICHMENT/drone_renders_proposed/ to 07_FINAL_DELIVERY/drones/
 * while preserving the original.
 *
 * If the destination exists we delete-then-copy rather than autorename. The
 * previous autorename:true left orphans on un-approve/re-approve cycles —
 * 07_FINAL_DELIVERY/drones/foo.jpg, foo (1).jpg, foo (2).jpg... and the DB
 * only tracks the first path, so cleanup misses the siblings. (#22 audit fix)
 */
export async function copyFile(fromPath: string, toPath: string): Promise<DropboxFileMetadata> {
  try {
    return await tryCopy(fromPath, toPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // path/conflict/file: dest exists → overwrite by deleting first then re-copying.
    if (msg.includes('to/conflict') || msg.includes('path/conflict') || msg.includes('conflict/file')) {
      await deleteFile(toPath);
      return await tryCopy(fromPath, toPath);
    }
    throw err;
  }
}

async function tryCopy(fromPath: string, toPath: string): Promise<DropboxFileMetadata> {
  const res = await dropboxApi<{ metadata: DropboxFileMetadata }>('/files/copy_v2', {
    from_path: fromPath,
    to_path: toPath,
    autorename: false,
    allow_shared_folder: false,
    allow_ownership_transfer: false,
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

  // Omit `settings` entirely — explicit `requested_visibility: team_only` returns
  // settings_error/not_authorized on apps without team-link scope. Default
  // visibility is whatever the workspace policy allows.
  //
  // (#59 audit — design decision deferred.) The default link visibility
  // depends on the team's Dropbox sharing policy: it can be public-with-link
  // (anyone with URL), team-only, or password-protected. If FlexStudios ever
  // tightens the policy or wants enforced team-only links, request the
  // `team_collaboration.write` / sharing-team scope on the app and pass
  // `settings.requested_visibility = "team_only"`. Joseph to audit later.
  const created = await dropboxApi<{ url: string }>('/sharing/create_shared_link_with_settings', {
    path,
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
  // Dropbox WriteMode is a tagged union: { ".tag": "overwrite" } etc.
  // Bare string fails with: HTTP header "Dropbox-API-Arg": mode: missing '.tag' key
  const res = await dropboxContent('/files/upload', {
    path,
    mode: { '.tag': mode },
    autorename: false,
    mute: true,
  }, body);
  return res.json();
}

/** Download a file. Returns the raw Response (caller streams or reads body). */
export async function downloadFile(path: string): Promise<Response> {
  return dropboxContent('/files/download', { path });
}

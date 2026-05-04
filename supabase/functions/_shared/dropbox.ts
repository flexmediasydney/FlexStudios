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
// 2026-05-04 — split-app architecture.  We now run TWO Dropbox OAuth apps:
//
//   'ui'      → the original `flexmedia` app (legacy, default).  Powers all
//               UI surfaces: Project Media tab, Live Media Feed, drone
//               browse, lightboxes, etc.  Currently in adaptive-throttle
//               watch mode after yesterday's investigation burst — recovery
//               will take time.
//
//   'engine'  → the new `flexmedia-engine` app.  Powers shortlisting engine
//               traffic: ingest link-bake, Modal CR3 fetch, Pass 0 vision,
//               shortlist-lock moveBatch.  Fresh reputation, can run rounds
//               without fighting the UI's throttle.
//
// Tokens are cached per-app so a UI 401 doesn't refresh the engine token
// (and vice versa).  Same `refreshPromise` dedup pattern is applied per
// app to avoid burst refresh storms when many concurrent callers request
// the same token type.
type DropboxApp = 'engine' | 'ui';

const cachedAccessTokens: Record<DropboxApp, string | null> = {
  engine: null,
  ui: null,
};
const refreshPromises: Record<DropboxApp, Promise<string> | null> = {
  engine: null,
  ui: null,
};

export interface DropboxTokenOpts {
  forceRefresh?: boolean;
  /** Which Dropbox OAuth app's token to mint.  Defaults to 'ui' (original
   *  app — backward-compat with all existing UI / drone / webhook callers). */
  app?: DropboxApp;
}

/**
 * Returns a valid Dropbox access token for the requested app, refreshing
 * if needed.  Concurrent callers for the same app share the same in-flight
 * refresh.  Different apps have independent token caches.
 */
export async function getDropboxAccessToken(opts?: DropboxTokenOpts): Promise<string> {
  const app = opts?.app ?? 'ui';
  if (cachedAccessTokens[app] && !opts?.forceRefresh) return cachedAccessTokens[app]!;
  return refreshDropboxAccessToken(app);
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

async function refreshDropboxAccessToken(app: DropboxApp): Promise<string> {
  const inflight = refreshPromises[app];
  if (inflight) return inflight;

  // Pick the env var triplet for the requested app.  Engine app uses the
  // DROPBOX_ENGINE_* prefix; UI uses the original (unprefixed) names.  We
  // allow the engine app vars to fall back to the UI vars when missing
  // (single-app deploys / dev environments where only one app is set up).
  const envKeys = app === 'engine'
    ? {
        refreshToken: 'DROPBOX_ENGINE_REFRESH_TOKEN',
        appKey: 'DROPBOX_ENGINE_APP_KEY',
        appSecret: 'DROPBOX_ENGINE_APP_SECRET',
      }
    : {
        refreshToken: 'DROPBOX_REFRESH_TOKEN',
        appKey: 'DROPBOX_APP_KEY',
        appSecret: 'DROPBOX_APP_SECRET',
      };

  // Kick off the refresh and assign immediately so concurrent callers see it.
  const local = (async () => {
    const refreshToken = Deno.env.get(envKeys.refreshToken);
    const appKey = Deno.env.get(envKeys.appKey);
    const appSecret = Deno.env.get(envKeys.appSecret);

    if (!refreshToken || !appKey || !appSecret) {
      throw new Error(
        `Missing ${envKeys.refreshToken}, ${envKeys.appKey}, or ${envKeys.appSecret} ` +
          `(needed for app='${app}').`,
      );
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
      throw new Error(`Dropbox token refresh failed (app=${app}): ${res.status} ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    cachedAccessTokens[app] = data.access_token as string;
    console.log(`[dropbox] token refreshed (app=${app}), expires in ${data.expires_in}s`);
    return cachedAccessTokens[app]!;
  })();

  refreshPromises[app] = local;

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
        if (refreshPromises[app] === local) refreshPromises[app] = null;
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
  /**
   * Which Dropbox OAuth app to authenticate as.  Defaults to 'ui' (the
   * original app, used by all UI surfaces and webhooks).  Engine paths
   * (shortlisting-extract, shortlisting-ingest, shortlisting-pass0,
   * shortlist-lock) pass 'engine' so they hit the fresh-reputation
   * `flexmedia-engine` app and bypass the UI app's adaptive throttle.
   */
  app?: DropboxApp;
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
  const app = opts?.app ?? 'ui';

  let token = await getDropboxAccessToken({ app });
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
        token = await getDropboxAccessToken({ forceRefresh: true, app });
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
  /** See DropboxApiOpts.app — same semantics for content endpoints. */
  app?: DropboxApp;
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
  const app = opts?.app ?? 'ui';

  let token = await getDropboxAccessToken({ app });
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
      token = await getDropboxAccessToken({ forceRefresh: true, app });
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

/**
 * Get metadata for many paths in ONE Dropbox API call.
 *
 * Wraps `/files/get_metadata_batch`.  Synchronous (returns inline, no async
 * job to poll).  Each input path produces a corresponding entry in the
 * output array, in the SAME order, with one of three shapes:
 *   - `{ '.tag': 'metadata', metadata: {...} }`  → present
 *   - `{ '.tag': 'metadata', metadata: { '.tag': 'deleted', ... } }` → tombstoned
 *   - `{ '.tag': 'access_error' | 'path_lookup_error', ... }` → not found / permission
 *
 * 2026-05-04 — added to replace the per-path `getMetadata` loop in
 * `projectFolders.ts` post-verify (was 23 sequential calls per project on
 * the slow path).  Single batch call drops that to 1.  Cap is 100 paths
 * per batch per Dropbox docs; callers chunk if they exceed it.
 */
export interface DropboxMetadataBatchEntry {
  '.tag': 'metadata' | 'access_error' | 'path_lookup_error' | 'failure';
  metadata?: DropboxFileMetadata | DropboxFolderMetadata | { '.tag': 'deleted'; name: string; path_lower?: string };
  access_error?: unknown;
  path_lookup_error?: unknown;
}

export async function getMetadataBatch(paths: string[]): Promise<DropboxMetadataBatchEntry[]> {
  if (paths.length === 0) return [];
  if (paths.length > 100) {
    // Dropbox cap.  Caller responsibility to chunk; we just enforce defensively.
    throw new Error(`getMetadataBatch: max 100 paths per batch (got ${paths.length})`);
  }
  return dropboxApi<DropboxMetadataBatchEntry[]>('/files/get_metadata_batch', {
    paths,
  });
}

/**
 * Create many folders in ONE Dropbox API call.
 *
 * Wraps `/files/create_folder_batch_v2`.  May complete sync (small batches)
 * OR return an async_job_id (large batches, server-side queueing).  This
 * helper auto-handles the async case by polling `/files/create_folder_batch/check_v2`
 * until terminal — caller just awaits and gets the final entries.
 *
 * 2026-05-04 — added to replace the 9-call sequential `createFolder` loop
 * in `provisionProjectFolders` (1 root + ~3 intermediates + ~5 leaves +
 * _AUDIT/events) with one batch call per project provision.
 *
 * Idempotency mirrors `createFolder`: if any folder already exists, the
 * batch entry has `.tag: 'failure'` with a `path/conflict/folder`
 * sub-tag.  We treat that as success and return the existing folder's
 * metadata via a follow-up `getMetadata` lookup.  Net: same idempotency
 * guarantee as the per-path version, in 1-2 API calls instead of N+M.
 */
export interface DropboxCreateFolderBatchEntry {
  '.tag': 'success' | 'failure';
  metadata?: DropboxFolderMetadata;
  failure?: { '.tag': string; [key: string]: unknown };
}

interface CreateFolderBatchAsyncResult {
  '.tag': 'complete' | 'async_job_id' | 'other';
  entries?: DropboxCreateFolderBatchEntry[];
  async_job_id?: string;
}

interface CreateFolderBatchCheckResult {
  '.tag': 'in_progress' | 'complete' | 'failed' | 'other';
  entries?: DropboxCreateFolderBatchEntry[];
}

export async function createFolderBatch(paths: string[]): Promise<DropboxCreateFolderBatchEntry[]> {
  if (paths.length === 0) return [];
  if (paths.length > 1000) {
    throw new Error(`createFolderBatch: max 1000 paths per batch (got ${paths.length})`);
  }
  const submit = await dropboxApi<CreateFolderBatchAsyncResult>(
    '/files/create_folder_batch_v2',
    { paths, autorename: false, force_async: false },
  );

  if (submit['.tag'] === 'complete' && submit.entries) {
    return submit.entries;
  }
  if (submit['.tag'] !== 'async_job_id' || !submit.async_job_id) {
    throw new Error(`createFolderBatch: unexpected submit result tag '${submit['.tag']}'`);
  }

  // Poll the async job.  Folder creation is fast — most batches complete in
  // <2s.  Cap polling at 30s so we don't hang forever on a stuck job.
  const jobId = submit.async_job_id;
  const POLL_INTERVAL_MS = 1000;
  const POLL_MAX_ATTEMPTS = 30;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const check = await dropboxApi<CreateFolderBatchCheckResult>(
      '/files/create_folder_batch/check_v2',
      { async_job_id: jobId },
    );
    if (check['.tag'] === 'complete' && check.entries) {
      return check.entries;
    }
    if (check['.tag'] === 'failed') {
      throw new Error(`createFolderBatch: async job ${jobId} failed`);
    }
    // 'in_progress' — keep polling
  }
  throw new Error(
    `createFolderBatch: async job ${jobId} did not complete within ` +
      `${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`,
  );
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

// ─── Batch move (async) ──────────────────────────────────────────────────────
//
// Wave 7 P0-1: Dropbox `/files/move_batch_v2` accepts up to 10,000 entries per
// call and returns either:
//   - { '.tag': 'complete', entries: [...] }  — small batches resolve sync
//   - { '.tag': 'async_job_id', async_job_id: 'dbjid:abc...' } — most batches
//     return async; caller polls /files/move_batch/check_v2 until complete.
//
// Used by shortlist-lock (was per-file /files/move_v2 in a 6-worker loop;
// timed out at the 150s edge gateway window for >50-file rounds). The async
// pattern lets us submit all moves in <1s and poll for completion from
// EdgeRuntime.waitUntil() in the background while returning the async_job_id
// to the frontend immediately for live progress polling.

export interface DropboxMoveEntry {
  from_path: string;
  to_path: string;
}

export interface DropboxBatchEntryResult {
  '.tag': 'success' | 'failure';
  // success path: full metadata
  success?: DropboxFileMetadata;
  // failure path: tagged union — `.tag` is one of 'from_lookup'|'from_write'|'to'|'too_many_write_operations'
  // and the inner shape varies by tag.
  failure?: {
    '.tag': string;
    from_lookup?: { '.tag': string };
    from_write?: { '.tag': string };
    to?: { '.tag': string };
    [key: string]: unknown;
  };
}

export interface DropboxMoveBatchSubmitResult {
  '.tag': 'complete' | 'async_job_id' | 'other';
  async_job_id?: string;
  entries?: DropboxBatchEntryResult[];
}

export interface DropboxMoveBatchCheckResult {
  '.tag': 'in_progress' | 'complete' | 'failed' | 'other';
  entries?: DropboxBatchEntryResult[];
  // failure case: the same failure shape as a per-entry failure but at the
  // top level — Dropbox surfaces a per-call write conflict here.
  failure?: {
    '.tag': string;
    [key: string]: unknown;
  };
}

/**
 * Submit a batch move. Returns either an inline `complete` result (small
 * batches) or an `async_job_id` to poll. Up to 10,000 entries per call —
 * for larger batches the caller must chunk.
 *
 * Failures inside the batch are NOT thrown — they appear as per-entry results
 * with `.tag === 'failure'`. Callers must inspect the result list to count
 * succeeded/failed moves.
 */
export async function moveBatch(
  entries: DropboxMoveEntry[],
  opts?: { app?: DropboxApp },
): Promise<DropboxMoveBatchSubmitResult> {
  if (entries.length === 0) {
    return { '.tag': 'complete', entries: [] };
  }
  if (entries.length > 10_000) {
    throw new Error(
      `moveBatch: got ${entries.length} entries, Dropbox cap is 10,000 per call — caller must chunk`,
    );
  }
  return dropboxApi<DropboxMoveBatchSubmitResult>(
    '/files/move_batch_v2',
    {
      entries,
      autorename: false,
      allow_ownership_transfer: false,
    },
    { app: opts?.app },
  );
}

/**
 * Poll a batch-move job. Returns the current status. Caller is expected to
 * handle the .tag === 'in_progress' case by sleeping + retrying.
 *
 * Note on costs: each /files/move_batch/check_v2 call is one Dropbox API
 * unit. We poll every ~3s, so a 60s lock = ~20 polls. Not free, but cheap
 * vs. the per-file move spam we replace.
 */
export async function checkMoveBatch(
  jobId: string,
  opts?: { app?: DropboxApp },
): Promise<DropboxMoveBatchCheckResult> {
  return dropboxApi<DropboxMoveBatchCheckResult>(
    '/files/move_batch/check_v2',
    { async_job_id: jobId },
    { app: opts?.app },
  );
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
  }, body as BodyInit);  // Uint8Array<ArrayBufferLike> narrowing isn't picked up by Deno's stricter TS — cast is safe; runtime accepts all three branches.
  return res.json();
}

/** Download a file. Returns the raw Response (caller streams or reads body). */
export async function downloadFile(path: string): Promise<Response> {
  return dropboxContent('/files/download', { path });
}

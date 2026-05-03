/**
 * mediaPerf.js — Shared media performance utilities
 *
 * Provides:
 * 1. LRU blob cache with configurable max size and proper URL.revokeObjectURL cleanup
 * 2. Global fetch concurrency limiter to prevent overwhelming Dropbox/Supabase
 * 3. Image decode helper to avoid main-thread jank
 *
 * All media components should use these shared utilities instead of
 * creating their own ad-hoc caches and queues.
 */

// ─── LRU Blob Cache ─────────────────────────────────────────────────────────
// Map preserves insertion order; we move accessed keys to the end (most recent).
// When size exceeds max, we evict from the front (oldest).

export class LRUBlobCache {
  constructor(maxSize = 200) {
    this._map = new Map();
    this._max = maxSize;
  }

  has(key) {
    return this._map.has(key);
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    // Move to end (most recently used)
    const value = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    // If key already exists, delete first to re-insert at end
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    this._map.set(key, value);
    this._evict();
  }

  delete(key) {
    const value = this._map.get(key);
    if (value) URL.revokeObjectURL(value);
    return this._map.delete(key);
  }

  get size() {
    return this._map.size;
  }

  entries() {
    return this._map.entries();
  }

  keys() {
    return this._map.keys();
  }

  /** Evict oldest entries when over capacity, revoking blob URLs */
  _evict() {
    while (this._map.size > this._max) {
      const oldestKey = this._map.keys().next().value;
      const oldUrl = this._map.get(oldestKey);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      this._map.delete(oldestKey);
    }
  }

  /** Evict entries matching a prefix, useful for project-scoped cleanup */
  evictByPrefix(prefix) {
    for (const [key, url] of this._map) {
      if (key.startsWith(prefix)) {
        URL.revokeObjectURL(url);
        this._map.delete(key);
      }
    }
  }

  /** Clear entire cache, revoking all blob URLs */
  clear() {
    for (const url of this._map.values()) {
      URL.revokeObjectURL(url);
    }
    this._map.clear();
  }
}

// Shared singleton — all media components should use this instead of creating their own
export const SHARED_THUMB_CACHE = new LRUBlobCache(500);


// ─── Global Fetch Concurrency Limiter ────────────────────────────────────────
// Prevents all media views from collectively overwhelming Dropbox/Supabase.
// Individual per-component queues MUST use this instead of their own counters.

const GLOBAL_MAX_CONCURRENT = 20; // Max simultaneous fetches across ALL views
let _globalActive = 0;
const _globalQueue = [];

// (W5 P1 #4) Removed the global setInterval safety reaper. The previous
// implementation decremented _globalActive even when the original fetch was
// still in flight; the original's `finally` then decremented again with no
// `Math.max(0, …)` guard → counter went negative → the gate
// `_globalActive < GLOBAL_MAX_CONCURRENT` always passed → unbounded
// concurrency → Dropbox 429 cascade under load. Replaced with per-request
// timeout-based reaping (a single boolean per job ensures decrement runs
// at most once), and the finally clamps with Math.max(0, …) defensively.

function _processGlobalQueue() {
  while (_globalActive < GLOBAL_MAX_CONCURRENT && _globalQueue.length > 0) {
    const { job, resolve, reject } = _globalQueue.shift();
    _globalActive++;
    // Single-shot release: whichever path fires first (success/failure or
    // timeout) decrements once and disarms the other path.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      _globalActive = Math.max(0, _globalActive - 1);
      _processGlobalQueue();
    };
    // 30s safety timeout — if the job never settles (network stuck), reap it.
    // Only wire up in browser environments to avoid SSR/test leaks.
    const timeout =
      typeof window !== 'undefined'
        ? setTimeout(() => {
            release();
          }, 30000)
        : null;
    job()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        release();
      });
  }
}

/**
 * Enqueue an async job through the global concurrency limiter.
 * Returns a promise that resolves/rejects with the job's result.
 *
 * @param {() => Promise<T>} job - Async function to execute
 * @returns {Promise<T>}
 */
export function enqueueFetch(job) {
  return new Promise((resolve, reject) => {
    _globalQueue.push({ job, resolve, reject });
    _processGlobalQueue();
  });
}

/** Current number of active fetches (for debugging/monitoring) */
export function getActiveFetchCount() {
  return _globalActive;
}

/** Current queue depth (for debugging/monitoring) */
export function getFetchQueueDepth() {
  return _globalQueue.length;
}


// ─── Image Decode Helper ─────────────────────────────────────────────────────
// Uses HTMLImageElement.decode() to decode off main thread, avoiding jank
// when large thumbnails are added to the DOM.

/**
 * Preload and decode an image URL before displaying it.
 * Falls back gracefully if decode() is not supported.
 *
 * @param {string} url - Blob URL or HTTP URL to decode
 * @returns {Promise<string>} The same URL, resolved after decode completes
 */
export function decodeImage(url) {
  if (!url) return Promise.resolve(url);
  return new Promise((resolve) => {
    const img = new Image();
    img.src = url;
    if (typeof img.decode === 'function') {
      img.decode()
        .then(() => resolve(url))
        .catch(() => resolve(url)); // fallback: still usable even if decode fails
    } else {
      // Browser doesn't support decode() — resolve immediately
      resolve(url);
    }
  });
}


// ─── Shared Proxy Fetch ─────────────────────────────────────────────────────
// Centralized function for fetching media through the edge function proxy.
// Handles caching, retry on token refresh (503), and blob URL management.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
// Map of cacheKey → Promise<string|null> for in-flight dedup
// When multiple components request the same file simultaneously,
// they all await the SAME promise instead of getting null or firing duplicate fetches.
const _inflight = new Map();

// Negative-cache for failed fetches.  Keyed by cacheKey.  Each entry is
// `{ failedAt: epoch_ms, kind: 'rate_limited' | 'other', retryAfterMs: number }`.
//
// 2026-05-03 hotfix — when the Dropbox app reputation is in adaptive
// throttle (current state today after the engine investigation that
// fired ~186 jobs at the API), `getDeliveryMediaFeed` reliably 429s
// with `retry_after: 300`.  Without negative-caching, every component
// remount, every navigation, every re-hover fires another live request
// → each premature retry RESETS the cool-off → bucket stays hot
// indefinitely.  We respect the retry_after by suppressing further
// fetches for the same path until the window has elapsed.
//
// Cap any single neg-cache TTL at 10 min so we always retry eventually,
// even if Dropbox sent a wildly long retry_after.
const _negCache = new Map();
const NEG_CACHE_MAX_TTL_MS = 10 * 60 * 1000;
const NEG_CACHE_DEFAULT_RATE_LIMITED_MS = 60 * 1000;
const NEG_CACHE_DEFAULT_OTHER_MS = 5 * 1000;

function _negCacheCheck(cacheKey) {
  const entry = _negCache.get(cacheKey);
  if (!entry) return null;
  const elapsed = Date.now() - entry.failedAt;
  if (elapsed >= entry.retryAfterMs) {
    _negCache.delete(cacheKey);
    return null;
  }
  return entry;
}

function _negCacheSet(cacheKey, kind, retryAfterMs) {
  _negCache.set(cacheKey, {
    failedAt: Date.now(),
    kind,
    retryAfterMs: Math.min(retryAfterMs, NEG_CACHE_MAX_TTL_MS),
  });
}

/**
 * Fetch a media file through the edge function proxy.
 * Deduplicates concurrent requests — if the same file is already being fetched,
 * returns the existing promise instead of firing a duplicate.
 *
 * @param {LRUBlobCache} cache - The blob cache to use
 * @param {string} filePath - Full Dropbox path
 * @param {'thumb'|'proxy'|'stream_url'} mode - Fetch mode
 * @param {number} retries - Retry count for 503/429 errors
 * @returns {Promise<string|null>} Blob URL or null
 */
export function fetchMediaProxy(cache, filePath, mode = 'thumb', retries = 2) {
  const cacheKey = `${mode}::${filePath}`;

  // Wave 2: Supabase Storage pass-through.
  // Shortlisting previews are now stored in a public Supabase Storage
  // bucket and surfaced as direct https:// URLs. There's no auth or
  // rate-limit concern, so we skip the Edge proxy entirely and let
  // the browser <img src> the URL directly. We still cache so callers
  // get the same string back on the second hit (avoids React jitter).
  if (typeof filePath === 'string' && /^https?:\/\//i.test(filePath)) {
    if (!cache.has(cacheKey)) cache.set(cacheKey, filePath);
    return Promise.resolve(filePath);
  }

  // Layer 1: Already cached blob URL
  if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));

  // Layer 1b: Negative-cache hit — recent fetch failed, don't retry yet.
  // This is the critical fix for the Dropbox-throttle compounding loop:
  // a remount or click-spam could otherwise refire the request and each
  // premature retry resets Dropbox's cool-off window.  Returning null
  // immediately tells callers "use the errored UI state"; they can call
  // getMediaFailureInfo() to learn why.
  if (_negCacheCheck(cacheKey)) return Promise.resolve(null);

  // Layer 2: Already in-flight — return the SAME promise (critical dedup fix)
  if (_inflight.has(cacheKey)) return _inflight.get(cacheKey);

  // Layer 3: Start new fetch (Dropbox-rooted paths still go through
  // the getDeliveryMediaFeed Edge proxy for token-handled blob serving)
  const promise = _doFetch(cache, cacheKey, filePath, mode, retries);
  _inflight.set(cacheKey, promise);
  // Clean up in-flight map when done (success or failure)
  promise.finally(() => _inflight.delete(cacheKey));
  return promise;
}

/**
 * Look up why the last fetch for `filePath` (in this `mode`) failed.
 *
 * Used by lightbox / card components to render a useful message instead
 * of a silent empty state.  Returns null when there's no record (path
 * was never tried, or the negative-cache TTL has expired).
 *
 * Shape:
 *   {
 *     kind: 'rate_limited' | 'other',
 *     retryAfterMs: number,        // total backoff window
 *     msSinceFailure: number,      // for "failed Ns ago" text
 *     msUntilRetry: number,        // for "retry in Ns" text
 *   }
 */
export function getMediaFailureInfo(filePath, mode = 'thumb') {
  const cacheKey = `${mode}::${filePath}`;
  const entry = _negCacheCheck(cacheKey);
  if (!entry) return null;
  const msSinceFailure = Date.now() - entry.failedAt;
  return {
    kind: entry.kind,
    retryAfterMs: entry.retryAfterMs,
    msSinceFailure,
    msUntilRetry: Math.max(0, entry.retryAfterMs - msSinceFailure),
  };
}

/**
 * Manually clear the failure record for a path so a subsequent fetch
 * tries again.  Useful for "retry now" buttons in error UIs.
 */
export function clearMediaFailure(filePath, mode = 'thumb') {
  _negCache.delete(`${mode}::${filePath}`);
}

async function _doFetch(cache, cacheKey, filePath, mode, retries) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s timeout
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ action: mode, file_path: filePath }),
      signal: controller.signal,
    });

    // 429 = Dropbox rate limit.  DO NOT retry — the Edge fn has already
    // surfaced the 429 immediately (per its 2026-05-03 hotfix) precisely
    // to avoid compounding the cool-off.  Negative-cache the failure
    // for the duration Dropbox asked us to wait, then return null.
    if (res.status === 429) {
      let retryAfterS = null;
      const hdrRA = parseInt(res.headers?.get('Retry-After') || '', 10);
      if (Number.isFinite(hdrRA) && hdrRA > 0) retryAfterS = hdrRA;
      try {
        const body = await res.clone().json().catch(() => null);
        if (body && typeof body.retry_after_s === 'number' && body.retry_after_s > 0) {
          retryAfterS = body.retry_after_s;
        }
      } catch {
        /* ignore body parse — header was good enough */
      }
      const ttlMs = retryAfterS != null ? retryAfterS * 1000 : NEG_CACHE_DEFAULT_RATE_LIMITED_MS;
      _negCacheSet(cacheKey, 'rate_limited', ttlMs);
      console.warn(
        `[mediaPerf] ${filePath?.slice?.(-40) || filePath} rate-limited; ` +
          `negative-cached for ${Math.round(ttlMs / 1000)}s`,
      );
      return null;
    }

    // 503 = token refreshed → retry with short backoff (this is internal,
    // not a Dropbox rate-limit).  503 is fast to recover from.
    if (res.status === 503 && retries > 0) {
      await new Promise(r => setTimeout(r, 500 * (3 - retries)));
      return _doFetch(cache, cacheKey, filePath, mode, retries - 1);
    }

    // 500/502/504 → retry once
    if (res.status >= 500 && retries > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return _doFetch(cache, cacheKey, filePath, mode, retries - 1);
    }

    if (!res.ok) {
      // Brief negative-cache so a re-render doesn't spam the same failed path.
      _negCacheSet(cacheKey, 'other', NEG_CACHE_DEFAULT_OTHER_MS);
      return null;
    }
    const blob = await res.blob();
    // Reject tiny error responses but not tiny valid images (lowered threshold)
    if (!blob.type?.startsWith('image/') && blob.size < 200) {
      _negCacheSet(cacheKey, 'other', NEG_CACHE_DEFAULT_OTHER_MS);
      return null;
    }
    const url = URL.createObjectURL(blob);
    cache.set(cacheKey, url);

    // Decode images off main thread
    if (mode === 'thumb') {
      try { await decodeImage(url); } catch {}
    }

    return url;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[mediaPerf] Thumbnail fetch timed out:', filePath);
    }
    _negCacheSet(cacheKey, 'other', NEG_CACHE_DEFAULT_OTHER_MS);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

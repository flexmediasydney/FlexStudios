/**
 * mediaProxyCache.js — Shared LRU blob cache + concurrency-limited proxy fetcher
 *
 * Performance rationale:
 * Previously, each media component (ProjectMediaGallery, LiveMediaFeed,
 * DeliveryFeed, SocialMedia) duplicated its own blob cache (unbounded Map),
 * concurrency queue, and fetchProxyImage function. With 200+ images, memory
 * usage could exceed 500MB because blob URLs were never evicted.
 *
 * This module provides:
 *  1. LRU cache with a configurable max size (default 100 entries).
 *     When the cache is full, the least-recently-used blob URL is revoked
 *     and removed before inserting a new entry.
 *  2. A single concurrency-limited fetch queue shared across all views.
 *     The global limit is 6 (down from 8-per-view which could mean 32
 *     concurrent Dropbox API calls with 4 views open).
 *  3. A pending-request dedup set so the same file is never fetched twice.
 *  4. An async decodeImage() helper that calls img.decode() off the main
 *     thread to avoid jank when displaying large thumbnails.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── LRU Blob Cache ──────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 100;

/**
 * LRU cache implemented on top of Map's insertion-order iteration.
 * On get(), we delete and re-insert the key to move it to the "newest" position.
 * On set(), when the map exceeds MAX_CACHE_SIZE, the oldest key is evicted and
 * its blob URL is revoked to free memory.
 */
class LRUBlobCache {
  constructor(maxSize = MAX_CACHE_SIZE) {
    this._map = new Map();
    this._maxSize = maxSize;
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

  set(key, blobUrl) {
    // If key already exists, remove it first to re-insert at the end
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    // Evict LRU entries if at capacity
    while (this._map.size >= this._maxSize) {
      const oldestKey = this._map.keys().next().value;
      const oldestUrl = this._map.get(oldestKey);
      this._map.delete(oldestKey);
      // Revoke the blob URL to free browser memory
      try { URL.revokeObjectURL(oldestUrl); } catch { /* already revoked */ }
    }
    this._map.set(key, blobUrl);
  }

  delete(key) {
    const url = this._map.get(key);
    if (url) {
      try { URL.revokeObjectURL(url); } catch { /* ok */ }
    }
    return this._map.delete(key);
  }

  /** Delete all entries whose key starts with a given prefix. */
  deleteByPrefix(prefix) {
    for (const key of [...this._map.keys()]) {
      if (key.startsWith(prefix)) {
        this.delete(key);
      }
    }
  }

  /** Iterate entries (for compatibility with existing code that does for-of). */
  entries() {
    return this._map.entries();
  }

  get size() {
    return this._map.size;
  }

  clear() {
    for (const url of this._map.values()) {
      try { URL.revokeObjectURL(url); } catch { /* ok */ }
    }
    this._map.clear();
  }
}

// Singleton instance shared by all media components
export const blobCache = new LRUBlobCache(MAX_CACHE_SIZE);

// ─── Concurrency-limited fetch queue ─────────────────────────────────────────

const MAX_CONCURRENT = 6; // global limit across all views
const pending = new Set();
let activeLoads = 0;
const loadQueue = [];

function processQueue() {
  while (activeLoads < MAX_CONCURRENT && loadQueue.length > 0) {
    const job = loadQueue.shift();
    activeLoads++;
    job().finally(() => { activeLoads--; processQueue(); });
  }
}

/**
 * Fetch a proxied image/thumbnail via the Supabase edge function.
 *
 * @param {string} filePath  - Full Dropbox path to the file
 * @param {'thumb'|'proxy'|'stream_url'} mode - Proxy action
 * @returns {Promise<string|null>} Blob URL or null on failure
 */
export async function fetchProxyImage(filePath, mode = 'thumb') {
  const cacheKey = `${mode}::${filePath}`;
  if (blobCache.has(cacheKey)) return blobCache.get(cacheKey);
  if (pending.has(cacheKey)) return null;
  pending.add(cacheKey);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ action: mode, file_path: filePath }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 500) return null;
    const url = URL.createObjectURL(blob);
    blobCache.set(cacheKey, url);
    return url;
  } catch {
    return null;
  } finally {
    pending.delete(cacheKey);
  }
}

/**
 * Enqueue a thumbnail fetch job. The job runs when a concurrency slot opens.
 *
 * @param {Function} job  - Async function to run (should call fetchProxyImage internally)
 */
export function enqueueLoad(job) {
  loadQueue.push(job);
  processQueue();
}

/**
 * Clear cached blobs for a specific base path (e.g., on manual refresh).
 * Matches any cache key that contains the given path prefix.
 */
export function clearCacheForPath(basePath) {
  if (!basePath) return;
  blobCache.deleteByPrefix(basePath);
  // Also clear keyed by mode prefix
  blobCache.deleteByPrefix(`thumb::${basePath}`);
  blobCache.deleteByPrefix(`proxy::${basePath}`);
}

// ─── Image decode helper ─────────────────────────────────────────────────────

/**
 * Decode an image off the main thread before displaying it.
 * Prevents jank from large thumbnails (even 480x320) being decoded synchronously.
 *
 * Usage: set src, await decodeImage(imgElement), then make visible.
 *
 * @param {string} src - The blob URL or data URL to decode
 * @returns {Promise<string>} The same src, resolved after decode completes
 */
export async function decodeImage(src) {
  if (!src) return src;
  try {
    const img = new Image();
    img.src = src;
    if (typeof img.decode === 'function') {
      await img.decode();
    }
  } catch {
    // decode() can fail for broken images; silently continue
  }
  return src;
}

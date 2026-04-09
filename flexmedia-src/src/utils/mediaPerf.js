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


// ─── Global Fetch Concurrency Limiter ────────────────────────────────────────
// Prevents all media views from collectively overwhelming Dropbox/Supabase.
// Individual per-component queues MUST use this instead of their own counters.

const GLOBAL_MAX_CONCURRENT = 12; // Max simultaneous fetches across ALL views
let _globalActive = 0;
const _globalQueue = [];

function _processGlobalQueue() {
  while (_globalActive < GLOBAL_MAX_CONCURRENT && _globalQueue.length > 0) {
    const { job, resolve, reject } = _globalQueue.shift();
    _globalActive++;
    job()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        _globalActive--;
        _processGlobalQueue();
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

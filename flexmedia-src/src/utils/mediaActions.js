/**
 * mediaActions.js — Shared media action utilities
 *
 * Single source of truth for:
 * - Opening files in Dropbox (drill-through)
 * - Downloading files via proxy
 * - Building proxy paths
 *
 * All media components (ProjectMediaGallery, DeliveryFeed, LiveMediaFeed, SocialMedia)
 * should use these instead of inline implementations.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

/**
 * Open the Dropbox folder for a project in a new tab.
 * Uses the per-project Tonomo deliverable link (always works).
 * @param {string} deliverableLink - project.tonomo_deliverable_link
 */
export function openInDropbox(deliverableLink) {
  if (!deliverableLink) return;
  window.open(deliverableLink, '_blank', 'noopener,noreferrer');
}

/**
 * Build the proxy path for a file (used for thumbnails, full-res, downloads).
 * @param {string} tonomoBasePath - project.tonomo_deliverable_path
 * @param {object} file - { path, name }
 * @returns {string|null}
 */
export function buildProxyPath(tonomoBasePath, file) {
  if (!tonomoBasePath || !file?.name) return null;
  const filePath = file.path || `/${file.name}`;
  return `${tonomoBasePath}${filePath.startsWith('/') ? filePath : '/' + filePath}`;
}

/**
 * Download a file via the proxy edge function.
 * Fetches the full file and triggers a browser download.
 * @param {string} proxyPath - full Dropbox path
 * @param {string} fileName - for the download filename
 */
export function downloadFile(proxyPath, fileName) {
  if (!proxyPath) return;
  fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
    body: JSON.stringify({ action: 'proxy', file_path: proxyPath }),
  })
    .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    })
    .catch(err => console.error('Download failed:', err));
}

// Track navigation direction for smarter preloading
let _lastLightboxIndex = -1;
let _navDirection = 1; // 1 = forward, -1 = backward

/**
 * World-class predictive preloading for lightbox navigation.
 *
 * - Direction-aware: preloads more images in the direction of travel
 * - Deep: preloads up to 4 images ahead and 2 behind (or vice versa)
 * - Priority: immediate next/prev first, then further out
 * - Video-aware: preloads video thumbnails (small) but not full video files
 * - Staggered: slight delay between preloads to avoid flooding
 */
export function preloadAdjacentImages(files, currentIndex, getProxyPath, fetchFn, cache, cacheKeyFn) {
  if (!files || files.length === 0) return;

  // Detect navigation direction
  if (_lastLightboxIndex >= 0 && currentIndex !== _lastLightboxIndex) {
    _navDirection = currentIndex > _lastLightboxIndex ? 1 : -1;
  }
  _lastLightboxIndex = currentIndex;

  // Build priority-ordered offsets: immediate neighbors first, then deeper in travel direction
  const forward = _navDirection >= 0;
  const offsets = forward
    ? [1, -1, 2, 3, -2, 4]   // forward: prioritize ahead
    : [-1, 1, -2, -3, 2, -4]; // backward: prioritize behind

  let preloaded = 0;
  const MAX_PRELOAD = 5; // don't preload more than 5 at once

  for (const offset of offsets) {
    if (preloaded >= MAX_PRELOAD) break;
    const idx = currentIndex + offset;
    if (idx < 0 || idx >= files.length) continue;
    const file = files[idx];
    if (!file) continue;
    const path = getProxyPath(file);
    if (!path) continue;

    // For videos: preload thumbnail only (not full video)
    if (file.type === 'video') {
      const thumbKey = cacheKeyFn ? cacheKeyFn(path, 'thumb') : `thumb::${path}`;
      if (!cache?.has?.(thumbKey)) {
        fetchFn(path, 'thumb').catch(() => {});
        preloaded++;
      }
      continue;
    }

    // For images: preload full-res
    const key = cacheKeyFn ? cacheKeyFn(path, 'proxy') : `proxy::${path}`;
    if (cache?.has?.(key)) continue;
    fetchFn(path, 'proxy').catch(() => {});
    preloaded++;
  }
}

/**
 * Preload a single image's full-res on demand (e.g., filmstrip hover).
 * Returns immediately if already cached.
 */
export function preloadSingleImage(proxyPath, fetchFn, cache, cacheKeyFn) {
  if (!proxyPath) return;
  const key = cacheKeyFn ? cacheKeyFn(proxyPath, 'proxy') : `proxy::${proxyPath}`;
  if (cache?.has?.(key)) return;
  fetchFn(proxyPath, 'proxy').catch(() => {});
}

/**
 * Get a streaming URL for a video file.
 * Returns a URL that can be used as <video src="...">.
 * The edge function streams the file directly from Dropbox with proper headers.
 *
 * @param {string} proxyPath - full Dropbox path
 * @returns {string} streaming URL
 */
export function getVideoStreamUrl(proxyPath) {
  return `${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed?stream=${encodeURIComponent(proxyPath)}`;
}

/**
 * Fetch a full-res image via the proxy edge function.
 * Returns a blob URL or null. Used by lightboxes for full-quality display.
 * NOTE: For videos, use getVideoStreamUrl() instead (streaming, no download).
 *
 * @param {string} proxyPath - full Dropbox path
 * @param {number} retries - retry attempts remaining (default 3)
 * @returns {Promise<string|null>} blob URL
 */
export async function fetchFullRes(proxyPath, retries = 3) {
  if (!proxyPath) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ action: 'proxy', file_path: proxyPath }),
    });
    // If 503, retry up to 3 times with backoff
    if (res.status === 503 && retries > 0) {
      await new Promise(r => setTimeout(r, 200 * (4 - retries)));
      return fetchFullRes(proxyPath, retries - 1);
    }
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 1000) return null; // error JSON
    return URL.createObjectURL(blob);
  } catch (err) {
    console.warn('[media]', err.message);
    return null;
  }
}

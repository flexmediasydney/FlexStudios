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

/**
 * Predictive preloading for lightbox navigation.
 * When viewing image at `currentIndex`, preload adjacent images (next 2 + previous 1).
 * This makes arrow-key navigation feel instant.
 *
 * @param {Array} files - array of file objects
 * @param {number} currentIndex - currently viewed index
 * @param {Function} getProxyPath - (file) => string|null — builds the proxy path for a file
 * @param {Function} fetchFn - (proxyPath, mode) => Promise<string|null> — the fetchProxyImage function
 * @param {object} cache - the blob cache to check for existing entries
 * @param {Function} cacheKeyFn - (path, mode) => string — builds cache keys
 */
export function preloadAdjacentImages(files, currentIndex, getProxyPath, fetchFn, cache, cacheKeyFn) {
  if (!files || files.length === 0) return;
  const offsets = [1, 2, -1]; // next, next+1, previous

  for (const offset of offsets) {
    const idx = currentIndex + offset;
    if (idx < 0 || idx >= files.length) continue;
    const file = files[idx];
    if (!file || file.type === 'video') continue; // skip videos (too large to preload)
    const path = getProxyPath(file);
    if (!path) continue;
    const key = cacheKeyFn ? cacheKeyFn(path, 'proxy') : `proxy::${path}`;
    if (cache?.has?.(key)) continue; // already cached
    // Fire and forget — low priority background fetch
    fetchFn(path, 'proxy').catch(() => {});
  }
}

/**
 * Fetch a full-res image or video via the proxy edge function.
 * Returns a blob URL or null. Used by lightboxes for full-quality display.
 *
 * @param {string} proxyPath - full Dropbox path
 * @returns {Promise<string|null>} blob URL
 */
export async function fetchFullRes(proxyPath) {
  if (!proxyPath) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ action: 'proxy', file_path: proxyPath }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 1000) return null; // error JSON
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

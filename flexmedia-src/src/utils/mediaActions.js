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

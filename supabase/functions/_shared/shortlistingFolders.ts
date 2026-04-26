/**
 * shortlistingFolders.ts — thin convenience wrapper over projectFolders.ts
 * for the photos/* FolderKind family added in Wave 6 P1.
 *
 * Two responsibilities:
 *   1. Resolve a project's full Photos/* Dropbox-path set in one call
 *      (so Pass 0/1/2/3 don't each do five separate getFolderPath() lookups).
 *   2. Mint short-lived Dropbox temporary URLs for use in vision API calls
 *      (Anthropic fetches the image directly from this URL — 4 h TTL is
 *      plenty for any single Pass 0 round).
 *
 * No new entity types — this builds on getFolderPath() and dropboxApi() and
 * MUST NOT duplicate that logic.
 */

import { dropboxApi } from './dropbox.ts';
import { getFolderPath } from './projectFolders.ts';

// ─── Folder-set helper ───────────────────────────────────────────────────────

export interface ShortlistingFolderSet {
  /** Photos/Raws/Shortlist Proposed — RAW CR3 files land here from camera. */
  rawShortlist: string;
  /** Photos/Raws/Shortlist Proposed/Previews — Modal worker writes 1024px JPEGs here. */
  previews: string;
  /** Photos/Raws/Final Shortlist — confirmed shortlist after human review. */
  rawFinalShortlist: string;
  /** Photos/Raws/Rejected — hard-rejected (non-out-of-scope) RAWs go here on round Lock. */
  rawRejected: string;
  /** Photos/Raws/Quarantine — out-of-scope (agent headshot, equipment, etc) RAWs land here. */
  rawQuarantine: string;
  /** Photos/Editors/Edited Post Production — editor delivers retouched JPEGs here. */
  editorsEditedPostProduction: string;
  /** Photos/Editors/AI Proposed Enriched — engine variants (crops, virtual staging proposals). */
  editorsAiProposedEnriched: string;
  /** Photos/Finals — final delivery copy (mirrors confirmed enriched). */
  finals: string;
}

/**
 * Resolve the full Photos/* folder set for a project in parallel.
 *
 * Throws if any of the seven kinds is missing — provisioning was incomplete.
 * Callers can catch and surface a friendly error to the operator
 * ("project folders not provisioned — contact admin").
 */
export async function getShortlistingFolders(
  projectId: string,
): Promise<ShortlistingFolderSet> {
  const [
    rawShortlist,
    previews,
    rawFinalShortlist,
    rawRejected,
    rawQuarantine,
    editorsEditedPostProduction,
    editorsAiProposedEnriched,
    finals,
  ] = await Promise.all([
    getFolderPath(projectId, 'photos_raws_shortlist_proposed'),
    getFolderPath(projectId, 'photos_raws_shortlist_proposed_previews'),
    getFolderPath(projectId, 'photos_raws_final_shortlist'),
    getFolderPath(projectId, 'photos_raws_rejected'),
    getFolderPath(projectId, 'photos_raws_quarantine'),
    getFolderPath(projectId, 'photos_editors_edited_post_production'),
    getFolderPath(projectId, 'photos_editors_ai_proposed_enriched'),
    getFolderPath(projectId, 'photos_finals'),
  ]);
  return {
    rawShortlist,
    previews,
    rawFinalShortlist,
    rawRejected,
    rawQuarantine,
    editorsEditedPostProduction,
    editorsAiProposedEnriched,
    finals,
  };
}

// ─── Temporary URL minting ───────────────────────────────────────────────────

/**
 * Mint a short-lived (~4 h) Dropbox download URL for a file by full path.
 * Wraps Dropbox's `/files/get_temporary_link` API.
 *
 * Use case: pass-by-URL to Anthropic's vision API so we don't have to
 * download + re-encode the preview JPEG bytes into the prompt body. The
 * server-side fetch is faster and lighter than base64 inlining for the
 * 60+ images in a typical Pass 0 round.
 *
 * Rate limit: Dropbox caps `/files/get_temporary_link` at ~30 req/s app-wide.
 * Callers running many in parallel should chunk to ≤5 concurrent (mirror
 * drone-shot-urls' pattern).
 */
export async function getDropboxTempLink(dropboxPath: string): Promise<string> {
  const resp = await dropboxApi<{ link: string; metadata: unknown }>(
    '/files/get_temporary_link',
    { path: dropboxPath },
  );
  return resp.link;
}

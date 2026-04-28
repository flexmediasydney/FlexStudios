/**
 * Project-folder library — single source of truth for the per-project Dropbox
 * folder skeleton, file ops, audit log, and admin overrides.
 *
 * Builds on `./dropbox.ts` primitives. Feature code (PR4 hook, PR5 webhook,
 * PR6 reconcile, PR7 Files UI) calls this lib instead of touching Dropbox
 * directly.
 *
 * Folder skeleton (drone restructure 2026-04 — drones now top-level, raws +
 * editor curation lanes split out; photos/videos still live in 01_RAW_WORKING):
 *
 *   /Flex Media Team Folder/Projects/<projectId>_<slug>/
 *     ├── 01_RAW_WORKING/photos                                           ← raw_photos
 *     ├── 01_RAW_WORKING/videos                                           ← raw_videos
 *     ├── 06_ENRICHMENT/orthomosaics                                      ← enrichment_orthomosaics
 *     ├── 06_ENRICHMENT/sfm_meshes                                        ← enrichment_sfm_meshes
 *     ├── 07_FINAL_DELIVERY/                                              (no drone subfolder; see Drones/Finals)
 *     ├── _AUDIT/                                                         ← audit
 *     │     └── events/                                                    (per-event JSON mirror)
 *     └── Drones/                                                         (NEW top-level bucket for drone work)
 *           ├── Raws/
 *           │     ├── Shortlist Proposed/                                 ← drones_raws_shortlist_proposed
 *           │     │     └── Previews/                                     ← drones_raws_shortlist_proposed_previews
 *           │     ├── Final Shortlist/                                    ← drones_raws_final_shortlist (post-Lock)
 *           │     ├── Rejected/                                           ← drones_raws_rejected (post-Lock; un-rejectable)
 *           │     └── Others/                                             ← drones_raws_others (SfM-only nadirs/leftovers)
 *           ├── Editors/
 *           │     ├── Edited Post Production/                             ← drones_editors_edited_post_production
 *           │     ├── AI Proposed Enriched/                               ← drones_editors_ai_proposed_enriched
 *           │     └── Final Enriched/                                     ← drones_editors_final_enriched
 *           └── Finals/                                                   ← drones_finals (copy of Final Enriched)
 *
 * Deprecated kinds (raw_drones, enrichment_drone_renders_*, final_delivery_drones)
 * remain in the FolderKind union for backward-compat reads against existing
 * project_folders rows but are no longer provisioned for new projects. The
 * drone-folder-backfill one-shot will move existing files into the new tree.
 *
 * Reserved folders 02–05 (shortlist, editor) are not provisioned in Phase 1.
 *
 * Audit-log mirror strategy: each event is written as
 *   <root>/_AUDIT/events/<unix-ms>_<event-id>.json
 * (one file per event, race-free, append-only — concatenation into daily
 * jsonl can happen later in PR6 if useful).
 */

import {
  createFolder,
  getMetadata,
  listFolder,
  moveFile as dbxMoveFile,
  getOrCreateSharedLink,
  uploadFile,
  type DropboxFileMetadata,
} from './dropbox.ts';
import { getAdminClient } from './supabase.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECTS_BASE = '/Flex Media Team Folder/Projects';
const SLUG_MAX_CHARS = 40;

export type FolderKind =
  | 'raw_photos'
  // DEPRECATED: superseded by drones_* kinds in 2026-04 restructure. Do not use for new project provisioning. Migration path-mapper will move existing files.
  | 'raw_drones'
  | 'raw_videos'
  // DEPRECATED: superseded by drones_* kinds in 2026-04 restructure. Do not use for new project provisioning. Migration path-mapper will move existing files.
  | 'enrichment_drone_renders_proposed'
  // DEPRECATED: superseded by drones_* kinds in 2026-04 restructure. Do not use for new project provisioning. Migration path-mapper will move existing files.
  | 'enrichment_drone_renders_adjusted'
  | 'enrichment_orthomosaics'
  | 'enrichment_sfm_meshes'
  // DEPRECATED: superseded by drones_* kinds in 2026-04 restructure. Do not use for new project provisioning. Migration path-mapper will move existing files.
  | 'final_delivery_drones'
  | 'audit'
  // New drone restructure (2026-04)
  | 'drones_raws_shortlist_proposed'
  | 'drones_raws_shortlist_proposed_previews'
  | 'drones_raws_final_shortlist'
  | 'drones_raws_rejected'
  | 'drones_raws_others'
  | 'drones_editors_edited_post_production'
  | 'drones_editors_ai_proposed_enriched'
  | 'drones_editors_final_enriched'
  | 'drones_finals'
  // New photo shortlisting restructure (Wave 6 P1 — mig 282-289)
  | 'photos_raws_shortlist_proposed'
  | 'photos_raws_shortlist_proposed_previews'
  | 'photos_raws_final_shortlist'
  | 'photos_raws_rejected'
  | 'photos_raws_quarantine'
  | 'photos_editors_edited_post_production'
  | 'photos_editors_ai_proposed_enriched'
  | 'photos_finals'
  // Wave 7 P1-12 (W7.4): per-lock audit JSON mirror under the Photos tree.
  // Distinct from the global `audit` kind (top-level _AUDIT/ for project-
  // wide events) — `photos_audit` is the per-lock canonical "what did this
  // round become" snapshot, written by shortlist-lock to
  // <root>/Photos/_AUDIT/round_<N>_locked_<ISO>.json.
  | 'photos_audit';

/**
 * All folder kinds the system understands — includes both the legacy drone
 * kinds (still referenced by historical project_folders rows) and the new
 * drone restructure kinds. NEW projects should be provisioned only with
 * `NEW_PROJECT_FOLDER_KINDS` (see below); ALL_FOLDER_KINDS exists for
 * exhaustive type checks and backward-compat reads.
 */
export const ALL_FOLDER_KINDS: FolderKind[] = [
  'raw_photos',
  // Legacy drone kinds — kept for backward-compat with existing rows.
  'raw_drones',
  'raw_videos',
  'enrichment_drone_renders_proposed',
  'enrichment_drone_renders_adjusted',
  'enrichment_orthomosaics',
  'enrichment_sfm_meshes',
  'final_delivery_drones',
  'audit',
  // New drone restructure (2026-04)
  'drones_raws_shortlist_proposed',
  'drones_raws_shortlist_proposed_previews',
  'drones_raws_final_shortlist',
  'drones_raws_rejected',
  'drones_raws_others',
  'drones_editors_edited_post_production',
  'drones_editors_ai_proposed_enriched',
  'drones_editors_final_enriched',
  'drones_finals',
  // New photo shortlisting restructure (Wave 6 P1)
  'photos_raws_shortlist_proposed',
  'photos_raws_shortlist_proposed_previews',
  'photos_raws_final_shortlist',
  'photos_raws_rejected',
  'photos_raws_quarantine',
  'photos_editors_edited_post_production',
  'photos_editors_ai_proposed_enriched',
  'photos_finals',
  // Wave 7 P1-12 (W7.4)
  'photos_audit',
];

/**
 * Folder kinds provisioned for NEW projects. Excludes the deprecated drone
 * kinds (raw_drones, enrichment_drone_renders_*, final_delivery_drones) which
 * have been replaced by the `drones_*` tree under the top-level `Drones/`
 * bucket. Existing rows for deprecated kinds remain queryable until the
 * drone-folder-backfill one-shot migrates them.
 */
export const NEW_PROJECT_FOLDER_KINDS: FolderKind[] = [
  'raw_photos',
  'raw_videos',
  'enrichment_orthomosaics',
  'enrichment_sfm_meshes',
  'audit',
  'drones_raws_shortlist_proposed',
  'drones_raws_shortlist_proposed_previews',
  'drones_raws_final_shortlist',
  'drones_raws_rejected',
  'drones_raws_others',
  'drones_editors_edited_post_production',
  'drones_editors_ai_proposed_enriched',
  'drones_editors_final_enriched',
  'drones_finals',
  // New photo shortlisting restructure (Wave 6 P1)
  'photos_raws_shortlist_proposed',
  'photos_raws_shortlist_proposed_previews',
  'photos_raws_final_shortlist',
  'photos_raws_rejected',
  'photos_raws_quarantine',
  'photos_editors_edited_post_production',
  'photos_editors_ai_proposed_enriched',
  'photos_finals',
  // Wave 7 P1-12 (W7.4): photos_audit holds per-lock JSON snapshots written
  // by shortlist-lock. Existing projects: not backfilled — the audit JSON
  // write itself creates the folder on first lock (W7.4 spec resolution).
  'photos_audit',
];

const FOLDER_RELATIVE_PATHS: Record<FolderKind, string> = {
  raw_photos: '01_RAW_WORKING/photos',
  // DEPRECATED — kept so rows referencing this kind still resolve.
  raw_drones: '01_RAW_WORKING/drones',
  raw_videos: '01_RAW_WORKING/videos',
  // DEPRECATED — kept so rows referencing this kind still resolve.
  enrichment_drone_renders_proposed: '06_ENRICHMENT/drone_renders_proposed',
  // DEPRECATED — kept so rows referencing this kind still resolve.
  enrichment_drone_renders_adjusted: '06_ENRICHMENT/drone_renders_adjusted',
  enrichment_orthomosaics: '06_ENRICHMENT/orthomosaics',
  enrichment_sfm_meshes: '06_ENRICHMENT/sfm_meshes',
  // DEPRECATED — kept so rows referencing this kind still resolve.
  final_delivery_drones: '07_FINAL_DELIVERY/drones',
  audit: '_AUDIT',
  // New drone restructure (2026-04) — top-level Drones/ bucket.
  drones_raws_shortlist_proposed: 'Drones/Raws/Shortlist Proposed',
  drones_raws_shortlist_proposed_previews: 'Drones/Raws/Shortlist Proposed/Previews',
  drones_raws_final_shortlist: 'Drones/Raws/Final Shortlist',
  drones_raws_rejected: 'Drones/Raws/Rejected',
  drones_raws_others: 'Drones/Raws/Others',
  drones_editors_edited_post_production: 'Drones/Editors/Edited Post Production',
  drones_editors_ai_proposed_enriched: 'Drones/Editors/AI Proposed Enriched',
  drones_editors_final_enriched: 'Drones/Editors/Final Enriched',
  drones_finals: 'Drones/Finals',
  // Photo shortlisting (Wave 6 P1) — top-level Photos/ bucket mirrors Drones/.
  photos_raws_shortlist_proposed: 'Photos/Raws/Shortlist Proposed',
  photos_raws_shortlist_proposed_previews: 'Photos/Raws/Shortlist Proposed/Previews',
  photos_raws_final_shortlist: 'Photos/Raws/Final Shortlist',
  photos_raws_rejected: 'Photos/Raws/Rejected',
  photos_raws_quarantine: 'Photos/Raws/Quarantine',
  photos_editors_edited_post_production: 'Photos/Editors/Edited Post Production',
  photos_editors_ai_proposed_enriched: 'Photos/Editors/AI Proposed Enriched',
  photos_finals: 'Photos/Finals',
  // Wave 7 P1-12 (W7.4): per-lock audit JSON sink under the Photos tree.
  photos_audit: 'Photos/_AUDIT',
};

// Intermediate parent folders that must exist before leaves can be created.
// Includes the legacy 01/06/07 trees (still in use for photos/videos/orthos
// /sfm), the Drones/ subtree, AND the Photos/ subtree (Wave 6 P1).
const INTERMEDIATE_FOLDERS = [
  '01_RAW_WORKING',
  '06_ENRICHMENT',
  '07_FINAL_DELIVERY',
  'Drones',
  'Drones/Raws',
  'Drones/Raws/Shortlist Proposed',
  'Drones/Editors',
  'Photos',
  'Photos/Raws',
  'Photos/Raws/Shortlist Proposed',
  'Photos/Editors',
];

// ─── Slug + path helpers ─────────────────────────────────────────────────────

/**
 * Convert an address into a kebab-case slug for Dropbox folder naming.
 *
 * Rules (Phase 1 spec):
 *   - lowercase
 *   - path separators (/, \) → hyphen (so "6/3 Silver St" works)
 *   - all other special chars stripped
 *   - whitespace collapsed to single hyphen
 *   - capped at 40 chars (no trailing hyphen if the cut lands mid-word)
 *   - empty/null falls back to 'unknown'
 */
export function slugifyAddress(address: string | null | undefined): string {
  if (!address) return 'unknown';
  let slug = address
    .toLowerCase()
    .replace(/[\/\\]/g, '-')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX_CHARS) {
    slug = slug.slice(0, SLUG_MAX_CHARS).replace(/-+$/, '');
  }
  return slug || 'unknown';
}

/** Default Dropbox root path for a project (admin-overridable via projects.dropbox_root_path). */
export function defaultProjectRootPath(projectId: string, address: string | null): string {
  return `${PROJECTS_BASE}/${projectId}_${slugifyAddress(address)}`;
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface ProjectFolder {
  id: string;
  project_id: string;
  folder_kind: FolderKind;
  dropbox_path: string;
  shared_link: string | null;
  created_at: string;
  last_synced_at: string | null;
}

export interface ProjectFolderSet {
  rootPath: string;
  folders: ProjectFolder[];
}

export interface FileEntry {
  id: string | null;
  name: string;
  path: string;
  size: number;
  modified: string;
}

export interface AuditEventInput {
  projectId: string;
  folderKind: FolderKind;
  eventType: string;
  actorType: 'system' | 'user' | 'webhook';
  actorId?: string;
  fileName?: string;
  fileSizeBytes?: number;
  dropboxId?: string;
  metadata?: Record<string, unknown>;
}

// ─── createProjectFolders ────────────────────────────────────────────────────

/**
 * Provision the 9 managed folders for a project: creates the Dropbox tree
 * and inserts project_folders rows. Idempotent — safe to retry (Dropbox
 * createFolder treats path/conflict/folder as success; DB upserts ignore
 * duplicates on (project_id, folder_kind)).
 *
 * Persists the resolved root path on projects.dropbox_root_path if not already set.
 * Audits a single 'folders_created' event at the end.
 */
export async function createProjectFolders(
  projectId: string,
  address: string | null,
  opts?: { actorId?: string; actorType?: 'system' | 'user' },
): Promise<ProjectFolderSet> {
  const admin = getAdminClient();

  const { data: proj, error: projErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path, property_address')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) throw projErr;
  if (!proj) throw new Error(`Project ${projectId} not found`);

  const effectiveAddress = address ?? proj.property_address ?? null;
  const rootPath = proj.dropbox_root_path || defaultProjectRootPath(projectId, effectiveAddress);

  // 1. Create Dropbox tree (top-down; each call is idempotent).
  // Provision only NEW_PROJECT_FOLDER_KINDS — deprecated drone kinds
  // (raw_drones, enrichment_drone_renders_*, final_delivery_drones) are no
  // longer created for new projects per the 2026-04 drone restructure.
  await createFolder(rootPath);
  for (const inter of INTERMEDIATE_FOLDERS) {
    await createFolder(`${rootPath}/${inter}`);
  }
  for (const kind of NEW_PROJECT_FOLDER_KINDS) {
    await createFolder(`${rootPath}/${FOLDER_RELATIVE_PATHS[kind]}`);
  }
  // _AUDIT/events/ exists for the per-event mirror (Dropbox uploads do not
  // auto-create parent dirs).
  await createFolder(`${rootPath}/_AUDIT/events`);

  // 1.5. Verify Dropbox actually has every leaf folder before we touch the DB.
  //
  // Discovered 2026-04-28: a Wave 6 P1 backfill inserted 612 phantom
  // photos_* rows across 68 projects pointing at folders that never got
  // created in Dropbox — every createFolder call had returned success to the
  // caller (no thrown error), but a recursive list of the project root showed
  // the Photos/ tree missing entirely. Without a post-create existence check,
  // the bug was undetectable from the function's own return value: step 3
  // happily wrote DB rows for folders Dropbox didn't have.
  //
  // Two-tier strategy:
  //   FAST: one recursive list of the project root (~25 entries for a fresh
  //         project). One API call, done. Works for the typical case.
  //   SLOW: per-leaf getMetadata fallback when the fast path's recursive
  //         listing truncates (i.e., the project has accumulated >5000
  //         entries — real-world: 8/2 Everton blew through 1K of drone shots
  //         which torpedoed the original 1000-cap recursive verify). The
  //         slow path scales independently of file count: one getMetadata
  //         per expected leaf, ~23 calls per project.
  const expectedLeafPaths = NEW_PROJECT_FOLDER_KINDS.map(
    (kind) => `${rootPath}/${FOLDER_RELATIVE_PATHS[kind]}`,
  );

  let missingDropboxPaths: string[] = [];
  let usedSlowPath = false;
  try {
    const { entries: rootEntries, truncated: rootTruncated } = await listFolder(rootPath, {
      recursive: true,
      maxEntries: 5000,
    });
    if (rootTruncated) {
      usedSlowPath = true;
    } else {
      const presentLowerPaths = new Set(
        rootEntries
          .filter((e) => e['.tag'] === 'folder')
          .map((e) => (e.path_lower || (e.path_display || '').toLowerCase())),
      );
      missingDropboxPaths = expectedLeafPaths.filter(
        (p) => !presentLowerPaths.has(p.toLowerCase()),
      );
    }
  } catch (err) {
    // Recursive listing itself errored (root not found, etc) — fall through
    // to per-leaf so the per-path errors are attributable.
    usedSlowPath = true;
    console.warn(
      `[projectFolders] verify fast-path failed for ${projectId}, falling back to per-leaf: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (usedSlowPath) {
    // Per-leaf existence check. Sequential (not Promise.all) to be polite to
    // Dropbox rate limits — the dropbox.ts wrapper retries on 429 but firing
    // 23 parallel calls per project across a 70-project backfill is enough
    // to soft-throttle.
    const missing: string[] = [];
    for (const path of expectedLeafPaths) {
      try {
        const meta = await getMetadata(path);
        if (meta['.tag'] !== 'folder') missing.push(path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not_found')) {
          missing.push(path);
        } else {
          throw err; // auth / rate-limit-after-retries / other → propagate
        }
      }
    }
    missingDropboxPaths = missing;
  }

  if (missingDropboxPaths.length > 0) {
    const sample = missingDropboxPaths.slice(0, 5).join('; ');
    const more = missingDropboxPaths.length > 5 ? ` (+${missingDropboxPaths.length - 5} more)` : '';
    throw new Error(
      `Dropbox folder verification failed for project ${projectId}: ` +
        `${missingDropboxPaths.length}/${NEW_PROJECT_FOLDER_KINDS.length} expected folders ` +
        `not present after createFolder calls returned success. Missing: ${sample}${more}`,
    );
  }

  // 2. Persist root path on project (only if not already set).
  if (!proj.dropbox_root_path) {
    const { error: updErr } = await admin
      .from('projects')
      .update({ dropbox_root_path: rootPath })
      .eq('id', projectId);
    if (updErr) throw updErr;
  }

  // 3. Insert any missing project_folders rows.
  //
  // Was previously a `.upsert(rows, { onConflict: 'project_id,folder_kind',
  // ignoreDuplicates: true })` call, but that supabase-js path empirically
  // NO-OPs new rows on this Supabase deployment — it touches existing rows'
  // last_synced_at but never inserts the missing kinds. Discovered 2026-04-28
  // while backfilling 14 projects to add the Photos/ tree (Wave 6 P1):
  // every backfill iteration reported processed=N, errors=0, but the
  // project_folders count never went up.
  //
  // Doing an explicit "read existing kinds, insert delta" sidesteps the
  // bug entirely and is unambiguous about what gets written. Idempotent —
  // a concurrent caller racing to insert the same kinds will hit the
  // (project_id, folder_kind) unique constraint, which propagates as an
  // error to the caller for retry.
  const now = new Date().toISOString();
  const { data: existingFolders, error: readKindsErr } = await admin
    .from('project_folders')
    .select('folder_kind')
    .eq('project_id', projectId);
  if (readKindsErr) throw readKindsErr;
  const existingKinds = new Set(
    (existingFolders || []).map((r: { folder_kind: string }) => r.folder_kind),
  );
  const missingRows = NEW_PROJECT_FOLDER_KINDS
    .filter((kind) => !existingKinds.has(kind))
    .map((kind) => ({
      project_id: projectId,
      folder_kind: kind,
      dropbox_path: `${rootPath}/${FOLDER_RELATIVE_PATHS[kind]}`,
      last_synced_at: now,
    }));
  if (missingRows.length > 0) {
    const { error: insErr } = await admin.from('project_folders').insert(missingRows);
    if (insErr) throw insErr;
  }

  // 4. Read back the canonical rows.
  const { data: folders, error: readErr } = await admin
    .from('project_folders')
    .select('*')
    .eq('project_id', projectId)
    .order('folder_kind');
  if (readErr) throw readErr;

  // 5. Audit — only on fresh provisioning. A retry (where dropbox_root_path
  // was already set on entry) would otherwise emit a duplicate folders_created
  // event despite the rest of the function being idempotent.
  if (!proj.dropbox_root_path) {
    await auditEvent({
      projectId,
      folderKind: 'audit',
      eventType: 'folders_created',
      actorType: opts?.actorType || 'system',
      actorId: opts?.actorId,
      metadata: { root_path: rootPath, folder_count: NEW_PROJECT_FOLDER_KINDS.length },
    });
  }

  return { rootPath, folders: (folders || []) as ProjectFolder[] };
}

// ─── getFolderPath ───────────────────────────────────────────────────────────

export async function getFolderPath(projectId: string, kind: FolderKind): Promise<string> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('project_folders')
    .select('dropbox_path')
    .eq('project_id', projectId)
    .eq('folder_kind', kind)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No folder of kind '${kind}' for project ${projectId}`);
  return data.dropbox_path;
}

// ─── listFiles ───────────────────────────────────────────────────────────────

export async function listFiles(projectId: string, kind: FolderKind): Promise<FileEntry[]> {
  const path = await getFolderPath(projectId, kind);
  const { entries } = await listFolder(path, { recursive: false, maxEntries: 5000 });
  return entries
    .filter((e) => e['.tag'] === 'file')
    .map((f) => ({
      id: f.id || null,
      name: f.name,
      path: f.path_display || `${path}/${f.name}`,
      size: f.size || 0,
      modified: f.client_modified || f.server_modified || '',
    }));
}

// ─── writeFile ───────────────────────────────────────────────────────────────

export async function writeFile(
  projectId: string,
  kind: FolderKind,
  filename: string,
  content: ArrayBuffer | Uint8Array | string,
): Promise<DropboxFileMetadata> {
  const folderPath = await getFolderPath(projectId, kind);
  return uploadFile(`${folderPath}/${filename}`, content, 'add');
}

// ─── moveFile ────────────────────────────────────────────────────────────────

export async function moveFile(
  projectId: string,
  fromKind: FolderKind,
  toKind: FolderKind,
  filename: string,
): Promise<DropboxFileMetadata> {
  const fromPath = await getFolderPath(projectId, fromKind);
  const toPath = await getFolderPath(projectId, toKind);
  const result = await dbxMoveFile(`${fromPath}/${filename}`, `${toPath}/${filename}`);

  await auditEvent({
    projectId,
    folderKind: toKind,
    eventType: 'file_moved',
    actorType: 'system',
    fileName: filename,
    metadata: { from_kind: fromKind, to_kind: toKind, from_path: fromPath, to_path: toPath },
  });

  return result;
}

// ─── getSharedLink ───────────────────────────────────────────────────────────

/**
 * Return a Dropbox shared link for the given folder, creating one if missing.
 * Cached on project_folders.shared_link so subsequent calls are free.
 */
export async function getSharedLink(projectId: string, kind: FolderKind): Promise<string> {
  const admin = getAdminClient();

  const { data: existing, error: readErr } = await admin
    .from('project_folders')
    .select('dropbox_path, shared_link')
    .eq('project_id', projectId)
    .eq('folder_kind', kind)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!existing) throw new Error(`No folder of kind '${kind}' for project ${projectId}`);

  if (existing.shared_link) return existing.shared_link;

  const url = await getOrCreateSharedLink(existing.dropbox_path);

  const { error: updErr } = await admin
    .from('project_folders')
    .update({ shared_link: url })
    .eq('project_id', projectId)
    .eq('folder_kind', kind);
  if (updErr) throw updErr;

  await auditEvent({
    projectId,
    folderKind: kind,
    eventType: 'shared_link_created',
    actorType: 'system',
    metadata: { url, path: existing.dropbox_path },
  });

  return url;
}

// ─── overrideFolderPath ──────────────────────────────────────────────────────

/**
 * Admin override: change the dropbox_path for a single folder kind. Does NOT
 * physically move files — assumes the new path already exists in Dropbox and
 * contains the project's files for that kind. The cached shared_link is
 * cleared (the next getSharedLink will mint a new one for the new path).
 */
export async function overrideFolderPath(
  projectId: string,
  kind: FolderKind,
  newPath: string,
  actorId: string,
): Promise<void> {
  const admin = getAdminClient();

  const { data: prev, error: readErr } = await admin
    .from('project_folders')
    .select('dropbox_path')
    .eq('project_id', projectId)
    .eq('folder_kind', kind)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!prev) throw new Error(`No folder of kind '${kind}' for project ${projectId}`);

  const { error: updErr } = await admin
    .from('project_folders')
    .update({ dropbox_path: newPath, shared_link: null })
    .eq('project_id', projectId)
    .eq('folder_kind', kind);
  if (updErr) throw updErr;

  await auditEvent({
    projectId,
    folderKind: kind,
    eventType: 'override_applied',
    actorType: 'user',
    actorId,
    metadata: { old_path: prev.dropbox_path, new_path: newPath },
  });
}

// ─── auditEvent ──────────────────────────────────────────────────────────────

/**
 * Append an event to project_folder_events AND mirror to Dropbox _AUDIT/events.
 * The DB write is the source of truth and is awaited; the Dropbox mirror is
 * fire-and-forget and best-effort (failure is logged but does not propagate
 * to the caller).
 */
export async function auditEvent(input: AuditEventInput): Promise<{ id: number }> {
  const admin = getAdminClient();

  const row = {
    project_id: input.projectId,
    folder_kind: input.folderKind,
    event_type: input.eventType,
    actor_type: input.actorType,
    actor_id: input.actorId || null,
    file_name: input.fileName || null,
    file_size_bytes: input.fileSizeBytes || null,
    dropbox_id: input.dropboxId || null,
    metadata: input.metadata || null,
  };

  const { data, error } = await admin
    .from('project_folder_events')
    .insert(row)
    .select('id, created_at')
    .single();
  if (error || !data) throw error || new Error('audit insert failed');

  const event = { ...row, id: data.id as number, created_at: data.created_at as string };
  mirrorEventToDropbox(input.projectId, event).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[projectFolders] audit mirror failed for event ${event.id}: ${msg}`);
  });

  return { id: event.id };
}

async function mirrorEventToDropbox(projectId: string, event: { id: number; created_at: string } & Record<string, unknown>): Promise<void> {
  const admin = getAdminClient();
  const { data } = await admin
    .from('project_folders')
    .select('dropbox_path')
    .eq('project_id', projectId)
    .eq('folder_kind', 'audit')
    .maybeSingle();
  if (!data) return; // No audit folder yet (e.g., very first call before provisioning).

  const ts = new Date(event.created_at).getTime();
  const filename = `${ts}_${event.id}.json`;
  const eventsDir = `${data.dropbox_path}/events`;
  const path = `${eventsDir}/${filename}`;

  // (#60 audit fix) The `_AUDIT/events/` subfolder doesn't exist on a fresh
  // project until provisioning runs. Events emitted BEFORE provisioning (or
  // by any code path that touches a project before its folder skeleton is
  // built) used to silently fail the Dropbox-mirror step because Dropbox
  // /files/upload doesn't auto-create parent dirs. We now make the events/
  // dir on demand. createFolder is idempotent (path/conflict/folder is
  // treated as success) so the cost is one extra round-trip on the first
  // event after provisioning, then nothing.
  //
  // TODO (backfill): historical events emitted before this fix have no
  // Dropbox mirror. A separate one-shot job would need to walk
  // project_folder_events for all rows where the corresponding _AUDIT/events
  // file is absent and re-mirror them. Out of scope for this PR.
  try {
    await uploadFile(path, JSON.stringify(event, null, 2), 'add');
  } catch (uploadErr) {
    const msg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
    // path/not_found typically means the events/ dir is missing; recover by
    // creating it and retrying once.
    if (msg.includes('path/not_found') || msg.includes('not_found')) {
      console.warn(`[projectFolders] _AUDIT/events missing for project ${projectId} — provisioning on demand`);
      await createFolder(eventsDir);
      await uploadFile(path, JSON.stringify(event, null, 2), 'add');
    } else {
      throw uploadErr;
    }
  }
}

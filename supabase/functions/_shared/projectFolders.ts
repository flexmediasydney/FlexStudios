/**
 * Project-folder library — single source of truth for the per-project Dropbox
 * folder skeleton, file ops, audit log, and admin overrides.
 *
 * Builds on `./dropbox.ts` primitives. Feature code (PR4 hook, PR5 webhook,
 * PR6 reconcile, PR7 Files UI) calls this lib instead of touching Dropbox
 * directly.
 *
 * Folder skeleton per IMPLEMENTATION_PLAN_V2.md §1.1:
 *
 *   /FlexMedia/Projects/<projectId>_<slug>/
 *     ├── 01_RAW_WORKING/photos        ← raw_photos
 *     ├── 01_RAW_WORKING/drones        ← raw_drones
 *     ├── 01_RAW_WORKING/videos        ← raw_videos
 *     ├── 06_ENRICHMENT/drone_renders_proposed   ← enrichment_drone_renders_proposed
 *     ├── 06_ENRICHMENT/drone_renders_adjusted   ← enrichment_drone_renders_adjusted
 *     ├── 06_ENRICHMENT/orthomosaics             ← enrichment_orthomosaics
 *     ├── 06_ENRICHMENT/sfm_meshes               ← enrichment_sfm_meshes
 *     ├── 07_FINAL_DELIVERY/drones               ← final_delivery_drones
 *     └── _AUDIT/                                 ← audit
 *           └── events/                            (per-event JSON mirror)
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
  listFolder,
  moveFile as dbxMoveFile,
  getOrCreateSharedLink,
  uploadFile,
  type DropboxFileMetadata,
} from './dropbox.ts';
import { getAdminClient } from './supabase.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECTS_BASE = '/FlexMedia/Projects';
const SLUG_MAX_CHARS = 40;

export type FolderKind =
  | 'raw_photos'
  | 'raw_drones'
  | 'raw_videos'
  | 'enrichment_drone_renders_proposed'
  | 'enrichment_drone_renders_adjusted'
  | 'enrichment_orthomosaics'
  | 'enrichment_sfm_meshes'
  | 'final_delivery_drones'
  | 'audit';

export const ALL_FOLDER_KINDS: FolderKind[] = [
  'raw_photos',
  'raw_drones',
  'raw_videos',
  'enrichment_drone_renders_proposed',
  'enrichment_drone_renders_adjusted',
  'enrichment_orthomosaics',
  'enrichment_sfm_meshes',
  'final_delivery_drones',
  'audit',
];

const FOLDER_RELATIVE_PATHS: Record<FolderKind, string> = {
  raw_photos: '01_RAW_WORKING/photos',
  raw_drones: '01_RAW_WORKING/drones',
  raw_videos: '01_RAW_WORKING/videos',
  enrichment_drone_renders_proposed: '06_ENRICHMENT/drone_renders_proposed',
  enrichment_drone_renders_adjusted: '06_ENRICHMENT/drone_renders_adjusted',
  enrichment_orthomosaics: '06_ENRICHMENT/orthomosaics',
  enrichment_sfm_meshes: '06_ENRICHMENT/sfm_meshes',
  final_delivery_drones: '07_FINAL_DELIVERY/drones',
  audit: '_AUDIT',
};

// Intermediate parent folders that must exist before leaves can be created.
const INTERMEDIATE_FOLDERS = ['01_RAW_WORKING', '06_ENRICHMENT', '07_FINAL_DELIVERY'];

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
  await createFolder(rootPath);
  for (const inter of INTERMEDIATE_FOLDERS) {
    await createFolder(`${rootPath}/${inter}`);
  }
  for (const kind of ALL_FOLDER_KINDS) {
    await createFolder(`${rootPath}/${FOLDER_RELATIVE_PATHS[kind]}`);
  }
  // _AUDIT/events/ exists for the per-event mirror (Dropbox uploads do not
  // auto-create parent dirs).
  await createFolder(`${rootPath}/_AUDIT/events`);

  // 2. Persist root path on project (only if not already set).
  if (!proj.dropbox_root_path) {
    const { error: updErr } = await admin
      .from('projects')
      .update({ dropbox_root_path: rootPath })
      .eq('id', projectId);
    if (updErr) throw updErr;
  }

  // 3. Upsert project_folders rows.
  const now = new Date().toISOString();
  const rows = ALL_FOLDER_KINDS.map((kind) => ({
    project_id: projectId,
    folder_kind: kind,
    dropbox_path: `${rootPath}/${FOLDER_RELATIVE_PATHS[kind]}`,
    last_synced_at: now,
  }));
  const { error: upErr } = await admin
    .from('project_folders')
    .upsert(rows, { onConflict: 'project_id,folder_kind', ignoreDuplicates: true });
  if (upErr) throw upErr;

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
      metadata: { root_path: rootPath, folder_count: ALL_FOLDER_KINDS.length },
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
  const path = `${data.dropbox_path}/events/${filename}`;
  await uploadFile(path, JSON.stringify(event, null, 2), 'add');
}

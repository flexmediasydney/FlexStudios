/**
 * shortlisting-folder-probe
 * ─────────────────────────
 * Per-project Dropbox folder visibility for the Shortlisting tab.
 *
 * Why this exists (Joseph 2026-05-04):
 *   "i just uploaded raw images to our photos raw folder for the project,
 *    i dont feel like i have any visual cues in the shortlisting tab for
 *    this project, nor on the command center, if it knows the files are
 *    there, how many, and when the next cron job/detection will occur."
 *
 * The existing PendingIngestsWidget shows ONLY rows that already exist
 * in `shortlisting_jobs WHERE kind='ingest' AND status='pending'`.  Those
 * rows get created by the dropbox-webhook → enqueue_shortlisting_ingest_job
 * chain after Dropbox notifies us of the new files.  But:
 *   - There can be a lag (debounce window, webhook delivery latency, or a
 *     stale `dropbox_sync_state` cursor preventing the chain from firing).
 *   - For a brand-new project with files but no round, the operator gets
 *     ZERO visibility until the ingest fires.
 *
 * This function gives the operator real-time visibility independent of
 * the webhook chain by hitting Dropbox's `/files/list_folder` directly.
 *
 * Two actions:
 *
 *   action='probe' (default; safe for polling)
 *     Lists the project's `Photos/Raws/Shortlist Proposed/` folder via
 *     Dropbox API, returns:
 *       - file_count, total_bytes
 *       - latest_modified (most recent server_modified across all files)
 *       - top 5 most-recent filenames
 *       - pending_ingest_job: the matching shortlisting_jobs row (if any)
 *           — operator can correlate with PendingIngestsWidget countdown
 *     NEVER mutates DB.
 *
 *   action='detect_now' (master_admin only)
 *     Same listing, then calls enqueue_shortlisting_ingest_job with
 *     debounce_seconds=0 and force_reset=TRUE so the dispatcher picks
 *     it up on the next minute tick.  Returns the new/updated job_id.
 *
 * POST { project_id, action }
 * Auth: any authenticated user for 'probe'; master_admin for 'detect_now'.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { listFolder } from '../_shared/dropbox.ts';
import { getFolderPath } from '../_shared/projectFolders.ts';

const GENERATOR = 'shortlisting-folder-probe';

interface ProbeBody {
  project_id?: string;
  action?: 'probe' | 'detect_now';
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService && !user) {
    return errorResponse('Authentication required', 401, req);
  }

  let body: ProbeBody = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = body.project_id?.trim();
  if (!projectId) return errorResponse('project_id required', 400, req);
  const action = body.action === 'detect_now' ? 'detect_now' : 'probe';

  // detect_now requires master_admin (this is a state-mutation that
  // bypasses the 2h debounce; we don't want operators on tour-mode
  // accidentally triggering ingest cycles).
  if (action === 'detect_now' && !isService && user?.role !== 'master_admin') {
    return errorResponse(
      'Forbidden — only master_admin can trigger detect_now',
      403,
      req,
    );
  }

  const admin = getAdminClient();

  // Resolve the project's photos_raws_shortlist_proposed folder.  This
  // is the only folder the editorial-engine ingest reads from
  // (shortlisting-ingest/index.ts:1-5).
  let folderPath: string | null = null;
  try {
    folderPath = await getFolderPath(projectId, 'photos_raws_shortlist_proposed');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse(
      {
        ok: true,
        action,
        project_id: projectId,
        folder_provisioned: false,
        error: `Folder lookup failed: ${msg}. Project folders may not be provisioned yet.`,
        file_count: 0,
        total_bytes: 0,
        latest_modified: null,
        recent_files: [],
        pending_ingest_job: null,
      },
      200,
      req,
    );
  }
  if (!folderPath) {
    return jsonResponse(
      {
        ok: true,
        action,
        project_id: projectId,
        folder_provisioned: false,
        error:
          'Project does not have photos_raws_shortlist_proposed folder provisioned yet. Trigger folder provisioning before uploading RAWs.',
        file_count: 0,
        total_bytes: 0,
        latest_modified: null,
        recent_files: [],
        pending_ingest_job: null,
      },
      200,
      req,
    );
  }

  // ── List the folder via Dropbox /files/list_folder ───────────────────────
  // We use non-recursive listing — RAWs sit directly in the folder, the
  // Previews/ subfolder is its own folder_kind and shouldn't pollute the
  // count.  maxEntries cap guards against a runaway folder of >5k files.
  let entries: Array<{
    '.tag': string;
    name: string;
    size?: number;
    server_modified?: string;
    path_display?: string;
  }> = [];
  let listError: string | null = null;
  try {
    const result = await listFolder(folderPath, {
      recursive: false,
      maxEntries: 5000,
      app: 'engine',
    });
    entries = result.entries;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    listError = msg;
  }

  // Filter to actual files (skip subfolders + previews); only count
  // RAW-ish extensions.  Webhook is folder-kind-aware so it never sees
  // sub-folder file events bleed into the count, but `list_folder`
  // returns folders as `.tag='folder'` entries — exclude those.
  const RAW_EXTS = new Set([
    '.cr3', '.cr2', '.crw',
    '.arw', '.sr2', '.srf',
    '.nef', '.nrw',
    '.dng',
    '.raf',
    '.orf',
    '.rw2',
    '.pef',
    '.x3f',
  ]);
  const files = entries.filter((e) => {
    if (e['.tag'] !== 'file') return false;
    const lower = e.name.toLowerCase();
    const dotIdx = lower.lastIndexOf('.');
    if (dotIdx < 0) return false;
    return RAW_EXTS.has(lower.slice(dotIdx));
  });

  const fileCount = files.length;
  const totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  let latestModifiedIso: string | null = null;
  for (const f of files) {
    if (!f.server_modified) continue;
    if (!latestModifiedIso || f.server_modified > latestModifiedIso) {
      latestModifiedIso = f.server_modified;
    }
  }

  // Top 5 most-recent files, name + ISO modified.
  const recentFiles = files
    .filter((f) => f.server_modified)
    .sort((a, b) => (b.server_modified! > a.server_modified! ? 1 : -1))
    .slice(0, 5)
    .map((f) => ({ name: f.name, server_modified: f.server_modified! }));

  // ── Read any pending ingest job for this project (joins the probe to
  // the existing PendingIngestsWidget data so the UI can show "ingest
  // scheduled at HH:MM" without a separate query).
  const { data: jobRow } = await admin
    .from('shortlisting_jobs')
    .select('id, status, scheduled_for, created_at, payload, attempts')
    .eq('project_id', projectId)
    .eq('kind', 'ingest')
    .eq('status', 'pending')
    .order('scheduled_for', { ascending: true })
    .limit(1)
    .maybeSingle();

  // ── action='detect_now' — enqueue with zero debounce ─────────────────────
  let detectNowResult: {
    job_id: string | null;
    enqueued: boolean;
    skipped_reason?: string;
  } | null = null;
  if (action === 'detect_now') {
    if (fileCount === 0) {
      detectNowResult = {
        job_id: null,
        enqueued: false,
        skipped_reason:
          listError
            ? `folder list failed: ${listError}`
            : 'no RAW files found in Photos/Raws/Shortlist Proposed/',
      };
    } else {
      const { data: enqRes, error: enqErr } = await admin.rpc(
        'enqueue_shortlisting_ingest_job',
        {
          p_project_id: projectId,
          p_debounce_seconds: 0,
          p_force_reset: true,
        },
      );
      if (enqErr) {
        detectNowResult = {
          job_id: null,
          enqueued: false,
          skipped_reason: `enqueue RPC failed: ${enqErr.message}`,
        };
      } else {
        detectNowResult = {
          job_id: (enqRes as string) ?? null,
          enqueued: true,
        };
      }
    }
  }

  return jsonResponse(
    {
      ok: true,
      action,
      project_id: projectId,
      folder_path: folderPath,
      folder_provisioned: true,
      file_count: fileCount,
      total_bytes: totalBytes,
      latest_modified: latestModifiedIso,
      recent_files: recentFiles,
      list_error: listError,
      pending_ingest_job: jobRow,
      detect_now: detectNowResult,
    },
    200,
    req,
  );
});

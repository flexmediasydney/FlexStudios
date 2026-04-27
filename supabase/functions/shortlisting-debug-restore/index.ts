/**
 * shortlisting-debug-restore
 * ───────────────────────────
 * One-shot restorer for re-running a project from scratch. Moves all CR3s
 * out of `Final Shortlist/` and `Rejected/` back into `Shortlist Proposed/`
 * and deletes stale JPG previews.
 *
 * Used during Wave 0 lockstep diagnostic + emergency reset workflows.
 *
 * POST {
 *   project_id: string,
 *   dry_run?: boolean,        // default: true (safe by default)
 *   delete_previews?: boolean // default: true
 * }
 *
 * Service-role only. Returns a structured summary of what was moved + deleted
 * + any errors. Read-only when dry_run=true.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { listFolder, moveFile, deleteFile } from '../_shared/dropbox.ts';

const GENERATOR = 'shortlisting-debug-restore';

const RAW_EXTS = ['.cr3', '.cr2', '.arw', '.nef', '.raf', '.dng'];
const JPG_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const MOVE_CONCURRENCY = 6;   // mirror shortlist-lock's pattern
const DELETE_CONCURRENCY = 6;

interface MoveResult {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

interface DeleteResult {
  path: string;
  ok: boolean;
  error?: string;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Service-role only — verify the bearer JWT decodes to role=service_role.
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return errorResponse('service-role only (no bearer token)', 401, req);
  try {
    const payload = JSON.parse(atob(m[1].split('.')[1]));
    if (payload?.role !== 'service_role') {
      return errorResponse(`service-role only (role=${payload?.role})`, 401, req);
    }
  } catch (err) {
    return errorResponse(
      `service-role only (decode failed: ${err instanceof Error ? err.message : err})`,
      401,
      req,
    );
  }

  let body: {
    project_id?: string;
    dry_run?: boolean;
    delete_previews?: boolean;
    _health_check?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* noop */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = body.project_id?.trim();
  if (!projectId) return errorResponse('project_id required', 400, req);

  // Default to dry_run=true so accidental invocation doesn't mutate state.
  const dryRun = body.dry_run !== false;
  const deletePreviews = body.delete_previews !== false;

  const admin = getAdminClient();

  // Resolve folder paths
  const { data: folders, error: folderErr } = await admin
    .from('project_folders')
    .select('folder_kind, dropbox_path')
    .eq('project_id', projectId)
    .like('folder_kind', 'photos_raws_%');
  if (folderErr) return errorResponse(`folder lookup failed: ${folderErr.message}`, 500, req);

  const byKind = new Map<string, string>();
  for (const f of folders || []) {
    byKind.set(f.folder_kind as string, f.dropbox_path as string);
  }

  const sourceShortlist = byKind.get('photos_raws_shortlist_proposed');
  const finalShortlist = byKind.get('photos_raws_final_shortlist');
  const rejected = byKind.get('photos_raws_rejected');
  const previews = byKind.get('photos_raws_shortlist_proposed_previews');

  if (!sourceShortlist || !finalShortlist || !rejected || !previews) {
    return errorResponse(
      'project missing required folder kinds (photos_raws_shortlist_proposed / final_shortlist / rejected / previews)',
      500,
      req,
    );
  }

  // ── List Final Shortlist + Rejected, plan moves ──────────────────────────
  const moveSpecs: Array<{ from: string; to: string }> = [];

  for (const [label, srcPath] of [
    ['final_shortlist', finalShortlist],
    ['rejected', rejected],
  ] as const) {
    try {
      const result = await listFolder(srcPath, { recursive: false, maxEntries: 10_000 });
      const files = result.entries.filter(
        // deno-lint-ignore no-explicit-any
        (e: any) => e['.tag'] === 'file' && RAW_EXTS.some((ext) => (e.name || '').toLowerCase().endsWith(ext)),
      );
      for (const f of files) {
        // deno-lint-ignore no-explicit-any
        const ff = f as any;
        const fromPath = ff.path_display || `${srcPath}/${ff.name}`;
        const toPath = `${sourceShortlist.replace(/\/+$/, '')}/${ff.name}`;
        moveSpecs.push({ from: fromPath, to: toPath });
      }
      console.log(`[${GENERATOR}] ${label}: ${files.length} CR3 file(s) to move`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] list ${label} failed: ${msg}`);
    }
  }

  // ── List Previews, plan deletes ──────────────────────────────────────────
  const deleteSpecs: string[] = [];
  if (deletePreviews) {
    try {
      const result = await listFolder(previews, { recursive: false, maxEntries: 10_000 });
      const files = result.entries.filter(
        // deno-lint-ignore no-explicit-any
        (e: any) => e['.tag'] === 'file' && JPG_EXTS.some((ext) => (e.name || '').toLowerCase().endsWith(ext)),
      );
      for (const f of files) {
        // deno-lint-ignore no-explicit-any
        const ff = f as any;
        const path = ff.path_display || `${previews}/${ff.name}`;
        deleteSpecs.push(path);
      }
      console.log(`[${GENERATOR}] previews: ${files.length} JPG file(s) to delete`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] list previews failed: ${msg}`);
    }
  }

  // ── Dry-run short-circuit ────────────────────────────────────────────────
  if (dryRun) {
    return jsonResponse(
      {
        ok: true,
        dry_run: true,
        project_id: projectId,
        plan: {
          moves: {
            count: moveSpecs.length,
            sample_first_5: moveSpecs.slice(0, 5),
            sample_last_5: moveSpecs.slice(-5),
          },
          deletes: {
            count: deleteSpecs.length,
            sample_first_5: deleteSpecs.slice(0, 5),
            sample_last_5: deleteSpecs.slice(-5),
          },
        },
        message: 'Dry run only — no Dropbox state changed. Re-call with dry_run=false to execute.',
      },
      200,
      req,
    );
  }

  // ── Execute moves with bounded concurrency ───────────────────────────────
  const moveResults: MoveResult[] = [];
  let moveIdx = 0;
  async function moveWorker() {
    while (true) {
      const i = moveIdx++;
      if (i >= moveSpecs.length) return;
      const spec = moveSpecs[i];
      try {
        await moveFile(spec.from, spec.to);
        moveResults.push({ from: spec.from, to: spec.to, ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Tolerate already-at-destination (lock partial state)
        if (msg.includes('to/conflict') || msg.includes('already exists')) {
          moveResults.push({ from: spec.from, to: spec.to, ok: true, error: 'already_at_dest' });
        } else if (msg.includes('not_found')) {
          moveResults.push({ from: spec.from, to: spec.to, ok: false, error: `not_found: ${msg}` });
        } else {
          moveResults.push({ from: spec.from, to: spec.to, ok: false, error: msg });
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MOVE_CONCURRENCY, moveSpecs.length) }, () => moveWorker()),
  );

  // ── Execute deletes with bounded concurrency ─────────────────────────────
  const deleteResults: DeleteResult[] = [];
  let delIdx = 0;
  async function deleteWorker() {
    while (true) {
      const i = delIdx++;
      if (i >= deleteSpecs.length) return;
      const path = deleteSpecs[i];
      try {
        await deleteFile(path);
        deleteResults.push({ path, ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not_found')) {
          deleteResults.push({ path, ok: true, error: 'already_gone' });
        } else {
          deleteResults.push({ path, ok: false, error: msg });
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DELETE_CONCURRENCY, deleteSpecs.length) }, () => deleteWorker()),
  );

  const movesSucceeded = moveResults.filter((r) => r.ok).length;
  const movesFailed = moveResults.filter((r) => !r.ok).length;
  const deletesSucceeded = deleteResults.filter((r) => r.ok).length;
  const deletesFailed = deleteResults.filter((r) => !r.ok).length;

  return jsonResponse(
    {
      ok: movesFailed === 0 && deletesFailed === 0,
      dry_run: false,
      project_id: projectId,
      moves: {
        attempted: moveSpecs.length,
        succeeded: movesSucceeded,
        failed: movesFailed,
        errors: moveResults.filter((r) => !r.ok).slice(0, 20),
      },
      deletes: {
        attempted: deleteSpecs.length,
        succeeded: deletesSucceeded,
        failed: deletesFailed,
        errors: deleteResults.filter((r) => !r.ok).slice(0, 20),
      },
    },
    200,
    req,
  );
});

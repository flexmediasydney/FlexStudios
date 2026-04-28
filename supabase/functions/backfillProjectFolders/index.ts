/**
 * backfillProjectFolders
 * ──────────────────────
 * One-shot helper for the Phase 1 PR4 backfill: provisions Dropbox folders
 * for projects that don't yet have a `dropbox_root_path`.
 *
 * Processes projects SEQUENTIALLY in a single Edge Function isolate, which
 * keeps Dropbox API calls naturally rate-limited (~14 calls per project at
 * ~200ms each = ~3-5s/project, well under Dropbox burst limits). The
 * alternative — firing pg_net.http_post for all pending projects in
 * parallel — caused 429s.
 *
 * Auth: master_admin / admin only (manual operator action).
 *
 * Body:
 *   { batch_size?: number = 10, max_runtime_ms?: number = 90000,
 *     mode?: 'unprovisioned' | 'missing_kinds' = 'unprovisioned' }
 *
 *   - mode='unprovisioned' (default): legacy behavior — projects with
 *     dropbox_root_path IS NULL.
 *   - mode='missing_kinds': projects whose project_folders row count is
 *     less than NEW_PROJECT_FOLDER_KINDS.length. Catches projects that
 *     were provisioned before a new kind was added (e.g. Saladine-era
 *     projects missing the Wave 6 P1 `photos_*` tree). createProjectFolders
 *     is idempotent so re-runs only create what's missing.
 *
 * Response:
 *   { processed: number, errors: { project_id, error }[], remaining: number }
 *
 * Re-invoke until `remaining: 0`.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';
import { createProjectFolders, NEW_PROJECT_FOLDER_KINDS } from '../_shared/projectFolders.ts';

const GENERATOR = 'backfillProjectFolders';
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_RUNTIME_MS = 90_000;

/**
 * Count project_folders rows per project_id, paginating through PostgREST's
 * default 1000-row response cap. Without pagination, projects whose rows
 * fall past row 1000 of the response appear to have count=0 — which marks
 * fully-provisioned projects as "missing kinds" and re-processes them
 * indefinitely. Discovered 2026-04-28 when the loop kept reporting
 * remaining=16 after every project was actually complete.
 */
async function fetchFolderCounts(
  // deno-lint-ignore no-explicit-any
  admin: any,
  projectIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('project_folders')
      .select('project_id')
      .in('project_id', projectIds)
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = (data || []) as Array<{ project_id: string }>;
    for (const row of rows) {
      counts.set(row.project_id, (counts.get(row.project_id) || 0) + 1);
    }
    if (rows.length < PAGE) break;
  }
  return counts;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed. Use POST.', 405, req);
  }

  const user = await getUserFromReq(req).catch(() => null);
  const isServiceRole = user?.id === '__service_role__';
  if (!isServiceRole) {
    if (!user) return errorResponse('Authentication required.', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden: master_admin/admin only.', 403, req);
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const batchSize = typeof body.batch_size === 'number' ? body.batch_size : DEFAULT_BATCH_SIZE;
  const maxRuntimeMs = typeof body.max_runtime_ms === 'number' ? body.max_runtime_ms : DEFAULT_MAX_RUNTIME_MS;
  const mode = body.mode === 'missing_kinds' ? 'missing_kinds' : 'unprovisioned';

  const admin = getAdminClient();
  const startedAt = Date.now();
  const errors: Array<{ project_id: string; error: string }> = [];
  let processed = 0;

  type Candidate = { id: string; property_address: string | null };
  let candidates: Candidate[] = [];

  if (mode === 'unprovisioned') {
    const { data, error: candErr } = await admin
      .from('projects')
      .select('id, property_address')
      .is('dropbox_root_path', null)
      .order('created_at', { ascending: true })
      .limit(batchSize);
    if (candErr) return errorResponse(`Candidate fetch failed: ${candErr.message}`, 500, req);
    candidates = (data || []) as Candidate[];
  } else {
    // missing_kinds: find projects whose project_folders row count is below
    // the current NEW_PROJECT_FOLDER_KINDS catalog. Pulled in two steps so we
    // can compare counts client-side without a join (admin client is plenty
    // fast for this — we only ship batchSize candidates per call).
    //
    // Skip projects whose dropbox_root_path points at the legacy
    // `/FlexMedia/Projects/...` location (pre team-folder migration). The
    // current Dropbox token has no_write_permission on that tree, so re-running
    // createProjectFolders against them just churns errors. Those projects
    // need a separate path-rewrite + file-move migration before they can be
    // backfilled.
    const expectedCount = NEW_PROJECT_FOLDER_KINDS.length;
    const { data: provisioned, error: provErr } = await admin
      .from('projects')
      .select('id, property_address')
      .like('dropbox_root_path', '/Flex Media Team Folder/%')
      .order('created_at', { ascending: true })
      .limit(2000);
    if (provErr) return errorResponse(`Candidate fetch failed: ${provErr.message}`, 500, req);

    const projIds = (provisioned || []).map((p) => p.id);
    if (projIds.length > 0) {
      const counts = await fetchFolderCounts(admin, projIds);
      candidates = ((provisioned || []) as Candidate[])
        .filter((p) => (counts.get(p.id) || 0) < expectedCount)
        .slice(0, batchSize);
    }
  }

  for (const proj of candidates) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      console.log(`[${GENERATOR}] hit max_runtime_ms after ${processed} projects`);
      break;
    }
    try {
      await createProjectFolders(proj.id, proj.property_address || null, { actorType: 'system' });
      processed++;
    } catch (err) {
      const msg = err instanceof Error
        ? err.message
        : (typeof err === 'object' && err !== null
            ? (JSON.stringify(err).slice(0, 500) || String(err))
            : String(err));
      console.warn(`[${GENERATOR}] project ${proj.id} failed: ${msg}`);
      errors.push({ project_id: proj.id, error: msg });
    }
  }

  // How many still need provisioning?
  let remaining = 0;
  if (mode === 'unprovisioned') {
    const { count } = await admin
      .from('projects')
      .select('id', { count: 'exact', head: true })
      .is('dropbox_root_path', null);
    remaining = count ?? 0;
  } else {
    const expectedCount = NEW_PROJECT_FOLDER_KINDS.length;
    const { data: provisioned } = await admin
      .from('projects')
      .select('id')
      .like('dropbox_root_path', '/Flex Media Team Folder/%')
      .limit(2000);
    const projIds = (provisioned || []).map((p) => p.id);
    if (projIds.length > 0) {
      const counts = await fetchFolderCounts(admin, projIds);
      remaining = projIds.filter((id) => (counts.get(id) || 0) < expectedCount).length;
    }
  }

  return jsonResponse({
    processed,
    errors,
    remaining,
    mode,
    elapsed_ms: Date.now() - startedAt,
  }, 200, req);
});

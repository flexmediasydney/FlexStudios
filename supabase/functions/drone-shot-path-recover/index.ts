/**
 * drone-shot-path-recover (W8 FIX 1 one-shot)
 * ─────────────────────────────────────────────
 * Wave 8 admin recovery for drone_shots rows whose `edited_dropbox_path`
 * was written in lowercase by the legacy webhook fallback to
 * `entry.path_lower`. Dropbox is case-sensitive on /files/download even
 * though listings/searches are case-insensitive — so the lowercase rows
 * have been 409'ing (`path/not_found`) on every render_edited attempt.
 *
 * Behavior:
 *   POST { project_id, dry_run?:boolean=false, reenqueue?:boolean=true }
 *
 *   1. Fetches the project's `dropbox_root_path`.
 *   2. Lists `<root>/Drones/Editors/Edited Post Production` (recursive=false).
 *   3. For each drone_shots row in that project with a lowercase
 *      edited_dropbox_path (heuristic: starts with '/flex media' OR has
 *      no uppercase letters at all), looks up the matching entry by
 *      basename (case-insensitive) and rewrites the column with
 *      `entry.path_display`.
 *   4. If `reenqueue`, finds any pending render_edited jobs for those
 *      shots whose error_message includes 'path/not_found' and INSERTs a
 *      fresh pending job per shot (mig 282's unique partial index dedupes).
 *      Then marks the failed jobs as 'cancelled' so the dispatcher stops
 *      re-attempting the broken paths.
 *
 * Auth: master_admin / admin only.
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

const GENERATOR = 'drone-shot-path-recover';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Auth — admin only. Service-role JWT bypass for one-shot recoveries.
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('Unauthorized', 401, req);
  const admin = getAdminClient();
  if (user.id !== '__service_role__') {
    const { data: u } = await admin.from('users').select('role').eq('id', user.id).maybeSingle();
    if (!u || (u.role !== 'master_admin' && u.role !== 'admin')) {
      return errorResponse('Admin only', 403, req);
    }
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const projectId = (body.project_id ?? body.projectId) as string | undefined;
  const dryRun = body.dry_run === true;
  const reenqueue = body.reenqueue !== false; // default true

  if (!projectId) return errorResponse('project_id required', 400, req);

  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr || !project) return errorResponse(`project lookup failed: ${projErr?.message || 'not found'}`, 404, req);

  const rootPath = project.dropbox_root_path as string | null;
  if (!rootPath) return errorResponse('project has no dropbox_root_path', 400, req);

  // Try the editor folder; if missing, fall back to a recursive scan of
  // the project root drones folder so we still find the renamed/moved files.
  const editorPath = `${rootPath}/Drones/Editors/Edited Post Production`;
  let entries;
  let listingPath = editorPath;
  try {
    const res = await listFolder(editorPath, { recursive: false, maxEntries: 2000 });
    entries = res.entries;
    if (entries.length === 0) {
      const fallback = `${rootPath}/Drones`;
      const res2 = await listFolder(fallback, { recursive: true, maxEntries: 5000 });
      entries = res2.entries;
      listingPath = fallback + ' (recursive)';
    }
  } catch (err) {
    // Editor folder missing — recursive scan of /Drones.
    try {
      const fallback = `${rootPath}/Drones`;
      const res2 = await listFolder(fallback, { recursive: true, maxEntries: 5000 });
      entries = res2.entries;
      listingPath = fallback + ' (recursive)';
    } catch (err2) {
      return errorResponse(`Dropbox listFolder failed for both ${editorPath} and ${rootPath}/Drones: ${err2 instanceof Error ? err2.message : String(err2)}`, 502, req);
    }
  }

  // Build a map of basename(lower) → path_display.
  const byName = new Map<string, string>();
  for (const e of entries) {
    if ((e as { ['.tag']?: string })['.tag'] === 'folder') continue;
    const display = (e as { path_display?: string }).path_display;
    const name = (e as { name?: string }).name;
    if (display && name) byName.set(name.toLowerCase(), display);
  }

  // 2. Find candidate shots in this project with lowercase paths.
  const { data: shots, error: shotsErr } = await admin
    .from('drone_shots')
    .select('id, edited_dropbox_path, drone_shoots!inner(project_id)')
    .eq('drone_shoots.project_id', projectId)
    .not('edited_dropbox_path', 'is', null);
  if (shotsErr) return errorResponse(`shot lookup failed: ${shotsErr.message}`, 500, req);

  const candidates: Array<{ id: string; old: string; new: string }> = [];
  for (const s of (shots || []) as Array<{ id: string; edited_dropbox_path: string }>) {
    const old = s.edited_dropbox_path;
    if (!old) continue;
    // Heuristic: lowercase if it has no uppercase letters in the path.
    const hasUpper = /[A-Z]/.test(old);
    if (hasUpper) continue;
    const baseName = old.split('/').pop();
    if (!baseName) continue;
    const corrected = byName.get(baseName.toLowerCase());
    if (!corrected) continue; // skip if not in editor folder listing
    if (corrected !== old) {
      candidates.push({ id: s.id, old, new: corrected });
    }
  }

  if (dryRun) {
    const editedSamples = entries
      .filter((e: { name?: string }) => /_edited\.(jpe?g|png|tiff?)$/i.test(e.name || ''))
      .slice(0, 10)
      .map((e: { name?: string; path_display?: string }) => ({ name: e.name, path_display: e.path_display }));
    return jsonResponse({
      success: true,
      dry_run: true,
      would_update: candidates,
      listing_entries: entries.length,
      listing_path: listingPath,
      edited_samples: editedSamples,
      candidate_basenames: (shots || []).filter((s: { edited_dropbox_path: string | null }) => s.edited_dropbox_path && !/[A-Z]/.test(s.edited_dropbox_path)).map((s: { edited_dropbox_path: string }) => s.edited_dropbox_path.split('/').pop()),
    }, 200, req);
  }

  // 3. Update rows.
  const updated: string[] = [];
  for (const c of candidates) {
    const { error: updErr } = await admin
      .from('drone_shots')
      .update({ edited_dropbox_path: c.new })
      .eq('id', c.id);
    if (updErr) {
      console.warn(`[${GENERATOR}] update failed for shot ${c.id}: ${updErr.message}`);
      continue;
    }
    updated.push(c.id);
  }

  // 4. Re-enqueue (cancel old failed jobs + insert fresh pending ones).
  let reenqueued = 0;
  let cancelled = 0;
  if (reenqueue && updated.length > 0) {
    // Cancel any pending render_edited jobs that errored on path/not_found
    // for these shots (they would otherwise keep retrying with stale paths).
    for (const shotId of updated) {
      const { data: stale, error: staleErr } = await admin
        .from('drone_jobs')
        .select('id, status, error_message, payload, shoot_id')
        .eq('kind', 'render_edited')
        .filter('payload->>shot_id', 'eq', shotId)
        .in('status', ['pending', 'failed'])
        .order('created_at', { ascending: false });
      if (staleErr) {
        console.warn(`[${GENERATOR}] stale-job lookup failed for ${shotId}: ${staleErr.message}`);
        continue;
      }
      for (const j of (stale || []) as Array<{ id: string; status: string; error_message: string | null; payload: Record<string, unknown>; shoot_id: string | null }>) {
        // Cancel any pending job — once dead-lettered the unique partial index
        // (which keys on status IN ('pending','running')) frees up so we can
        // insert fresh. QC iter 5 P1-3: drone_jobs.status CHECK only allows
        // (pending,running,succeeded,failed,dead_letter) — 'cancelled' was a
        // 23514. Use 'dead_letter' to convey the same intent ("operator
        // intervention superseded this row") within the allowed enum.
        if (j.status === 'pending' || (j.status === 'failed' && (j.error_message || '').includes('path/not_found'))) {
          const { error: cancelErr } = await admin
            .from('drone_jobs')
            .update({
              status: 'dead_letter',
              error_message: `${j.error_message || ''} | superseded by ${GENERATOR}`,
              finished_at: new Date().toISOString(),
            })
            .eq('id', j.id);
          if (cancelErr) {
            console.warn(`[${GENERATOR}] supersede flip failed for ${j.id}: ${cancelErr.message}`);
            continue; // Don't increment + don't re-enqueue if we couldn't free the slot
          }
          cancelled += 1;
        }
      }

      // Insert a fresh pending render_edited job for this shot.
      const sh = (stale && stale[0]) as { shoot_id: string | null } | undefined;
      const shootId = sh?.shoot_id || null;
      const { error: jobErr } = await admin
        .from('drone_jobs')
        .insert({
          project_id: projectId,
          shoot_id: shootId,
          shot_id: shotId, // Wave 11 S2 Cluster D — surface per-shot identity at top level for joins/audit
          kind: 'render_edited',
          status: 'pending',
          pipeline: 'edited',
          payload: {
            shot_id: shotId,
            shoot_id: shootId,
            reason: 'qc4_wave8_path_recover',
            cascade: false,
            pipeline: 'edited',
            wipe_existing: true,
            column_state: 'pool',
          },
        });
      if (!jobErr) reenqueued += 1;
      else console.warn(`[${GENERATOR}] re-enqueue insert failed for ${shotId}: ${jobErr.message}`);
    }
  }

  return jsonResponse(
    {
      success: true,
      project_id: projectId,
      candidates: candidates.length,
      updated: updated.length,
      reenqueued,
      cancelled,
      updated_ids: updated,
    },
    200,
    req,
  );
});

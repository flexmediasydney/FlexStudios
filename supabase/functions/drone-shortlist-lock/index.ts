/**
 * drone-shortlist-lock
 * ────────────────────
 * Per-shoot batch action invoked from the swimlane "Lock shortlist" button.
 *
 * After the operator has triaged Raw Proposed shots into Raw Accepted /
 * Rejected (and SfM-grid nadirs were auto-routed to sfm_only at ingest), this
 * function physically reorganises the underlying Dropbox files so the team
 * can browse Drones/Raws/{Final Shortlist, Rejected, Others}/ alongside the
 * app and see the curated state.
 *
 * For each drone_shots row in the shoot:
 *   lifecycle_state='raw_accepted' → move file to Drones/Raws/Final Shortlist/
 *   lifecycle_state='rejected'      → move file to Drones/Raws/Rejected/
 *   lifecycle_state='sfm_only'      → move file to Drones/Raws/Others/
 *   lifecycle_state='raw_proposed'  → leave alone (operator hasn't decided yet)
 *
 * After each successful move, drone_shots.dropbox_path is updated to the new
 * Dropbox path so subsequent media-proxy calls + downstream renders resolve
 * correctly.
 *
 * Idempotent: a shot whose dropbox_path is already under the destination
 * folder is skipped without an API call. Re-running after a partial failure
 * picks up where it left off.
 *
 * POST { shoot_id }
 *
 * Auth: master_admin / admin / manager / employee. Contractors are excluded
 * (they shouldn't be reorganising raw files).
 *
 * Response:
 *   { success, moved: { accepted, rejected, sfm_only }, skipped, errors }
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { getFolderPath } from '../_shared/projectFolders.ts';
import { moveFile } from '../_shared/dropbox.ts';

const GENERATOR = 'drone-shortlist-lock';

interface ShotRow {
  id: string;
  filename: string | null;
  dropbox_path: string | null;
  shot_role: string | null;
  lifecycle_state: string | null;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role || '')) {
      return errorResponse('Forbidden — only master_admin/admin/manager/employee can lock shortlist', 403, req);
    }
  }

  let body: { shoot_id?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const shootId = body.shoot_id?.trim();
  if (!shootId) return errorResponse('shoot_id required', 400, req);

  const admin = getAdminClient();

  // ── Load shoot + project ────────────────────────────────────────────────
  const { data: shoot, error: shootErr } = await admin
    .from('drone_shoots')
    .select('id, project_id')
    .eq('id', shootId)
    .maybeSingle();
  if (shootErr) return errorResponse(`shoot lookup failed: ${shootErr.message}`, 500, req);
  if (!shoot) return errorResponse(`shoot ${shootId} not found`, 404, req);

  // ── Resolve destination folder paths ────────────────────────────────────
  const [finalShortlistPath, rejectedPath, othersPath] = await Promise.all([
    getFolderPath(shoot.project_id, 'drones_raws_final_shortlist'),
    getFolderPath(shoot.project_id, 'drones_raws_rejected'),
    getFolderPath(shoot.project_id, 'drones_raws_others'),
  ]);

  if (!finalShortlistPath || !rejectedPath || !othersPath) {
    return errorResponse(
      'Project folders not provisioned — run drone-folder-backfill for this project first',
      500,
      req,
    );
  }

  // ── Load all shots in the shoot ─────────────────────────────────────────
  const { data: shots, error: shotsErr } = await admin
    .from('drone_shots')
    .select('id, filename, dropbox_path, shot_role, lifecycle_state')
    .eq('shoot_id', shootId);
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);

  // ── Per-lifecycle dest map ──────────────────────────────────────────────
  const destByState: Record<string, string> = {
    raw_accepted: finalShortlistPath,
    rejected: rejectedPath,
    sfm_only: othersPath,
  };

  let movedAccepted = 0;
  let movedRejected = 0;
  let movedSfmOnly = 0;
  let skipped = 0;
  const errors: Array<{ shot_id: string; filename: string | null; message: string }> = [];

  for (const s of (shots as ShotRow[]) || []) {
    const dest = destByState[s.lifecycle_state || ''];
    if (!dest) continue;                            // raw_proposed / unknown → skip
    if (!s.dropbox_path || !s.filename) continue;   // can't move what we don't know

    // Idempotent: if the file is already in the destination folder, skip.
    // Use a case-insensitive prefix check (Dropbox path-case can drift).
    const destPrefixLc = dest.toLowerCase().replace(/\/+$/, '') + '/';
    if (s.dropbox_path.toLowerCase().startsWith(destPrefixLc)) {
      skipped++;
      continue;
    }

    const newPath = `${dest.replace(/\/+$/, '')}/${s.filename}`;
    try {
      const meta = await moveFile(s.dropbox_path, newPath);
      const finalPath = meta?.path_display || newPath;

      const { error: updErr } = await admin
        .from('drone_shots')
        .update({ dropbox_path: finalPath })
        .eq('id', s.id);
      if (updErr) {
        // The file moved but the DB write failed — log and surface so an
        // operator can re-run the lock (the idempotent check above will
        // recognise the moved file and just update the row).
        errors.push({
          shot_id: s.id,
          filename: s.filename,
          message: `moved Dropbox file but DB update failed: ${updErr.message}`,
        });
        continue;
      }

      if (s.lifecycle_state === 'raw_accepted') movedAccepted++;
      else if (s.lifecycle_state === 'rejected') movedRejected++;
      else if (s.lifecycle_state === 'sfm_only') movedSfmOnly++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Dropbox `to/conflict` (file already exists at destination — likely a
      // partial prior run) is non-fatal: we treat it as success and update
      // the DB row to point at the destination. This keeps the operator's
      // view consistent with reality.
      if (msg.includes('to/conflict') || msg.includes('already exists')) {
        const { error: updErr } = await admin
          .from('drone_shots')
          .update({ dropbox_path: newPath })
          .eq('id', s.id);
        if (updErr) {
          errors.push({ shot_id: s.id, filename: s.filename, message: `dest conflict + DB update failed: ${updErr.message}` });
        } else {
          skipped++;
        }
        continue;
      }
      errors.push({ shot_id: s.id, filename: s.filename, message: msg });
    }
  }

  // ── Audit event ─────────────────────────────────────────────────────────
  await admin.from('drone_events').insert({
    project_id: shoot.project_id,
    shoot_id: shoot.id,
    event_type: 'shortlist_locked',
    actor_type: isService ? 'system' : 'user',
    actor_id: isService ? null : user!.id,
    payload: {
      moved: { accepted: movedAccepted, rejected: movedRejected, sfm_only: movedSfmOnly },
      skipped,
      errors_count: errors.length,
    },
  });

  return jsonResponse({
    success: errors.length === 0,
    shoot_id: shootId,
    moved: { accepted: movedAccepted, rejected: movedRejected, sfm_only: movedSfmOnly },
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  }, errors.length === 0 ? 200 : 207, req);
});

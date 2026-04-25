/**
 * drone-render-approve  (Drone Phase 2 Stream K — skeleton-only v1)
 * ─────────────────────────────────────────────────────────────────
 * POST { render_id: string, target_state: 'final' | 'rejected' }
 *   → { success, render }
 *
 * Moves a drone_render row between pipeline columns. v1 scope:
 *   - target_state='final' is allowed only from column_state='adjustments'
 *     (the spec's ADJUSTMENTS → FINAL approval edge).
 *   - target_state='rejected' is allowed from ANY non-rejected column —
 *     drag-out / "Reject" semantics.
 *
 * Auth: master_admin / admin / manager / employee.
 * (Contractor approvals deferred — they can't move work to Final delivery.)
 *
 * Side effects:
 *   - Updates drone_renders.column_state (+ approved_by, approved_at on final).
 *   - Emits a drone_events row with before/after state for audit.
 *
 * Out-of-scope for v1 (future enhancement):
 *   - Copying the rendered file from 06_ENRICHMENT/drone_renders_proposed/ to
 *     07_FINAL_DELIVERY/drones/ (Dropbox sync).
 *   - Notifying downstream delivery worker.
 *   - Re-rendering with adjusted theme.
 *
 * Deployed verify_jwt=false; we authenticate via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';

const GENERATOR = 'drone-render-approve';

type TargetState = 'final' | 'rejected';

interface Body {
  render_id?: string;
  target_state?: TargetState;
  _health_check?: boolean;
}

const ALLOWED_ROLES = ['master_admin', 'admin', 'manager', 'employee'];

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);

  const role = user.role || '';
  if (!ALLOWED_ROLES.includes(role)) {
    return errorResponse(`Role ${role || '(none)'} not permitted`, 403, req);
  }

  // ── Validate body ──────────────────────────────────────────────────────────
  if (!body.render_id || typeof body.render_id !== 'string') {
    return errorResponse('render_id required', 400, req);
  }
  if (body.target_state !== 'final' && body.target_state !== 'rejected') {
    return errorResponse(
      "target_state must be 'final' or 'rejected'",
      400, req,
    );
  }

  const admin = getAdminClient();

  // ── Load the render ────────────────────────────────────────────────────────
  const { data: render, error: fetchErr } = await admin
    .from('drone_renders')
    .select('id, shot_id, column_state, kind, dropbox_path')
    .eq('id', body.render_id)
    .maybeSingle();

  if (fetchErr) {
    console.error(`[${GENERATOR}] fetch render failed:`, fetchErr);
    return errorResponse(`Failed to load render: ${fetchErr.message}`, 500, req);
  }
  if (!render) return errorResponse('render_id not found', 404, req);

  const fromState = render.column_state as string;
  const toState = body.target_state;

  // Transition rules
  if (toState === 'final') {
    if (fromState !== 'adjustments') {
      return errorResponse(
        `Cannot approve to 'final' from '${fromState}' — must be in 'adjustments'`,
        400, req,
      );
    }
  }
  if (toState === 'rejected') {
    if (fromState === 'rejected') {
      return errorResponse('Render is already rejected', 400, req);
    }
  }
  if (fromState === toState) {
    return errorResponse(`Render is already in '${toState}'`, 400, req);
  }

  // ── Resolve project_id (for the audit event) via shot → shoot ──────────────
  const { data: shotRow } = await admin
    .from('drone_shots')
    .select('id, shoot_id')
    .eq('id', render.shot_id)
    .maybeSingle();

  let projectId: string | null = null;
  if (shotRow?.shoot_id) {
    const { data: shootRow } = await admin
      .from('drone_shoots')
      .select('id, project_id')
      .eq('id', shotRow.shoot_id)
      .maybeSingle();
    projectId = shootRow?.project_id ?? null;
  }

  // ── Update column_state ────────────────────────────────────────────────────
  const updatePatch: Record<string, unknown> = { column_state: toState };
  if (toState === 'final') {
    updatePatch.approved_by = user.id === '__service_role__' ? null : user.id;
    updatePatch.approved_at = new Date().toISOString();
  }

  const { data: updated, error: updErr } = await admin
    .from('drone_renders')
    .update(updatePatch)
    .eq('id', body.render_id)
    .select('*')
    .single();

  if (updErr) {
    console.error(`[${GENERATOR}] update failed:`, updErr);
    return errorResponse(`Failed to update render: ${updErr.message}`, 500, req);
  }

  // ── On final transition: copy file from proposed/ to final delivery ────────
  let finalDropboxPath: string | null = null;
  let finalCopyError: string | null = null;
  if (toState === 'final' && projectId && render.dropbox_path) {
    try {
      const { copyFile } = await import('../_shared/dropbox.ts');
      const { getFolderPath } = await import('../_shared/projectFolders.ts');

      const finalFolder = await getFolderPath(projectId, 'final_delivery_drones');
      // Strip the proposed-folder filename from the source path so we can re-mount it
      const filename = render.dropbox_path.split('/').pop() ?? `render_${body.render_id}.jpg`;
      const targetPath = `${finalFolder}/${filename}`;
      const meta = await copyFile(render.dropbox_path, targetPath);
      finalDropboxPath = meta.path_lower ?? targetPath.toLowerCase();
    } catch (copyErr) {
      // Don't reject the approval if the copy fails — log + flag.
      finalCopyError = copyErr instanceof Error ? copyErr.message : String(copyErr);
      console.error(`[${GENERATOR}] final-delivery copy failed: ${finalCopyError}`);
    }
  }

  // ── Emit audit event (best-effort — don't block on failure) ────────────────
  if (projectId) {
    const { error: evErr } = await admin
      .from('drone_events')
      .insert({
        project_id: projectId,
        shoot_id: shotRow?.shoot_id ?? null,
        shot_id: render.shot_id,
        event_type: toState === 'final' ? 'render_approved' : 'render_rejected',
        actor_type: 'user',
        actor_id: user.id === '__service_role__' ? null : user.id,
        payload: {
          render_id: body.render_id,
          from_state: fromState,
          to_state: toState,
          kind: render.kind,
          ...(finalDropboxPath ? { final_dropbox_path: finalDropboxPath } : {}),
          ...(finalCopyError ? { final_copy_error: finalCopyError } : {}),
        },
      });
    if (evErr) {
      console.warn(`[${GENERATOR}] drone_events insert failed: ${evErr.message}`);
    }
  } else {
    console.warn(
      `[${GENERATOR}] no project_id resolved for render ${body.render_id} — skipping audit event`,
    );
  }

  return jsonResponse({ success: true, render: updated }, 200, req);
});

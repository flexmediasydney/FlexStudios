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

type TargetState = 'proposed' | 'adjustments' | 'final' | 'rejected' | 'restore';

interface Body {
  render_id?: string;
  target_state?: TargetState;
  _health_check?: boolean;
}

// Allowed transitions. 'restore' is a magic value — server reads the most
// recent render_rejected event for this render and puts the row back at the
// from_state recorded there.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  proposed:    ['adjustments', 'rejected'],
  adjustments: ['proposed', 'final', 'rejected'],
  final:       ['adjustments', 'rejected'],
  rejected:    ['restore'],
};

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
  const validTargets: TargetState[] = ['proposed', 'adjustments', 'final', 'rejected', 'restore'];
  if (!validTargets.includes(body.target_state as TargetState)) {
    return errorResponse(
      `target_state must be one of: ${validTargets.join(', ')}`,
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
  let toState = body.target_state as TargetState;

  // Resolve 'restore' → look up the most recent render_rejected event and
  // put the row back at whatever column it was in before being rejected.
  if (toState === 'restore') {
    if (fromState !== 'rejected') {
      return errorResponse(
        `'restore' is only valid for currently-rejected renders (got '${fromState}')`,
        400, req,
      );
    }
    const admin0 = getAdminClient();
    const { data: lastReject } = await admin0
      .from('drone_events')
      .select('payload, created_at')
      .eq('event_type', 'render_rejected')
      .filter('payload->>render_id', 'eq', body.render_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const restored = (lastReject?.payload as { from_state?: string } | null)?.from_state;
    if (!restored || !['proposed', 'adjustments', 'final'].includes(restored)) {
      // No prior reject event recorded — fall back to 'proposed' so the user
      // can recover something rather than be stuck.
      toState = 'proposed' as TargetState;
    } else {
      toState = restored as TargetState;
    }
  }

  // Transition allow-list. Same-state requests are no-ops.
  if (fromState === toState) {
    return errorResponse(`Render is already in '${toState}'`, 400, req);
  }
  const allowed = ALLOWED_TRANSITIONS[fromState] || [];
  // 'restore' was already resolved above to a concrete state, so its target
  // (proposed/adjustments/final) needs to be checked against the rejected →
  // restore edge specifically.
  const isRestoreEdge = body.target_state === 'restore' && fromState === 'rejected';
  if (!isRestoreEdge && !allowed.includes(body.target_state as string)) {
    return errorResponse(
      `Cannot transition '${fromState}' → '${body.target_state}' (allowed: ${allowed.join(', ') || 'none'})`,
      400, req,
    );
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

  // ── On un-approve (final → adjustments): delete the orphaned final-delivery
  // copy. Without this, a Final approval that gets rolled back leaves a stale
  // file in 07_FINAL_DELIVERY/drones/ that downstream delivery would treat as
  // approved. Idempotent — deleteFile swallows path/not_found.
  let finalDeleteError: string | null = null;
  if (fromState === 'final' && toState === 'adjustments' && projectId && render.dropbox_path) {
    try {
      const { deleteFile } = await import('../_shared/dropbox.ts');
      const { getFolderPath } = await import('../_shared/projectFolders.ts');
      const finalFolder = await getFolderPath(projectId, 'final_delivery_drones');
      const filename = render.dropbox_path.split('/').pop() ?? `render_${body.render_id}.jpg`;
      const targetPath = `${finalFolder}/${filename}`;
      await deleteFile(targetPath);
    } catch (delErr) {
      // Don't reject the rollback if cleanup fails — flag in audit so an
      // operator can manually delete from Dropbox.
      finalDeleteError = delErr instanceof Error ? delErr.message : String(delErr);
      console.error(`[${GENERATOR}] final-delivery cleanup failed: ${finalDeleteError}`);
    }
  }

  // ── Emit audit event (best-effort — don't block on failure) ────────────────
  const eventType =
    toState === 'final' ? 'render_approved'
    : toState === 'rejected' ? 'render_rejected'
    : body.target_state === 'restore' ? 'render_restored'
    : 'render_moved';
  if (projectId) {
    const { error: evErr } = await admin
      .from('drone_events')
      .insert({
        project_id: projectId,
        shoot_id: shotRow?.shoot_id ?? null,
        shot_id: render.shot_id,
        event_type: eventType,
        actor_type: 'user',
        actor_id: user.id === '__service_role__' ? null : user.id,
        payload: {
          render_id: body.render_id,
          from_state: fromState,
          to_state: toState,
          kind: render.kind,
          ...(finalDropboxPath ? { final_dropbox_path: finalDropboxPath } : {}),
          ...(finalCopyError ? { final_copy_error: finalCopyError } : {}),
          ...(finalDeleteError ? { final_delete_error: finalDeleteError } : {}),
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

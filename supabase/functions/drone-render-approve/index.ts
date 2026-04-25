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

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);
  const isService = user.id === '__service_role__';

  // Health check is post-auth so unauthenticated probers can't enumerate
  // function versions / deployment metadata. (#1 audit fix)
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  // Service-role is permitted (future automated approval pipelines).
  // Otherwise the user must hold one of ALLOWED_ROLES. (#21 audit fix)
  const role = user.role || '';
  if (!isService && !ALLOWED_ROLES.includes(role)) {
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
    .select('id, shot_id, column_state, kind, dropbox_path, output_variant')
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
  //
  // Audit #23: a render that's been through reject→restore→reject would
  // pick up the FIRST rejection's from_state if we only ordered by
  // created_at desc and stopped at the most recent render_rejected. We must
  // find the rejection that happened AFTER the last restore (if any) so we
  // restore to the column that was occupied by THIS rejection cycle, not the
  // one before it.
  if (toState === 'restore') {
    if (fromState !== 'rejected') {
      return errorResponse(
        `'restore' is only valid for currently-rejected renders (got '${fromState}')`,
        400, req,
      );
    }
    const admin0 = getAdminClient();
    // Find the most recent prior 'render_restored' event, if any.
    const { data: lastRestoreEvent } = await admin0
      .from('drone_events')
      .select('created_at')
      .eq('event_type', 'render_restored')
      .filter('payload->>render_id', 'eq', body.render_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastRestoreAt = lastRestoreEvent?.created_at as string | undefined;
    // Find the most recent render_rejected AFTER any prior restore.
    let rejectQ = admin0
      .from('drone_events')
      .select('payload, created_at')
      .eq('event_type', 'render_rejected')
      .filter('payload->>render_id', 'eq', body.render_id)
      .order('created_at', { ascending: false })
      .limit(1);
    if (lastRestoreAt) rejectQ = rejectQ.gt('created_at', lastRestoreAt);
    const { data: lastReject } = await rejectQ.maybeSingle();
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
  // drone_events.project_id is NOT NULL in the schema, so a missing project_id
  // means we silently drop the audit event. Try harder: shot → shoot first,
  // then fall back to looking up the shoot via project_folders that prefix
  // the render's dropbox_path. (#25 audit fix)
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

  // Fallback A: render row has shot_id but the shot was hard-deleted. Walk
  // back via shoot_id (sometimes drone_renders carries shoot_id directly via
  // FK denormalisation in older snapshots — defensive cast guards against
  // schema drift).
  if (!projectId) {
    const renderShootId = (render as { shoot_id?: string | null }).shoot_id;
    if (renderShootId) {
      const { data: shootRow2 } = await admin
        .from('drone_shoots')
        .select('id, project_id')
        .eq('id', renderShootId)
        .maybeSingle();
      projectId = shootRow2?.project_id ?? null;
    }
  }

  // Fallback B: derive from the render's dropbox_path → project_folders.
  // The render landed somewhere under 06_ENRICHMENT/.../<project>/... so
  // longest-prefix-match against project_folders gives us the owner.
  if (!projectId && render.dropbox_path) {
    const { data: folderHit } = await admin
      .from('project_folders')
      .select('project_id, dropbox_path')
      .ilike('dropbox_path', '%/' + render.dropbox_path.split('/').slice(2, 4).join('/') + '%')
      .limit(1)
      .maybeSingle();
    projectId = folderHit?.project_id ?? null;
    if (projectId) {
      console.warn(
        `[${GENERATOR}] resolved project_id ${projectId} for render ${body.render_id} via dropbox_path fallback (shot/shoot lookup missed)`,
      );
    }
  }

  // ── Auto-supersede prior occupant of the target slot ─────────────────────
  // The uniq_drone_renders_active_per_variant index (migration 233) prevents
  // two active rows sharing (shot_id, kind, variant, column_state). If a Pin-
  // Editor re-render already filled the 'adjustments' slot for this shot/
  // kind/variant, then trying to move a 'proposed' row to 'adjustments' would
  // hit the unique constraint and 500. Pre-emptively kick the prior occupant
  // to 'rejected' (preserving its history) so the move can proceed. (#B1 audit fix)
  if (['proposed', 'adjustments', 'final'].includes(toState as string)) {
    const targetVariant = (render as { output_variant?: string | null }).output_variant ?? null;
    const { data: priorOccupants } = await admin
      .from('drone_renders')
      .select('id, output_variant')
      .eq('shot_id', render.shot_id)
      .eq('kind', render.kind)
      .eq('column_state', toState)
      .neq('id', body.render_id);
    const sameVariantIds = (priorOccupants || [])
      .filter((r) => (r.output_variant ?? null) === targetVariant)
      .map((r) => r.id);
    if (sameVariantIds.length > 0) {
      await admin
        .from('drone_renders')
        .update({ column_state: 'rejected' })
        .in('id', sameVariantIds);
    }
  }

  // ── Update column_state ────────────────────────────────────────────────────
  const updatePatch: Record<string, unknown> = { column_state: toState };
  if (toState === 'final') {
    updatePatch.approved_by = isService ? null : user.id;
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

  // ── On final transition: copy file to Final Enriched/ AND Drones/Finals/ ──
  // Two-step delivery copy:
  //   1. Copy from current location (typically `Drones/Editors/AI Proposed
  //      Enriched/...`) → `Drones/Editors/Final Enriched/<filename>`. This
  //      is the primary "approved" location editors and downstream consumers
  //      of `drone_renders.dropbox_path` watch.
  //   2. ALSO copy → `Drones/Finals/<filename>`. The Finals/ folder is the
  //      operator-facing top-level deliverable bucket. Per orchestrator's
  //      decision, we record the Finals path on the drone_events row instead
  //      of adding a `drone_renders.finals_dropbox_path` column (less schema
  //      churn).
  //
  // Backward-compat: if the project hasn't been backfilled yet (legacy
  // structure with `final_delivery_drones` only), fall back to that single
  // path — `final_delivery_drones` was rewritten by the drone-folder-backfill
  // to point at `Drones/Finals` already, so legacy projects still get the
  // file in the right place.
  let finalEnrichedPath: string | null = null;
  let finalsCopyPath: string | null = null;
  let finalCopyError: string | null = null;
  let finalsCopyError: string | null = null;
  if (toState === 'final' && projectId && render.dropbox_path) {
    const filename = render.dropbox_path.split('/').pop() as string;
    const { copyFile } = await import('../_shared/dropbox.ts');
    const { getFolderPath } = await import('../_shared/projectFolders.ts');

    // Step 1: copy → Final Enriched (preferred new path), with legacy fallback.
    let finalEnrichedFolder: string | null = null;
    try {
      finalEnrichedFolder = await getFolderPath(projectId, 'drones_editors_final_enriched');
    } catch {
      // Project hasn't been backfilled. Use the legacy slot which points at
      // Drones/Finals after the backfill rewrite.
      try {
        finalEnrichedFolder = await getFolderPath(projectId, 'final_delivery_drones');
      } catch (legacyErr) {
        finalCopyError = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        console.error(`[${GENERATOR}] no final-delivery folder for project ${projectId}: ${finalCopyError}`);
      }
    }

    if (finalEnrichedFolder) {
      try {
        const targetPath = `${finalEnrichedFolder}/${filename}`;
        const meta = await copyFile(render.dropbox_path, targetPath);
        finalEnrichedPath = meta.path_lower ?? targetPath.toLowerCase();
      } catch (copyErr) {
        // Don't reject the approval if the copy fails — log + flag.
        finalCopyError = copyErr instanceof Error ? copyErr.message : String(copyErr);
        console.error(`[${GENERATOR}] Final Enriched copy failed: ${finalCopyError}`);
      }
    }

    // Step 2: ALSO copy → Drones/Finals/<filename>. This step is independent
    // of step 1 — even if Final Enriched is missing (legacy project), the
    // operator-facing Finals bucket should still receive the deliverable. Use
    // the Final Enriched copy as source if available (avoids re-pulling from
    // the proposed folder), else fall back to the original render path.
    try {
      const finalsFolder = await getFolderPath(projectId, 'drones_finals');
      const finalsTarget = `${finalsFolder}/${filename}`;
      // Skip if Final Enriched and Drones/Finals resolved to the same path
      // (some legacy backfill scenarios remap final_delivery_drones to
      // Drones/Finals — copying file-to-itself raises Dropbox conflict).
      if (finalEnrichedPath && finalEnrichedPath.toLowerCase() === finalsTarget.toLowerCase()) {
        finalsCopyPath = finalEnrichedPath;
      } else {
        const sourceForFinals = finalEnrichedPath || render.dropbox_path;
        const meta2 = await copyFile(sourceForFinals, finalsTarget);
        finalsCopyPath = meta2.path_lower ?? finalsTarget.toLowerCase();
      }
    } catch (finalsErr) {
      // Don't reject the approval if the Finals copy fails — log + flag.
      // This may happen on legacy projects that haven't been backfilled and
      // therefore have no `drones_finals` project_folders row.
      finalsCopyError = finalsErr instanceof Error ? finalsErr.message : String(finalsErr);
      console.error(`[${GENERATOR}] Drones/Finals copy failed: ${finalsCopyError}`);
    }
  }

  // ── On un-approve (final → adjustments): delete the orphaned final-delivery
  // copies in BOTH locations. Without this, a Final approval that gets rolled
  // back leaves stale files in Final Enriched and Drones/Finals. Idempotent —
  // deleteFile swallows path/not_found.
  let finalDeleteError: string | null = null;
  if (fromState === 'final' && toState === 'adjustments' && projectId && render.dropbox_path) {
    try {
      const { deleteFile } = await import('../_shared/dropbox.ts');
      const { getFolderPath } = await import('../_shared/projectFolders.ts');
      // dropbox_path is NOT NULL — drop the dead `??` fallback. (#26 audit)
      const filename = render.dropbox_path.split('/').pop() as string;
      // Try every finals-side folder in priority order; ignore individual
      // misses since the file may only live in one.
      for (const kind of ['drones_editors_final_enriched', 'drones_finals', 'final_delivery_drones'] as const) {
        try {
          const folder = await getFolderPath(projectId, kind);
          await deleteFile(`${folder}/${filename}`);
        } catch {
          // Folder not provisioned for this project; skip.
        }
      }
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
        actor_type: isService ? 'system' : 'user',
        actor_id: isService ? null : user.id,
        payload: {
          render_id: body.render_id,
          from_state: fromState,
          to_state: toState,
          kind: render.kind,
          // final_dropbox_path is the Final Enriched location (primary) —
          // kept under the same key for backward-compat with downstream
          // readers that already grep for it.
          ...(finalEnrichedPath ? { final_dropbox_path: finalEnrichedPath } : {}),
          // finals_dropbox_path is the operator-facing Drones/Finals copy.
          // We record it on the event rather than on the drone_renders row
          // (orchestrator decision: less schema churn).
          ...(finalsCopyPath ? { finals_dropbox_path: finalsCopyPath } : {}),
          ...(finalCopyError ? { final_copy_error: finalCopyError } : {}),
          ...(finalsCopyError ? { finals_copy_error: finalsCopyError } : {}),
          ...(finalDeleteError ? { final_delete_error: finalDeleteError } : {}),
        },
      });
    if (evErr) {
      console.warn(`[${GENERATOR}] drone_events insert failed: ${evErr.message}`);
    }
  } else {
    // (#25 audit) project_id is NOT NULL on drone_events; without it we can't
    // record the audit. Log LOUDLY (error, not warn) with full context so
    // ops can spot orphaned approvals in the function logs and reconcile.
    console.error(
      JSON.stringify({
        fn: GENERATOR,
        level: 'error',
        msg: 'project_id_unresolved_audit_skipped',
        render_id: body.render_id,
        shot_id: render.shot_id,
        from_state: fromState,
        to_state: toState,
        actor_id: isService ? null : user.id,
        dropbox_path: render.dropbox_path,
        kind: render.kind,
      }),
    );
  }

  return jsonResponse({ success: true, render: updated }, 200, req);
});

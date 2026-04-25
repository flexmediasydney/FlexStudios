/**
 * drone-shot-lifecycle — operator action handler for Raw Proposed/Accepted
 * lifecycle transitions.
 *
 * POST { shot_id, target: 'raw_accepted' | 'rejected' | 'raw_proposed' }
 *   → { success, shot, no_op? }
 *
 * Why an Edge Function instead of `DroneShot.update` directly from the client:
 *   1. Audit trail — every operator-driven lifecycle change emits a
 *      drone_events row with from/to state, actor, project_id. Direct
 *      updates bypass this and the audit log silently rots.
 *   2. Auth — RLS allows `manager` and `employee` to update drone_shots
 *      column-by-column via PostgREST, which is too coarse: contractors
 *      should never trigger a lifecycle flip. We enforce the role gate
 *      explicitly here.
 *   3. Idempotency — repeated clicks (typical when an operator double-taps
 *      a card) shouldn't generate duplicate audit rows. The function no-ops
 *      cleanly when the shot is already at the target state.
 *
 * Note on Dropbox folder reorganisation: physical file moves between
 * Drones/Raws/{Final Shortlist, Rejected, Others}/ are still triggered by
 * `drone-shortlist-lock` (the explicit "Lock shortlist" button) — NOT by
 * each individual lifecycle flip. Per-click moves would produce inconsistent
 * folder state if the operator flips raw_proposed → raw_accepted → rejected
 * (the file would Lock-then-restore-then-Lock and its Dropbox path would
 * thrash). This function only updates the app-side `drone_shots.lifecycle_state`
 * column + emits the audit event.
 *
 * Auth: master_admin / admin / manager / employee. Contractors are excluded.
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

const GENERATOR = 'drone-shot-lifecycle';

type LifecycleTarget = 'raw_proposed' | 'raw_accepted' | 'rejected';

interface Body {
  shot_id?: string;
  target?: LifecycleTarget;
  _health_check?: boolean;
}

const VALID_TARGETS: LifecycleTarget[] = ['raw_proposed', 'raw_accepted', 'rejected'];
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

  // Health check after auth so unauthenticated probers can't enumerate
  // function versions.
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const role = user.role || '';
  if (!isService && !ALLOWED_ROLES.includes(role)) {
    return errorResponse(`Role ${role || '(none)'} not permitted`, 403, req);
  }

  // ── Validate body ─────────────────────────────────────────────────────────
  if (!body.shot_id || typeof body.shot_id !== 'string') {
    return errorResponse('shot_id required', 400, req);
  }
  if (!VALID_TARGETS.includes(body.target as LifecycleTarget)) {
    return errorResponse(
      `target must be one of: ${VALID_TARGETS.join(', ')}`,
      400, req,
    );
  }

  const target = body.target as LifecycleTarget;
  const admin = getAdminClient();

  // ── Load the shot (incl. shoot_id → project_id for audit attribution) ─────
  const { data: shot, error: fetchErr } = await admin
    .from('drone_shots')
    .select('id, shoot_id, lifecycle_state, filename, dropbox_path, shot_role')
    .eq('id', body.shot_id)
    .maybeSingle();

  if (fetchErr) {
    console.error(`[${GENERATOR}] fetch shot failed:`, fetchErr);
    return errorResponse(`Failed to load shot: ${fetchErr.message}`, 500, req);
  }
  if (!shot) return errorResponse('shot_id not found', 404, req);

  // SfM-only shots are nadir-grid alignment frames — they never appear in the
  // operator swimlane and shouldn't be re-routed via this function. Reject
  // the request explicitly so an upstream UI bug doesn't silently corrupt
  // the lifecycle bucket.
  if (shot.lifecycle_state === 'sfm_only') {
    return errorResponse(
      'Cannot transition an sfm_only shot via this function (used for camera alignment, not delivery)',
      400, req,
    );
  }

  const fromState = (shot.lifecycle_state as string | null) || 'raw_proposed';

  // ── Idempotent no-op when already at target ──────────────────────────────
  // Repeated clicks (operator double-tap) should be safe and not produce
  // duplicate drone_events rows. Return a no_op flag so the client can
  // distinguish "you already did this" from "this just happened".
  if (fromState === target) {
    return jsonResponse({ success: true, shot, no_op: true }, 200, req);
  }

  // ── Resolve project_id via shoot for audit attribution ────────────────────
  let projectId: string | null = null;
  if (shot.shoot_id) {
    const { data: shootRow } = await admin
      .from('drone_shoots')
      .select('id, project_id')
      .eq('id', shot.shoot_id)
      .maybeSingle();
    projectId = shootRow?.project_id ?? null;
  }

  // ── Update lifecycle_state ────────────────────────────────────────────────
  const { data: updated, error: updErr } = await admin
    .from('drone_shots')
    .update({ lifecycle_state: target })
    .eq('id', body.shot_id)
    .select('*')
    .single();

  if (updErr) {
    console.error(`[${GENERATOR}] update failed:`, updErr);
    return errorResponse(`Failed to update shot: ${updErr.message}`, 500, req);
  }

  // ── Emit audit event (best-effort — don't block on failure) ───────────────
  // drone_events.project_id became nullable in migration 235, so we can still
  // record the event even when project resolution misses (rare). Surface a
  // warn-level log instead of failing the user-visible action.
  if (projectId) {
    const { error: evErr } = await admin
      .from('drone_events')
      .insert({
        project_id: projectId,
        shoot_id: shot.shoot_id ?? null,
        shot_id: body.shot_id,
        event_type: 'shot_lifecycle_changed',
        actor_type: isService ? 'system' : 'user',
        actor_id: isService ? null : user.id,
        payload: {
          shot_id: body.shot_id,
          from_state: fromState,
          to_state: target,
          shot_role: shot.shot_role || null,
          filename: shot.filename || null,
        },
      });
    if (evErr) {
      console.warn(`[${GENERATOR}] drone_events insert failed: ${evErr.message}`);
    }
  } else {
    console.warn(
      JSON.stringify({
        fn: GENERATOR,
        level: 'warn',
        msg: 'project_id_unresolved_audit_skipped',
        shot_id: body.shot_id,
        from_state: fromState,
        to_state: target,
        actor_id: isService ? null : user.id,
      }),
    );
  }

  return jsonResponse({ success: true, shot: updated }, 200, req);
});

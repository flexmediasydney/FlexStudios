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

  // ── Update lifecycle_state (optimistic lock on fromState) ────────────────
  // QC2-1 #12: previously the UPDATE had no fromState predicate, so two
  // parallel POSTs racing the same shot from raw_proposed → raw_accepted /
  // raw_proposed → rejected both succeeded — last-write-wins on the column,
  // BOTH inserted a drone_events row (one with the wrong from_state), and
  // the audit log emitted contradictory transitions for a single human
  // intent. Chain the predicate `lifecycle_state = $fromState` and detect
  // a 0-row update as a 409 conflict — the second writer reports
  // current_state so the caller can refetch + reconcile.
  //
  // Use .select() WITHOUT .single() so 0-row updates don't throw PGRST116;
  // we inspect updated.length explicitly. .maybeSingle() would also work
  // but .select() is more readable for "expecting 0 or 1 rows by predicate".
  const { data: updatedRows, error: updErr } = await admin
    .from('drone_shots')
    .update({ lifecycle_state: target })
    .eq('id', body.shot_id)
    .eq('lifecycle_state', fromState)
    .select('*');

  if (updErr) {
    console.error(`[${GENERATOR}] update failed:`, updErr);
    return errorResponse(`Failed to update shot: ${updErr.message}`, 500, req);
  }

  // 0 rows → another writer flipped the lifecycle between our read above
  // and the conditional UPDATE. Re-read the current state and 409 with it
  // so the client can refetch + reconcile (or treat as no-op if the new
  // current_state already matches their target).
  if (!updatedRows || updatedRows.length === 0) {
    const { data: current } = await admin
      .from('drone_shots')
      .select('id, lifecycle_state')
      .eq('id', body.shot_id)
      .maybeSingle();
    const currentState = (current?.lifecycle_state as string | null) || null;
    return jsonResponse(
      {
        success: false,
        error: 'lifecycle_state_conflict',
        expected_from_state: fromState,
        current_state: currentState,
      },
      409,
      req,
    );
  }

  const updated = updatedRows[0];

  // ── Emit audit event (best-effort — don't block on failure) ───────────────
  // drone_events.project_id became nullable in migration 235, so we can still
  // record the event even when project resolution misses (rare). Surface a
  // warn-level log instead of failing the user-visible action.
  // QC2-1 #12: this insert is now downstream of a confirmed-success UPDATE
  // (predicated on fromState), so we never emit conflicting audit events
  // for a racing pair — only the winner reaches this block.
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

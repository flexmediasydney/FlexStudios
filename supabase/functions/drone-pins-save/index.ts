/**
 * drone-pins-save — Drone Phase 6 Stream L
 *
 * Persist edits made in the Pin Editor to drone_custom_pins, then enqueue a
 * render job and emit a drone_events row.
 *
 * Request:
 *   POST {
 *     shoot_id: string,
 *     edits: Edit[]
 *   }
 *
 *   type Edit =
 *     | { action: 'create',
 *         pin_type: 'poi_manual' | 'text' | 'line' | 'measurement',
 *         world_lat?, world_lng?,
 *         pixel_anchored_shot_id?, pixel_x?, pixel_y?,
 *         content?, style_overrides?,
 *         scope: 'this_shot' | 'all_shots' }
 *     | { action: 'update', pin_id: string, ...same fields, scope }
 *     | { action: 'delete', pin_id: string }
 *
 * Response: { success, applied: { creates, updates, deletes }, job_id, event_id }
 *
 * Auth:
 *   master_admin / admin → always
 *   manager / employee   → must have RLS visibility of the shoot's project
 *   contractor           → only if project is in their my_project_ids()
 *
 * The function uses the user's JWT for the visibility check, then writes via
 * the admin client for atomicity (drone_custom_pins XOR constraint guarantees
 * data integrity).
 *
 * For 'all_shots' scope: a world-anchored pin's world coord is canonical, so
 * "apply to all shots" is automatic — every render uses the same world coord.
 * For pixel-anchored pins on 'all_shots' we currently scope to the supplied
 * pixel_anchored_shot_id (a pixel pin can't apply to all shots — its meaning
 * is per-shot).
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getUserClient,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'drone-pins-save';

interface BaseEdit {
  action: 'create' | 'update' | 'delete';
  pin_id?: string;
  pin_type?: 'poi_manual' | 'text' | 'line' | 'measurement';
  world_lat?: number | null;
  world_lng?: number | null;
  pixel_anchored_shot_id?: string | null;
  pixel_x?: number | null;
  pixel_y?: number | null;
  content?: Record<string, unknown> | null;
  style_overrides?: Record<string, unknown> | null;
  scope?: 'this_shot' | 'all_shots';
}

interface RequestBody {
  shoot_id?: string;
  edits?: BaseEdit[];
  _health_check?: boolean;
}

interface ShootRow {
  id: string;
  project_id: string;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * A pin is either world-anchored OR pixel-anchored — match the DB CHECK
 * constraint. Caller payloads carry both; we normalise here.
 */
function normalisePinPayload(e: BaseEdit, shootId: string) {
  const isWorld =
    isFiniteNumber(e.world_lat) &&
    isFiniteNumber(e.world_lng) &&
    !e.pixel_anchored_shot_id;

  if (isWorld) {
    return {
      shoot_id: shootId,
      pin_type: e.pin_type || 'poi_manual',
      world_lat: e.world_lat as number,
      world_lng: e.world_lng as number,
      pixel_anchored_shot_id: null,
      pixel_x: null,
      pixel_y: null,
      content: e.content ?? null,
      style_overrides: e.style_overrides ?? null,
    };
  }

  if (
    !e.pixel_anchored_shot_id ||
    !isFiniteNumber(e.pixel_x) ||
    !isFiniteNumber(e.pixel_y)
  ) {
    return null;
  }

  return {
    shoot_id: shootId,
    pin_type: e.pin_type || 'text',
    world_lat: null,
    world_lng: null,
    pixel_anchored_shot_id: e.pixel_anchored_shot_id,
    pixel_x: Math.round(e.pixel_x as number),
    pixel_y: Math.round(e.pixel_y as number),
    content: e.content ?? null,
    style_overrides: e.style_overrides ?? null,
  };
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);

  // Health check post-auth — see drone-render-approve for rationale. (#1 audit fix)
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const shootId = body.shoot_id?.trim();
  const edits = Array.isArray(body.edits) ? body.edits : [];
  if (!shootId) return errorResponse('shoot_id required', 400, req);
  if (edits.length === 0) {
    return jsonResponse(
      {
        success: true,
        applied: { creates: 0, updates: 0, deletes: 0 },
        job_id: null,
        event_id: null,
      },
      200,
      req,
    );
  }

  // Authz: master_admin/admin always; others must see the shoot via RLS.
  if (!['master_admin', 'admin'].includes(user.role || '')) {
    const userClient = getUserClient(req);
    const { data: rlsShoot, error: rlsErr } = await userClient
      .from('drone_shoots')
      .select('id, project_id')
      .eq('id', shootId)
      .maybeSingle();
    if (rlsErr) {
      console.error(`[${GENERATOR}] RLS check failed:`, rlsErr);
      return errorResponse('Shoot access check failed', 500, req);
    }
    if (!rlsShoot) return errorResponse('Forbidden — shoot not visible', 403, req);
  }

  const admin = getAdminClient();
  const { data: shootRow, error: shootErr } = await admin
    .from('drone_shoots')
    .select('id, project_id')
    .eq('id', shootId)
    .maybeSingle();
  if (shootErr || !shootRow) {
    return errorResponse(
      `Shoot not found: ${shootErr?.message || 'no row'}`,
      404,
      req,
    );
  }
  const shoot = shootRow as ShootRow;

  // Validate every pixel_anchored_shot_id in the edit set actually belongs
  // to this shoot. Without this an attacker could pass a shot UUID from a
  // different project and the FK would happily accept it. (#46 audit fix)
  const pixelShotIds = Array.from(
    new Set(
      edits
        .filter((e) => e && typeof e === 'object' && (e as BaseEdit).pixel_anchored_shot_id)
        .map((e) => (e as BaseEdit).pixel_anchored_shot_id as string),
    ),
  );
  if (pixelShotIds.length > 0) {
    const { data: validShots, error: shotErr } = await admin
      .from('drone_shots')
      .select('id')
      .eq('shoot_id', shootId)
      .in('id', pixelShotIds);
    if (shotErr) {
      console.error(`[${GENERATOR}] shot membership check failed:`, shotErr);
      return errorResponse('Shot membership check failed', 500, req);
    }
    const validSet = new Set((validShots || []).map((s) => s.id));
    const stranger = pixelShotIds.find((id) => !validSet.has(id));
    if (stranger) {
      return errorResponse(
        `pixel_anchored_shot_id ${stranger} does not belong to shoot ${shootId}`,
        400,
        req,
      );
    }
  }

  let creates = 0;
  let updates = 0;
  let deletes = 0;
  const errors: string[] = [];

  // Pre-validate: a pixel-anchored pin can never legitimately scope to
  // 'all_shots' — its meaning is per-shot pixel coords. Previously this
  // combination was silently swallowed by normalisePinPayload returning null.
  // Reject up-front so the UI surfaces the operator's mistake. (#75 audit fix)
  for (const e of edits) {
    if (e?.action === 'delete') continue;
    const isPixel = !!e?.pixel_anchored_shot_id;
    if (isPixel && e?.scope === 'all_shots') {
      return errorResponse(
        "scope='all_shots' is not valid for pixel-anchored pins (use a world pin to apply to all shots)",
        400,
        req,
      );
    }
  }

  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    if (e.action === 'delete') {
      if (!e.pin_id) {
        errors.push('delete edit missing pin_id');
        continue;
      }
      const { error } = await admin
        .from('drone_custom_pins')
        .delete()
        .eq('id', e.pin_id)
        .eq('shoot_id', shootId);
      if (error) {
        console.error(`[${GENERATOR}] delete failed:`, error);
        errors.push(`delete ${e.pin_id}: ${error.message}`);
      } else {
        deletes += 1;
      }
      continue;
    }

    const payload = normalisePinPayload(e, shootId);
    if (!payload) {
      errors.push('edit missing required world or pixel coords');
      continue;
    }

    if (e.action === 'create') {
      const { error } = await admin.from('drone_custom_pins').insert({
        ...payload,
        created_by: user.id === '__service_role__' ? null : user.id,
        // (#45 audit) created_by carries the contractor's UUID; the audit
        // event payload also flags is_contractor for fast UI filtering.
      });
      if (error) {
        console.error(`[${GENERATOR}] insert failed:`, error);
        errors.push(`create: ${error.message}`);
      } else {
        creates += 1;
      }
    } else if (e.action === 'update' && e.pin_id) {
      // Strip shoot_id from update — it's immutable in the schema and we
      // already gated on it above. Do allow type/anchor swaps to satisfy
      // the XOR constraint.
      const { shoot_id: _drop, ...updPayload } = payload;
      void _drop;
      const { error } = await admin
        .from('drone_custom_pins')
        .update(updPayload)
        .eq('id', e.pin_id)
        .eq('shoot_id', shootId);
      if (error) {
        console.error(`[${GENERATOR}] update failed:`, error);
        errors.push(`update ${e.pin_id}: ${error.message}`);
      } else {
        updates += 1;
      }
    }
  }

  // Emit a domain audit event.
  // Audit #45: contractors writing pins still get actor_type='user' (their
  // identity matters for accountability), but we annotate the payload with
  // is_contractor=true so the activity feed can surface the role distinction
  // without having to re-resolve user.role at read time.
  const isService = user.id === '__service_role__';
  const isContractor = !isService && (user.role || '') === 'contractor';
  let eventId: number | null = null;
  {
    const { data: evRow, error: evErr } = await admin
      .from('drone_events')
      .insert({
        project_id: shoot.project_id,
        shoot_id: shoot.id,
        event_type: 'pin_edit_saved',
        actor_type: isService ? 'system' : 'user',
        actor_id: isService ? null : user.id,
        payload: {
          changes_count: creates + updates + deletes,
          creates,
          updates,
          deletes,
          ...(isContractor ? { is_contractor: true } : {}),
          edits_summary: edits.map((e) => ({
            action: e.action,
            pin_id: e.pin_id,
            scope: e.scope,
            anchored: isFiniteNumber(e.world_lat) ? 'world' : 'pixel',
          })),
        },
      })
      .select('id')
      .maybeSingle();
    if (evErr) {
      console.warn(`[${GENERATOR}] event insert failed (non-fatal):`, evErr);
    } else if (evRow) {
      eventId = (evRow as { id: number }).id;
    }
  }

  // Enqueue a re-render job. Stream I picks this up.
  let jobId: string | null = null;
  {
    const { data: jobRow, error: jobErr } = await admin
      .from('drone_jobs')
      .insert({
        project_id: shoot.project_id,
        shoot_id: shoot.id,
        kind: 'render',
        status: 'pending',
        payload: {
          reason: 'pin_edit_saved',
          changes_count: creates + updates + deletes,
        },
      })
      .select('id')
      .maybeSingle();
    if (jobErr) {
      console.warn(`[${GENERATOR}] job enqueue failed (non-fatal):`, jobErr);
    } else if (jobRow) {
      jobId = (jobRow as { id: string }).id;
    }
  }

  // Audit #48: standardise partial-failure response shape so the frontend
  // doesn't have to reconcile (success: false, errors: [...]) against an
  // HTTP-207 result. We always return success: true when at least one edit
  // was applied; partial failures are surfaced via partial_failures[]. Pure
  // total-failure (no edits applied AND errors present) returns success:
  // false to keep the failure path obvious.
  const totalApplied = creates + updates + deletes;
  const hasErrors = errors.length > 0;
  const isPartial = hasErrors && totalApplied > 0;
  const isTotalFail = hasErrors && totalApplied === 0;
  const status = !hasErrors ? 200 : isPartial ? 207 : 400;
  return jsonResponse(
    {
      success: !isTotalFail,
      applied: { creates, updates, deletes },
      partial_failures: isPartial ? errors : undefined,
      errors: isTotalFail ? errors : undefined,
      job_id: jobId,
      event_id: eventId,
    },
    status,
    req,
  );
});

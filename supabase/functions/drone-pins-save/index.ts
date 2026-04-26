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
 *         content?, style_overrides? }
 *     | { action: 'update', pin_id: string, ...same fields }
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
 * Note: an earlier draft accepted a per-edit `scope: 'this_shot' | 'all_shots'`
 * field for fan-out semantics. The server never acted on it (a world-anchored
 * pin already applies to every render via its canonical world coord, and a
 * pixel pin is intrinsically per-shot), so the field was removed. Re-introduce
 * if real fan-out semantics (e.g. cloning a pixel pin across N shots) are
 * implemented in the future.
 *
 * Project-wide cascade (W3): world-anchored pins (lat/lng) are inherently
 * project-scoped — they project to pixels in EVERY shot of EVERY shoot in the
 * project (orbital, building_hero, nadir_hero, etc.) at render time. So when
 * an operator edits a world-anchored pin on shoot A, ALL sibling shoots in
 * the same project must also re-render to pick up the change. Today we fan
 * out one render job per shoot in the project. The partial unique index from
 * migration 257 (idx_drone_jobs_unique_pending_render on (shoot_id, kind))
 * dedupes — repeated saves coalesce to one queued render per shoot. We treat
 * 23505 as success. Pixel-anchored pins are intrinsically shoot-scoped so
 * the legacy single-shoot enqueue path still applies.
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
  // W3-PINS (mig 268): added 'suppress' (set lifecycle='suppressed') and
  // 'reset_to_ai' (restore world coords + content from latest_ai_snapshot,
  // clear updated_by). Both are first-class operations the editor exposes
  // for AI pins; manual pins still use create/update/delete.
  action: 'create' | 'update' | 'delete' | 'suppress' | 'reset_to_ai';
  pin_id?: string;
  pin_type?: 'poi_manual' | 'text' | 'line' | 'measurement';
  world_lat?: number | null;
  world_lng?: number | null;
  pixel_anchored_shot_id?: string | null;
  pixel_x?: number | null;
  pixel_y?: number | null;
  content?: Record<string, unknown> | null;
  style_overrides?: Record<string, unknown> | null;
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

  // ── IDOR pre-validation (Wave 5 P1 backend fix — QC2-1 #5) ───────────────
  // The per-edit handlers below mutate by pin_id directly via the admin
  // client. Without validating that each referenced pin belongs to the
  // SAME project as the validated shoot, a user with shoot access on
  // project A could pass a pin_id from project B and silently mutate it.
  //
  // Build a single set of every pin_id referenced by update/delete/
  // suppress/reset_to_ai edits (create has no pin_id), fetch the rows in
  // ONE query, and assert each pin_id resolves to a row whose
  //   - shoot.project_id == shoot.project_id  (shoot-scoped pin), OR
  //   - project_id == shoot.project_id        (project-scoped AI pin)
  //
  // Reject the entire request with 403 if ANY foreign pin_id is present —
  // partial application would leave the attacker with a half-mutated set.
  const referencedPinIds = Array.from(
    new Set(
      edits
        .filter(
          (e) =>
            e &&
            typeof e === 'object' &&
            ['update', 'delete', 'suppress', 'reset_to_ai'].includes(
              (e as BaseEdit).action,
            ) &&
            typeof (e as BaseEdit).pin_id === 'string' &&
            ((e as BaseEdit).pin_id as string).length > 0,
        )
        .map((e) => (e as BaseEdit).pin_id as string),
    ),
  );
  if (referencedPinIds.length > 0) {
    const { data: pinRows, error: pinErr } = await admin
      .from('drone_custom_pins')
      .select('id, project_id, shoot_id')
      .in('id', referencedPinIds);
    if (pinErr) {
      console.error(`[${GENERATOR}] pin membership check failed:`, pinErr);
      return errorResponse('Pin membership check failed', 500, req);
    }
    const foundIds = new Set<string>();
    const pinShootIds = new Set<string>();
    for (const r of (pinRows || []) as {
      id: string;
      project_id: string | null;
      shoot_id: string | null;
    }[]) {
      foundIds.add(r.id);
      // A pin belongs to this project if either:
      //   - its project_id column matches directly, OR
      //   - its shoot_id resolves to a shoot in this project (verified
      //     against drone_shoots below in one bulk query).
      if (r.project_id && r.project_id === shoot.project_id) continue;
      if (r.shoot_id) pinShootIds.add(r.shoot_id);
    }
    // Resolve any indirect (shoot-scoped) pins via their shoot's project.
    const validShootIds = new Set<string>();
    if (pinShootIds.size > 0) {
      const { data: shootProjects, error: shootProjErr } = await admin
        .from('drone_shoots')
        .select('id, project_id')
        .in('id', Array.from(pinShootIds))
        .eq('project_id', shoot.project_id);
      if (shootProjErr) {
        console.error(
          `[${GENERATOR}] pin shoot-membership lookup failed:`,
          shootProjErr,
        );
        return errorResponse('Pin shoot membership check failed', 500, req);
      }
      for (const s of (shootProjects || []) as { id: string }[]) {
        validShootIds.add(s.id);
      }
    }
    // Build the per-pin verdict.
    const stranger = (pinRows || []).find((r) => {
      const row = r as {
        id: string;
        project_id: string | null;
        shoot_id: string | null;
      };
      if (row.project_id && row.project_id === shoot.project_id) return false;
      if (row.shoot_id && validShootIds.has(row.shoot_id)) return false;
      return true;
    }) as { id: string } | undefined;
    const missing = referencedPinIds.find((id) => !foundIds.has(id));
    if (stranger) {
      console.warn(
        `[${GENERATOR}] IDOR attempt: pin_id ${stranger.id} does not belong to shoot ${shootId}'s project ${shoot.project_id} (user ${user.id})`,
      );
      return errorResponse(
        `Forbidden — pin_id ${stranger.id} does not belong to this project`,
        403,
        req,
      );
    }
    if (missing) {
      // A pin_id with no row at all — also reject. Could be a stale client
      // cache, could be an attacker probing for IDs; either way the safe
      // response is to refuse the batch rather than no-op-skip the edit.
      return errorResponse(
        `Forbidden — pin_id ${missing} not found`,
        403,
        req,
      );
    }
  }

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
  let suppresses = 0;
  let resets = 0;
  const errors: string[] = [];
  const actorId = user.id === '__service_role__' ? null : user.id;
  // Collect IDs of newly inserted rows so the frontend can populate the
  // local item.dbId on its in-memory _new entries — without this, a second
  // save in the same session would re-issue create actions for pins that
  // already exist server-side, causing duplicates.
  const created_ids: string[] = [];
  // Track whether the batch touched any world-anchored or pixel-anchored
  // pins. World-anchored = project-scoped (cascade across all shoots);
  // pixel-anchored = shoot-scoped (legacy per-shoot enqueue only).
  // Deletes are conservatively treated as world-anchored: we can't cheaply
  // know the anchor of a deleted pin row without a pre-fetch and a deletion
  // is a strong signal the operator wants the change reflected everywhere.
  let touchedWorld = false;
  let touchedPixel = false;

  // (Code archaeology: a prior version of this function rejected the
  // combination pixel-anchored + scope='all_shots' here. The `scope` field
  // was never acted on server-side, so both the field and the guard were
  // removed. Pixel pins remain intrinsically per-shot regardless.)

  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    if (e.action === 'delete') {
      if (!e.pin_id) {
        errors.push('delete edit missing pin_id');
        continue;
      }
      // Classify the anchor of the pin BEFORE deleting so we know whether
      // to fan out the cascade. We can't read the row after the delete.
      let deletedAnchor: 'world' | 'pixel' | 'unknown' = 'unknown';
      // W3-PINS: drop the shoot_id filter so project-scoped AI pins
      // (shoot_id IS NULL) can also be deleted from a shoot session.
      const { data: anchorRow } = await admin
        .from('drone_custom_pins')
        .select('world_lat, pixel_anchored_shot_id, source')
        .eq('id', e.pin_id)
        .maybeSingle();
      if (anchorRow) {
        const r = anchorRow as { world_lat: number | null; pixel_anchored_shot_id: string | null };
        if (r.world_lat !== null && r.world_lat !== undefined) deletedAnchor = 'world';
        else if (r.pixel_anchored_shot_id) deletedAnchor = 'pixel';
      }
      // W3-PINS: AI pins soft-delete (lifecycle='deleted') so a future
      // drone-pois refresh can recreate the place_id row cleanly. Manual
      // pins still hard-delete.
      const aiSoftDelete = (anchorRow as { source?: string } | null)?.source === 'ai';
      const { error } = aiSoftDelete
        ? await admin
            .from('drone_custom_pins')
            .update({ lifecycle: 'deleted', updated_by: actorId })
            .eq('id', e.pin_id)
        : await admin
            .from('drone_custom_pins')
            .delete()
            .eq('id', e.pin_id);
      if (error) {
        console.error(`[${GENERATOR}] delete failed:`, error);
        errors.push(`delete ${e.pin_id}: ${error.message}`);
      } else {
        deletes += 1;
        // Conservatively treat unknown anchor (row already gone, pre-fetch
        // missed) as world: a stale-row save shouldn't silently skip the
        // cascade if the next save has nothing pixel-only to mark.
        if (deletedAnchor === 'world' || deletedAnchor === 'unknown') {
          touchedWorld = true;
        } else {
          touchedPixel = true;
        }
      }
      continue;
    }

    if (e.action === 'suppress') {
      if (!e.pin_id) {
        errors.push('suppress edit missing pin_id');
        continue;
      }
      const { error } = await admin
        .from('drone_custom_pins')
        .update({ lifecycle: 'suppressed', updated_by: actorId })
        .eq('id', e.pin_id);
      if (error) {
        errors.push(`suppress ${e.pin_id}: ${error.message}`);
      } else {
        suppresses += 1;
        // Suppressing a project-scoped pin should cascade across the
        // project; conservatively mark the world flag so the cascade
        // block below picks it up.
        touchedWorld = true;
      }
      continue;
    }

    if (e.action === 'reset_to_ai') {
      if (!e.pin_id) {
        errors.push('reset_to_ai edit missing pin_id');
        continue;
      }
      const { data: pin } = await admin
        .from('drone_custom_pins')
        .select('id, source, latest_ai_snapshot')
        .eq('id', e.pin_id)
        .maybeSingle();
      if (!pin || (pin as { source: string }).source !== 'ai') {
        errors.push(`reset_to_ai ${e.pin_id}: only valid on AI-source pins`);
        continue;
      }
      const snap = (pin as { latest_ai_snapshot: Record<string, unknown> | null }).latest_ai_snapshot;
      if (!snap) {
        errors.push(`reset_to_ai ${e.pin_id}: no AI snapshot to restore`);
        continue;
      }
      const restoredContent = {
        label: snap.name,
        type: snap.type,
        distance_m: snap.distance_m,
        rating: snap.rating,
        user_ratings_total: snap.user_ratings_total,
        place_id: snap.place_id,
      };
      const { error } = await admin
        .from('drone_custom_pins')
        .update({
          world_lat: snap.lat as number,
          world_lng: snap.lng as number,
          content: restoredContent,
          style_overrides: null,
          lifecycle: 'active',
          updated_by: null,
        })
        .eq('id', e.pin_id);
      if (error) {
        errors.push(`reset_to_ai ${e.pin_id}: ${error.message}`);
      } else {
        resets += 1;
        touchedWorld = true;
      }
      continue;
    }

    const payload = normalisePinPayload(e, shootId);
    if (!payload) {
      errors.push('edit missing required world or pixel coords');
      continue;
    }

    // Audit #21: clamp world coords server-side. drone_custom_pins.world_lat
    // is DECIMAL(10,8) and world_lng is DECIMAL(11,8) per migration 225;
    // out-of-range values from bad pose math would silently truncate or
    // 22003-error mid-batch. Reject per-edit so other edits in the same
    // request still apply.
    if (payload.world_lat !== null && payload.world_lng !== null) {
      const lat = payload.world_lat;
      const lng = payload.world_lng;
      if (lat < -90 || lat > 90) {
        const msg = `world_lat must be in [-90, 90], got ${lat}`;
        console.warn(`[${GENERATOR}] ${msg}`);
        errors.push(msg);
        continue;
      }
      if (lng < -180 || lng > 180) {
        const msg = `world_lng must be in [-180, 180], got ${lng}`;
        console.warn(`[${GENERATOR}] ${msg}`);
        errors.push(msg);
        continue;
      }
    }

    const isWorldPayload = payload.world_lat !== null;

    if (e.action === 'create') {
      const { data: insRow, error } = await admin
        .from('drone_custom_pins')
        .insert({
          ...payload,
          created_by: user.id === '__service_role__' ? null : user.id,
          // (#45 audit) created_by carries the contractor's UUID; the audit
          // event payload also flags is_contractor for fast UI filtering.
        })
        .select('id')
        .maybeSingle();
      if (error) {
        console.error(`[${GENERATOR}] insert failed:`, error);
        errors.push(`create: ${error.message}`);
      } else {
        creates += 1;
        if (isWorldPayload) touchedWorld = true;
        else touchedPixel = true;
        if (insRow && (insRow as { id?: string }).id) {
          created_ids.push((insRow as { id: string }).id);
        }
      }
    } else if (e.action === 'update' && e.pin_id) {
      // Strip shoot_id from update — it's immutable in the schema and we
      // already gated on it above. Do allow type/anchor swaps to satisfy
      // the XOR constraint.
      const { shoot_id: _drop, ...updPayload } = payload;
      void _drop;
      // Update may swap anchor (pixel→world etc.). Mark BOTH the prior
      // anchor (read pre-update) and the new anchor (from payload) so a
      // pixel→world flip cascades AND the original shoot rerenders.
      let priorAnchor: 'world' | 'pixel' | 'unknown' = 'unknown';
      // W3-PINS: drop the shoot_id filter — project-scoped AI pins have
      // shoot_id IS NULL and the editor needs to be able to update them
      // from any shoot's session. Pin-level RLS still gates access.
      const { data: priorRow } = await admin
        .from('drone_custom_pins')
        .select('world_lat, pixel_anchored_shot_id')
        .eq('id', e.pin_id)
        .maybeSingle();
      if (priorRow) {
        const r = priorRow as { world_lat: number | null; pixel_anchored_shot_id: string | null };
        if (r.world_lat !== null && r.world_lat !== undefined) priorAnchor = 'world';
        else if (r.pixel_anchored_shot_id) priorAnchor = 'pixel';
      }
      // W3-PINS: stamp updated_by so drone-pois smart-merge knows this row
      // was operator-edited and won't overwrite world coords on next refresh.
      const { error } = await admin
        .from('drone_custom_pins')
        .update({ ...updPayload, updated_by: actorId })
        .eq('id', e.pin_id);
      if (error) {
        console.error(`[${GENERATOR}] update failed:`, error);
        errors.push(`update ${e.pin_id}: ${error.message}`);
      } else {
        updates += 1;
        if (isWorldPayload || priorAnchor === 'world' || priorAnchor === 'unknown') {
          touchedWorld = true;
        }
        if (!isWorldPayload || priorAnchor === 'pixel') {
          touchedPixel = true;
        }
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

  // Enqueue re-render job(s). Stream I picks them up.
  //
  // Audit #4: migration 240 added a partial unique index
  // idx_drone_jobs_unique_pending_render on (shoot_id, kind) WHERE status
  // IN ('pending','running') AND kind IN ('render','render_preview',
  // 'raw_preview_render') (broadened by migration 257). If the operator
  // hammers Save, the second insert raises 23505; we treat that as success
  // (debounced) — the already-queued render will pick up the latest pin
  // state when it runs.
  //
  // W3 cascade: world-anchored pins are project-scoped (every shot in
  // every shoot projects the same lat/lng to its own pixel space). When a
  // world-anchored pin is touched we fan out one render job per sibling
  // shoot in the project; pixel-only edit batches stay shoot-local.
  //
  // TODO Wave 4 (audit #1): drone-pins-save returns 5xx from the admin
  // client on transient Postgres errors above; the frontend's
  // directEntityFallback path could auto-retry idempotent inserts on
  // those. Tracked in PinEditor.
  let jobId: string | null = null;
  let cascadedShootCount = 0;
  let debouncedShootCount = 0;
  const cascadedShootIds: string[] = [];

  // Resolve the list of shoots to enqueue against. World-anchored ⇒ all
  // shoots in the project that have at least one rendered shot (cascade).
  // Pixel-only or no-op ⇒ just the active shoot (legacy behaviour).
  //
  // CASCADE FILTER (Final E2E walk fix): only fan out to sibling shoots that
  // already have at least one drone_renders row in column_state IN ('proposed',
  // 'adjustments','final'). Pre-edit shoots (no renders yet) are skipped —
  // they'll pick up the world-anchored pin change automatically on their
  // first render run via the unified drone_custom_pins query in drone-render.
  // Without this filter, the cascade fans out renders for shoots whose shots
  // have no edited_dropbox_path, which produces "0/N rendered" responses that
  // can dead-letter (see W1-γ deferred path in drone-job-dispatcher). The
  // active shoot is always included even if it has no renders yet — the
  // operator just edited pins on it, so they expect a render attempt.
  let targetShoots: { id: string; project_id: string }[] = [
    { id: shoot.id, project_id: shoot.project_id },
  ];
  let cascadeReason: 'pin_edit_saved' | 'pin_edit_cascade' = 'pin_edit_saved';
  if (touchedWorld) {
    cascadeReason = 'pin_edit_cascade';
    // Step 1: list all shoots in the project.
    const { data: siblingShoots, error: siblingErr } = await admin
      .from('drone_shoots')
      .select('id, project_id')
      .eq('project_id', shoot.project_id);
    if (siblingErr || !siblingShoots) {
      console.warn(
        `[${GENERATOR}] sibling shoot lookup failed; falling back to single-shoot enqueue:`,
        siblingErr,
      );
    } else {
      const allSiblings = siblingShoots as { id: string; project_id: string }[];
      const allShootIds = allSiblings.map((s) => s.id);
      // Step 2: resolve which sibling shoots have at least one render row.
      // Use a two-hop query (shots → renders) since drone_renders is keyed by
      // shot_id, not shoot_id. Filtering at the DB layer keeps the result set
      // bounded even on large projects.
      const { data: shotsInProject, error: shotsErr } = await admin
        .from('drone_shots')
        .select('id, shoot_id')
        .in('shoot_id', allShootIds);
      let renderedShootIds = new Set<string>();
      if (shotsErr || !shotsInProject) {
        console.warn(
          `[${GENERATOR}] shot lookup for cascade filter failed; falling back to all-shoots enqueue:`,
          shotsErr,
        );
        renderedShootIds = new Set(allShootIds);
      } else {
        const shotIdToShootId = new Map<string, string>();
        for (const s of shotsInProject as { id: string; shoot_id: string }[]) {
          shotIdToShootId.set(s.id, s.shoot_id);
        }
        const allShotIds = Array.from(shotIdToShootId.keys());
        if (allShotIds.length > 0) {
          const { data: renderedRows, error: renderedErr } = await admin
            .from('drone_renders')
            .select('shot_id')
            .in('column_state', ['proposed', 'adjustments', 'final'])
            .in('shot_id', allShotIds);
          if (renderedErr) {
            console.warn(
              `[${GENERATOR}] render lookup for cascade filter failed; falling back to all-shoots enqueue:`,
              renderedErr,
            );
            renderedShootIds = new Set(allShootIds);
          } else {
            for (const r of (renderedRows || []) as { shot_id: string }[]) {
              const sId = shotIdToShootId.get(r.shot_id);
              if (sId) renderedShootIds.add(sId);
            }
          }
        }
      }
      // Always include the active shoot (operator just edited it on this
      // shoot, so the user expects an attempt — even if no renders exist yet
      // the existing skipped_no_edit + dispatcher deferred path handles it).
      renderedShootIds.add(shoot.id);
      targetShoots = allSiblings.filter((s) => renderedShootIds.has(s.id));
      console.info(
        `[${GENERATOR}] cascade resolved ${targetShoots.length}/${allSiblings.length} shoot(s) with existing renders (project ${shoot.project_id})`,
      );
    }
  }

  // Pixel-only changes mean the active shoot must be in the target list
  // even if no world pins were touched (it already is, above).
  void touchedPixel;

  // Wave 4: parallelise the cascade INSERTs in chunks (capped concurrency)
  // so a 50-shoot project no longer sits in a serial `for await` loop. We
  // mirror ThemeEditor.reRenderImpactedShoots: chunk + Promise.allSettled,
  // 23505 (unique_violation, dedupe debounce) treated as success.
  const CHUNK = 10;
  for (let i = 0; i < targetShoots.length; i += CHUNK) {
    const chunk = targetShoots.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((ts) =>
        admin
          .from('drone_jobs')
          .insert({
            project_id: ts.project_id,
            shoot_id: ts.id,
            kind: 'render',
            status: 'pending',
            payload: {
              reason: cascadeReason,
              changes_count: creates + updates + deletes,
              source_shoot_id: shoot.id,
              // Force the dispatched render to wipe the prior 'adjustments'
              // lane rows before re-rendering. Without this, the existing-
              // renders pre-filter in drone-render skips every shot that
              // already has an adjustments row → renderer is a no-op and the
              // operator's new pins never make it into a delivered file.
              // (Pin Editor write-only-sandbox repair.)
              wipe_existing: true,
            },
          })
          .select('id')
          .maybeSingle()
          .then((res) => ({ ts, res })),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.warn(`[${GENERATOR}] cascade insert promise rejected (non-fatal):`, r.reason);
        continue;
      }
      const { ts, res } = r.value;
      const isActive = ts.id === shoot.id;
      const { data: jobRow, error: jobErr } = res;
      if (jobErr) {
        const code = (jobErr as { code?: string }).code;
        if (code === '23505') {
          // 23505 = unique_violation — a pending/running render for this
          // shoot already exists. Treat as a successful debounce: log and
          // count the shoot as cascaded so the toast still tells the truth
          // (a render is queued for it, just not by us).
          console.info(
            `[${GENERATOR}] render job debounced (existing pending/running render for shoot ${ts.id})`,
          );
          cascadedShootCount += 1;
          debouncedShootCount += 1;
          cascadedShootIds.push(ts.id);
        } else {
          console.warn(
            `[${GENERATOR}] job enqueue failed for shoot ${ts.id} (non-fatal):`,
            jobErr,
          );
        }
        continue;
      }
      if (jobRow) {
        cascadedShootCount += 1;
        cascadedShootIds.push(ts.id);
        if (isActive) jobId = (jobRow as { id: string }).id;
      }
    }
  }
  if (targetShoots.length > 1) {
    const insertedCount = cascadedShootCount - debouncedShootCount;
    console.info(
      `[${GENERATOR}] cascade fan-out complete: ${insertedCount} inserted, ${debouncedShootCount} debounced (target=${targetShoots.length})`,
    );
  }

  // Audit #48: standardise partial-failure response shape so the frontend
  // doesn't have to reconcile (success: false, errors: [...]) against an
  // HTTP-207 result. We always return success: true when at least one edit
  // was applied; partial failures are surfaced via partial_failures[]. Pure
  // total-failure (no edits applied AND errors present) returns success:
  // false to keep the failure path obvious.
  const totalApplied = creates + updates + deletes + suppresses + resets;
  const hasErrors = errors.length > 0;
  const isPartial = hasErrors && totalApplied > 0;
  const isTotalFail = hasErrors && totalApplied === 0;
  const status = !hasErrors ? 200 : isPartial ? 207 : 400;
  return jsonResponse(
    {
      success: !isTotalFail,
      applied: { creates, updates, deletes, suppresses, resets },
      // created_ids is the list of NEW pin row IDs (in insertion order).
      // The frontend uses this to populate item.dbId on its in-memory _new
      // entries so a second save in the same session updates rather than
      // re-creating those pins. (Pin Editor write-only-sandbox repair.)
      created_ids,
      partial_failures: isPartial ? errors : undefined,
      errors: isTotalFail ? errors : undefined,
      job_id: jobId,
      event_id: eventId,
      // Cascade telemetry: how many shoots got a render queued (or already
      // had one). The frontend uses this to show "Re-rendering N shoots"
      // when N > 1 (world-anchored edit). When pixel-only, N == 1 and the
      // toast falls back to the single-shoot copy.
      cascade: {
        reason: cascadeReason,
        cascaded_shoot_count: cascadedShootCount,
        cascaded_shoot_ids: cascadedShootIds,
      },
    },
    status,
    req,
  );
});

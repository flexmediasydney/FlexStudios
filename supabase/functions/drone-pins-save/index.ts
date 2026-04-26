/**
 * drone-pins-save — Drone Phase 6 Stream L
 *
 * Persist edits made in the Pin Editor to drone_custom_pins, then enqueue a
 * single project-scoped cascade render job and emit a drone_events row.
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
 *     | { action: 'suppress' | 'un_suppress' | 'reset_to_ai', pin_id: string }
 *
 * Response: { success, applied, created_ids, partial_failures?, errors?,
 *             cascade_enqueued, cascade_kind, cascade_job_id, event_id }
 *
 * Auth:
 *   master_admin / admin → always
 *   manager / employee   → must have RLS visibility of the shoot's project
 *   contractor           → only if project is in their my_project_ids()
 *
 * Cascade contract (Wave 5 P2 S4):
 *   After all per-edit mutations succeed, enqueue ONE drone_jobs row with
 *   kind='render_edited', pipeline='edited',
 *   payload={cascade:true, project_id, reason:'pin_edit_cascade_edited'}.
 *   The dispatcher routes that to drone-render-edited which fans out
 *   per-shoot internally. Replaces the prior per-shoot fan-out loop —
 *   drone-render-edited owns project-scoped fan-out now.
 *
 *   The legacy per-shot 'pin_edit_saved' raw-side enqueue path is removed:
 *   drone-render hard-rejects reason='pin_edit_saved' (S2). Pin Editor
 *   saves never trigger raw renders going forward; they always cascade
 *   through the edited pipeline.
 *
 * The function uses the user's JWT for the visibility check, then writes via
 * the admin client for atomicity (drone_custom_pins XOR constraint guarantees
 * data integrity).
 *
 * E13 (Wave 5 P2 S4): updated_by populated on EVERY UPDATE/INSERT to
 * drone_custom_pins (creates use created_by; updates/suppress/un_suppress/
 * reset_to_ai/lifecycle-soft-delete use updated_by). Previously NULL on
 * every edit despite the column existing.
 *
 * F39 (Wave 5 P2 S4): when an UPDATE edit carries BOTH coord/content changes
 * AND _suppress=true, apply the coord/content UPDATE first (fully) then the
 * lifecycle='suppressed' UPDATE separately, so neither is silently dropped.
 *
 * Note: an earlier draft accepted a per-edit `scope: 'this_shot' | 'all_shots'`
 * field for fan-out semantics. The server never acted on it (a world-anchored
 * pin already applies to every render via its canonical world coord, and a
 * pixel pin is intrinsically per-shot), so the field was removed. Re-introduce
 * if real fan-out semantics (e.g. cloning a pixel pin across N shots) are
 * implemented in the future.
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
  // W5 P2 S4 (F35): added 'un_suppress' to flip lifecycle back to 'active'
  // so suppression is reversible from the editor (was a one-way trapdoor).
  action: 'create' | 'update' | 'delete' | 'suppress' | 'un_suppress' | 'reset_to_ai';
  pin_id?: string;
  pin_type?: 'poi_manual' | 'text' | 'line' | 'measurement';
  world_lat?: number | null;
  world_lng?: number | null;
  pixel_anchored_shot_id?: string | null;
  pixel_x?: number | null;
  pixel_y?: number | null;
  content?: Record<string, unknown> | null;
  style_overrides?: Record<string, unknown> | null;
  // F39: when set on an 'update' edit, after applying the coord/content
  // changes the function flips lifecycle='suppressed' as a SECOND update so
  // both the coord change and the suppression land. Previously the server
  // either suppressed without coord (suppress action) or updated without
  // suppression (update action) — never both in one edit object.
  _suppress_after_update?: boolean;
}

interface RequestBody {
  shoot_id?: string;
  edits?: BaseEdit[];
  pipeline?: 'edited' | 'raw';
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
    return jsonResponse({ _version: 'v2.0', _fn: GENERATOR }, 200, req);
  }

  const shootId = body.shoot_id?.trim();
  const edits = Array.isArray(body.edits) ? body.edits : [];
  // Pipeline (W5 P2 S4): default to 'edited' since Pin Editor is now
  // edited-only. We always cascade through render_edited regardless of
  // what the caller sends — the field exists for forward-compat / logging.
  const pipeline: 'edited' = 'edited';
  void body.pipeline;
  if (!shootId) return errorResponse('shoot_id required', 400, req);
  if (edits.length === 0) {
    return jsonResponse(
      {
        success: true,
        applied: { creates: 0, updates: 0, deletes: 0 },
        cascade_enqueued: false,
        cascade_kind: null,
        cascade_job_id: null,
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
  // suppress/un_suppress/reset_to_ai edits (create has no pin_id), fetch
  // the rows in ONE query, and assert each pin_id resolves to a row whose
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
            ['update', 'delete', 'suppress', 'un_suppress', 'reset_to_ai'].includes(
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
  let unsuppresses = 0;
  let resets = 0;
  const errors: string[] = [];
  const actorId = user.id === '__service_role__' ? null : user.id;
  // Collect IDs of newly inserted rows so the frontend can populate the
  // local item.dbId on its in-memory _new entries — without this, a second
  // save in the same session would re-issue create actions for pins that
  // already exist server-side, causing duplicates.
  const created_ids: string[] = [];
  // Collect every affected pin_id so the drone_events row can list them.
  const affectedPinIds: string[] = [];

  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    if (e.action === 'delete') {
      if (!e.pin_id) {
        errors.push('delete edit missing pin_id');
        continue;
      }
      // E13: stamp updated_by on AI soft-delete so the audit trail captures
      // the operator. Manual pin hard-deletes drop the row entirely so
      // updated_by is moot there.
      const { data: anchorRow } = await admin
        .from('drone_custom_pins')
        .select('source')
        .eq('id', e.pin_id)
        .maybeSingle();
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
        affectedPinIds.push(e.pin_id);
      }
      continue;
    }

    if (e.action === 'suppress') {
      if (!e.pin_id) {
        errors.push('suppress edit missing pin_id');
        continue;
      }
      // E13: updated_by stamped so smart-merge knows this row was
      // operator-touched and won't overwrite on next drone-pois refresh.
      const { error } = await admin
        .from('drone_custom_pins')
        .update({ lifecycle: 'suppressed', updated_by: actorId })
        .eq('id', e.pin_id);
      if (error) {
        errors.push(`suppress ${e.pin_id}: ${error.message}`);
      } else {
        suppresses += 1;
        affectedPinIds.push(e.pin_id);
      }
      continue;
    }

    // F35 / W5 P2 S4: un_suppress flips lifecycle back to 'active'. Pairs
    // with the Restore button extracted to PinLayersPanel.
    if (e.action === 'un_suppress') {
      if (!e.pin_id) {
        errors.push('un_suppress edit missing pin_id');
        continue;
      }
      // E13: updated_by stamped so subsequent drone-pois refreshes treat
      // the row as operator-edited and respect the un-suppression.
      const { error } = await admin
        .from('drone_custom_pins')
        .update({ lifecycle: 'active', updated_by: actorId })
        .eq('id', e.pin_id);
      if (error) {
        errors.push(`un_suppress ${e.pin_id}: ${error.message}`);
      } else {
        unsuppresses += 1;
        affectedPinIds.push(e.pin_id);
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
      // E13: reset_to_ai INTENTIONALLY clears updated_by — the AI snapshot
      // restoration semantically means "hand the pin back to the AI
      // ingestion pipeline", so the next drone-pois pass should be free
      // to refresh from Google Places without operator-edit gating.
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
        affectedPinIds.push(e.pin_id);
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

    if (e.action === 'create') {
      // E13: created_by carries the actor; updated_by populated to the
      // same value so an immediate read also shows the row as
      // operator-touched (smart-merge wants this for new manual pins).
      const { data: insRow, error } = await admin
        .from('drone_custom_pins')
        .insert({
          ...payload,
          created_by: actorId,
          updated_by: actorId,
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
        if (insRow && (insRow as { id?: string }).id) {
          const newId = (insRow as { id: string }).id;
          created_ids.push(newId);
          affectedPinIds.push(newId);
        }
      }
    } else if (e.action === 'update' && e.pin_id) {
      // Strip shoot_id from update — it's immutable in the schema and we
      // already gated on it above. Do allow type/anchor swaps to satisfy
      // the XOR constraint.
      const { shoot_id: _drop, ...updPayload } = payload;
      void _drop;
      // E13: stamp updated_by so drone-pois smart-merge knows this row
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
        affectedPinIds.push(e.pin_id);
        // F39 / W5 P2 S4: when the client bundles a coord/content UPDATE
        // AND a suppression into the same edit object, apply the
        // lifecycle flip as a second UPDATE so neither is silently
        // dropped. The prior shape (single update only) lost the
        // suppression; the suppress-only action lost the coord change.
        if (e._suppress_after_update === true) {
          const { error: supErr } = await admin
            .from('drone_custom_pins')
            .update({ lifecycle: 'suppressed', updated_by: actorId })
            .eq('id', e.pin_id);
          if (supErr) {
            errors.push(`suppress-after-update ${e.pin_id}: ${supErr.message}`);
          } else {
            suppresses += 1;
          }
        }
      }
    }
  }

  // ── Cascade enqueue (W5 P2 S4 contract) ──────────────────────────────────
  // After ALL per-edit mutations succeed, enqueue ONE drone_jobs row for
  // the EDITED pipeline cascade. drone-render-edited fans out per-shot
  // internally — this function no longer per-shoot fan-outs.
  //
  // Skip if zero edits applied (no point cascading a no-op batch). Skip
  // also if every edit failed (totalApplied stays 0 below).
  const totalApplied =
    creates + updates + deletes + suppresses + unsuppresses + resets;
  let cascadeEnqueued = false;
  let cascadeJobId: string | null = null;
  if (totalApplied > 0) {
    const { data: cascadeRow, error: cascadeErr } = await admin
      .from('drone_jobs')
      .insert({
        kind: 'render_edited',
        pipeline: 'edited',
        status: 'pending',
        scheduled_for: new Date().toISOString(),
        project_id: shoot.project_id,
        // shoot_id intentionally NULL for project-wide cascade — the
        // dispatcher / drone-render-edited resolves the per-shot fan-out.
        shoot_id: null,
        payload: {
          cascade: true,
          project_id: shoot.project_id,
          source_shoot_id: shoot.id,
          reason: 'pin_edit_cascade_edited',
          changes_count: totalApplied,
          affected_pin_count: affectedPinIds.length,
          // wipe_existing tells drone-render-edited to clear prior edited
          // 'adjustments' lane rows before re-rendering — without this
          // the existing-renders pre-filter skips every shot that already
          // has an adjustments row and the operator's new pins never
          // make it into a delivered file.
          wipe_existing: true,
        },
      })
      .select('id')
      .maybeSingle();
    if (cascadeErr) {
      const code = (cascadeErr as { code?: string }).code;
      if (code === '23505') {
        // Partial unique index already has a pending render_edited cascade
        // for this project — treat as debounced success.
        console.info(
          `[${GENERATOR}] cascade debounced (existing pending render_edited for project ${shoot.project_id})`,
        );
        cascadeEnqueued = true;
      } else {
        console.warn(
          `[${GENERATOR}] cascade enqueue failed (non-fatal):`,
          cascadeErr,
        );
      }
    } else if (cascadeRow) {
      cascadeEnqueued = true;
      cascadeJobId = (cascadeRow as { id: string }).id;
    }
  }

  // ── Domain audit event (E39) ─────────────────────────────────────────────
  // Emit ONE drone_events row per save batch (not per pin) listing every
  // affected pin_id and the cascade enqueue ref. event_type renamed from
  // legacy 'pin_edit_saved' to 'pin_edits_saved' to match the new
  // single-row contract.
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
        event_type: 'pin_edits_saved',
        actor_type: isService ? 'system' : 'user',
        actor_id: isService ? null : user.id,
        payload: {
          changes_count: totalApplied,
          creates,
          updates,
          deletes,
          suppresses,
          un_suppresses: unsuppresses,
          resets,
          pipeline,
          affected_pin_ids: affectedPinIds,
          cascade_enqueued: cascadeEnqueued,
          cascade_kind: cascadeEnqueued ? 'render_edited' : null,
          cascade_job_id: cascadeJobId,
          ...(isContractor ? { is_contractor: true } : {}),
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

  // Audit #48: standardise partial-failure response shape so the frontend
  // doesn't have to reconcile (success: false, errors: [...]) against an
  // HTTP-207 result. We always return success: true when at least one edit
  // was applied; partial failures are surfaced via partial_failures[]. Pure
  // total-failure (no edits applied AND errors present) returns success:
  // false to keep the failure path obvious.
  const hasErrors = errors.length > 0;
  const isPartial = hasErrors && totalApplied > 0;
  const isTotalFail = hasErrors && totalApplied === 0;
  const status = !hasErrors ? 200 : isPartial ? 207 : 400;
  return jsonResponse(
    {
      success: !isTotalFail,
      applied: { creates, updates, deletes, suppresses, un_suppresses: unsuppresses, resets },
      // created_ids is the list of NEW pin row IDs (in insertion order).
      // The frontend uses this to populate item.dbId on its in-memory _new
      // entries so a second save in the same session updates rather than
      // re-creating those pins. (Pin Editor write-only-sandbox repair.)
      created_ids,
      partial_failures: isPartial ? errors : undefined,
      errors: isTotalFail ? errors : undefined,
      // Cascade contract (W5 P2 S4): single render_edited cascade replaces
      // the prior per-shoot fan-out. Backwards-compat: include the legacy
      // job_id alias so older clients still see something non-null.
      cascade_enqueued: cascadeEnqueued,
      cascade_kind: cascadeEnqueued ? 'render_edited' : null,
      cascade_job_id: cascadeJobId,
      job_id: cascadeJobId, // legacy alias
      event_id: eventId,
      pipeline,
    },
    status,
    req,
  );
});

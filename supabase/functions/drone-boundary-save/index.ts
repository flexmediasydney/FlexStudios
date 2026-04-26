/**
 * drone-boundary-save — Wave 5 Phase 2 Stream S5
 *
 * Persist edits made in the new Boundary Editor to drone_property_boundary
 * (one row per project, mig 283), then enqueue a project-wide cascade render
 * job (kind='boundary_save_render_cascade', mig 287) and emit a drone_events
 * row.
 *
 * Mirrors drone-pins-save's shape: same auth/audit/event/cascade conventions.
 *
 * ── Endpoints ────────────────────────────────────────────────────────────
 *
 *   POST { project_id, action: 'reset_to_cadastral', version_for_concurrency }
 *     → resets polygon_latlng = cadastral_snapshot, source = 'cadastral',
 *       leaves overrides untouched. Same cascade behavior as a save.
 *
 *   POST { project_id,
 *          polygon_latlng: [[lat,lng], ...],
 *          side_measurements_enabled, side_measurements_overrides,
 *          sqm_total_enabled, sqm_total_position_offset_px, sqm_total_value_override,
 *          address_overlay_enabled, address_overlay_position_latlng, address_overlay_text_override,
 *          version_for_concurrency }
 *     → upsert with source='operator'. On the first operator edit (no row OR
 *       existing row with source='cadastral'), snapshot the cadastral polygon
 *       to cadastral_snapshot so Reset to NSW DCDB is undestructive.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────
 *   master_admin / admin → always
 *   manager / employee   → must have RLS visibility of the project
 *   contractor           → REJECTED with 403 (per RLS in mig 284)
 *
 * ── Concurrency ──────────────────────────────────────────────────────────
 *   Optimistic: client passes the version it loaded. If the row's current
 *   version != that, we 409 with the server's current version + payload so
 *   the client can merge / re-prompt. The trigger from mig 283 short-circuits
 *   no-op writes (row_to_json equality) so identical-payload saves do NOT
 *   bump version — the trigger keeps the IDOR-safe row but the response says
 *   the write succeeded.
 *
 * ── Cascade ──────────────────────────────────────────────────────────────
 *   ONE drone_jobs row of kind='boundary_save_render_cascade' is enqueued
 *   with payload = { project_id, source_version, source_event_id }. The
 *   dispatcher (S3) routes this to drone-render-edited which fans out per-
 *   shot. We do NOT enqueue per-shoot here — the dispatcher owns the fanout
 *   semantics so future schema changes don't ripple to the editor.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 *   Identical payload → row.version unchanged (trigger short-circuits). The
 *   handler still enqueues a cascade row in case the prior cascade failed
 *   silently. The dispatcher's per-shoot dedupe guards against duplicate
 *   render fan-out.
 *
 * ── Errors ───────────────────────────────────────────────────────────────
 *   400 — malformed polygon (must be an array of ≥3 finite [lat,lng] pairs)
 *   400 — out-of-range lat/lng
 *   401 — no/invalid Authorization
 *   403 — caller role is contractor OR project not visible
 *   404 — project not found
 *   409 — version_for_concurrency mismatch (echoes current row + version)
 *   500 — cascade enqueue failure (echoes the saved row so client can retry
 *         the cascade enqueue without re-saving)
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
import { fetchCadastral } from '../_shared/droneRenderCommon.ts';

const GENERATOR = 'drone-boundary-save';

interface ResetBody {
  project_id?: string;
  action?: 'reset_to_cadastral';
  version_for_concurrency?: number | null;
  _health_check?: boolean;
}

interface SaveBody {
  project_id?: string;
  action?: undefined;
  polygon_latlng?: unknown;
  side_measurements_enabled?: boolean;
  side_measurements_overrides?: Record<string, unknown> | null;
  sqm_total_enabled?: boolean;
  sqm_total_position_offset_px?: [number, number] | null;
  sqm_total_value_override?: number | null;
  address_overlay_enabled?: boolean;
  address_overlay_position_latlng?: [number, number] | null;
  address_overlay_text_override?: string | null;
  version_for_concurrency?: number | null;
  _health_check?: boolean;
}

type RequestBody = ResetBody | SaveBody;

interface BoundaryRow {
  id: string;
  project_id: string;
  source: 'cadastral' | 'operator';
  polygon_latlng: Array<[number, number]>;
  cadastral_snapshot: Array<[number, number]> | null;
  side_measurements_enabled: boolean;
  side_measurements_overrides: Record<string, unknown> | null;
  sqm_total_enabled: boolean;
  sqm_total_position_offset_px: [number, number] | null;
  sqm_total_value_override: number | null;
  address_overlay_enabled: boolean;
  address_overlay_position_latlng: [number, number] | null;
  address_overlay_text_override: string | null;
  updated_by: string | null;
  updated_at: string;
  version: number;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Validate a polygon_latlng payload. Returns either an error string or a
 * normalised [[lat,lng], ...] array (numbers, ≥3 vertices, in-range).
 *
 * Closing duplicates are NOT auto-stripped — Konva-style editors that close
 * the loop explicitly should send N+1 vertices identical to vertex 0; the
 * render engine treats the polygon as closed regardless. We just enforce a
 * minimum length of 3 distinct-or-not vertices so the boundary is a polygon.
 */
function validatePolygon(raw: unknown): { polygon: Array<[number, number]>; error?: undefined } | { polygon?: undefined; error: string } {
  if (!Array.isArray(raw)) {
    return { error: 'polygon_latlng must be an array' };
  }
  if (raw.length < 3) {
    return { error: `polygon_latlng must have at least 3 vertices (got ${raw.length})` };
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!Array.isArray(v) || v.length !== 2) {
      return { error: `polygon_latlng[${i}] must be a [lat, lng] pair` };
    }
    const lat = Number(v[0]);
    const lng = Number(v[1]);
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
      return { error: `polygon_latlng[${i}] must contain finite lat,lng numbers` };
    }
    if (lat < -90 || lat > 90) {
      return { error: `polygon_latlng[${i}].lat must be in [-90, 90] (got ${lat})` };
    }
    if (lng < -180 || lng > 180) {
      return { error: `polygon_latlng[${i}].lng must be in [-180, 180] (got ${lng})` };
    }
    out.push([lat, lng]);
  }
  return { polygon: out };
}

/**
 * Validate the optional [dx, dy] pixel-offset overrides — must be a 2-tuple
 * of finite numbers, or null/undefined.
 */
function validateOffsetPx(raw: unknown, name: string): { value: [number, number] | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw === null || raw === undefined) return { value: null };
  if (!Array.isArray(raw) || raw.length !== 2) {
    return { error: `${name} must be a [dx, dy] tuple or null` };
  }
  const dx = Number(raw[0]);
  const dy = Number(raw[1]);
  if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) {
    return { error: `${name} must contain finite numbers` };
  }
  return { value: [dx, dy] };
}

/**
 * Validate the optional [lat, lng] address-overlay position override.
 */
function validateLatLng(raw: unknown, name: string): { value: [number, number] | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw === null || raw === undefined) return { value: null };
  if (!Array.isArray(raw) || raw.length !== 2) {
    return { error: `${name} must be a [lat, lng] tuple or null` };
  }
  const lat = Number(raw[0]);
  const lng = Number(raw[1]);
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
    return { error: `${name} must contain finite lat, lng numbers` };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { error: `${name} out of range [(-90,-180), (90,180)]` };
  }
  return { value: [lat, lng] };
}

/**
 * Validate the side_measurements_overrides JSON shape:
 *   { "<edge_idx>": { hide?: boolean, label_offset_px?: [dx, dy] } }
 * Reject anything else so a typo doesn't slide through and silently no-op.
 */
function validateSideOverrides(raw: unknown): { value: Record<string, unknown> | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'side_measurements_overrides must be an object keyed by edge index, or null' };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) {
      return { error: `side_measurements_overrides keys must be edge-index strings (got "${k}")` };
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { error: `side_measurements_overrides["${k}"] must be an object` };
    }
    const entry = v as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    if ('hide' in entry) {
      if (typeof entry.hide !== 'boolean') {
        return { error: `side_measurements_overrides["${k}"].hide must be boolean` };
      }
      cleaned.hide = entry.hide;
    }
    if ('label_offset_px' in entry) {
      const off = validateOffsetPx(entry.label_offset_px, `side_measurements_overrides["${k}"].label_offset_px`);
      if (off.error) return { error: off.error };
      cleaned.label_offset_px = off.value;
    }
    out[k] = cleaned;
  }
  return { value: out };
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

  // Health-check post-auth — see drone-render-approve / drone-pins-save for
  // the rationale. The probe must traverse auth so call-audit sees realistic
  // wall-clock latency.
  if ((body as { _health_check?: boolean })._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const projectId = (body.project_id || '').trim();
  if (!projectId) return errorResponse('project_id required', 400, req);

  // ── Authz ────────────────────────────────────────────────────────────────
  // Mirror RLS in mig 284:
  //   read+write open to master_admin/admin always
  //   manager/employee with project visibility
  //   contractor BLOCKED from boundary writes (read-only)
  //
  // Contractors are rejected explicitly — even if their RLS read scope
  // includes the project. The architect plan calls for hard refusal at the
  // edge fn so a misconfigured RLS doesn't leak write capability.
  const role = user.role || '';
  if (role === 'contractor') {
    return errorResponse('Forbidden — contractors cannot edit boundaries', 403, req);
  }

  if (!['master_admin', 'admin'].includes(role)) {
    // RLS visibility check via the user-scoped client — the same projects
    // the user can read in the app. We don't trust caller-supplied IDs
    // unless the user can read the row.
    const userClient = getUserClient(req);
    const { data: rlsProj, error: rlsErr } = await userClient
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .maybeSingle();
    if (rlsErr) {
      console.error(`[${GENERATOR}] RLS check failed:`, rlsErr);
      return errorResponse('Project access check failed', 500, req);
    }
    if (!rlsProj) return errorResponse('Forbidden — project not visible', 403, req);
  }

  const admin = getAdminClient();

  // ── Project sanity (404 if it doesn't exist; FK on the boundary row will
  //   also catch it but we want a clear 404 vs a generic 500).
  const { data: projRow, error: projErr } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) {
    console.error(`[${GENERATOR}] project lookup failed:`, projErr);
    return errorResponse('Project lookup failed', 500, req);
  }
  if (!projRow) return errorResponse('Project not found', 404, req);

  // ── Load existing row (may be null on first edit) ────────────────────────
  const { data: existingRaw, error: existingErr } = await admin
    .from('drone_property_boundary')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();
  if (existingErr) {
    console.error(`[${GENERATOR}] boundary lookup failed:`, existingErr);
    return errorResponse('Boundary lookup failed', 500, req);
  }
  const existing = (existingRaw || null) as BoundaryRow | null;

  // ── Optimistic concurrency ───────────────────────────────────────────────
  // The client must echo the version it loaded. If a different actor saved
  // in between, we reject with 409 + the server-side state so the client
  // can re-prompt or merge.
  const versionForConcurrency =
    typeof body.version_for_concurrency === 'number' ? body.version_for_concurrency : null;
  if (existing && versionForConcurrency !== null && existing.version !== versionForConcurrency) {
    return jsonResponse(
      {
        success: false,
        error: 'version_mismatch',
        message: `Server has version ${existing.version}; client sent ${versionForConcurrency}. Reload the editor.`,
        current_version: existing.version,
        current_row: existing,
      },
      409,
      req,
    );
  }

  const actorId = user.id === '__service_role__' ? null : user.id;

  // ── Branch: reset_to_cadastral ──────────────────────────────────────────
  if (body.action === 'reset_to_cadastral') {
    if (!existing) {
      return errorResponse(
        'No existing boundary row to reset — fetch the cadastral polygon first',
        400,
        req,
      );
    }
    if (!existing.cadastral_snapshot || existing.cadastral_snapshot.length < 3) {
      return errorResponse(
        'No cadastral_snapshot available to reset to. Save an operator edit first to capture one.',
        400,
        req,
      );
    }
    const { data: resetRow, error: resetErr } = await admin
      .from('drone_property_boundary')
      .update({
        polygon_latlng: existing.cadastral_snapshot,
        source: 'cadastral',
        updated_by: actorId,
      })
      .eq('id', existing.id)
      .select('*')
      .maybeSingle();
    if (resetErr || !resetRow) {
      console.error(`[${GENERATOR}] reset_to_cadastral update failed:`, resetErr);
      return errorResponse(
        `Reset failed: ${resetErr?.message || 'no row returned'}`,
        500,
        req,
      );
    }
    const savedRow = resetRow as BoundaryRow;

    const { event_id, cascade_pending, cascade_error } = await emitEventAndEnqueueCascade(
      admin,
      {
        projectId,
        savedRow,
        actorId,
        actorIsService: user.id === '__service_role__',
        priorVersion: existing.version,
        changeKind: 'reset_to_cadastral',
        changedFields: ['polygon_latlng', 'source'],
      },
    );

    if (!cascade_pending && cascade_error) {
      // Cascade enqueue failed. Save succeeded — return 500 with the saved
      // row so the client can decide to retry the enqueue.
      return jsonResponse(
        {
          success: false,
          error: 'cascade_enqueue_failed',
          message: cascade_error,
          saved_row: savedRow,
          version: savedRow.version,
          event_id,
        },
        500,
        req,
      );
    }

    return jsonResponse(
      {
        success: true,
        action: 'reset_to_cadastral',
        version: savedRow.version,
        row: savedRow,
        event_id,
        cascade_kind: 'boundary_save_render_cascade',
        cascade_pending,
      },
      200,
      req,
    );
  }

  // ── Branch: standard save ───────────────────────────────────────────────
  // Validate the polygon first — fail fast on bad input.
  const polyResult = validatePolygon((body as SaveBody).polygon_latlng);
  if (polyResult.error) return errorResponse(polyResult.error, 400, req);
  const polygon = polyResult.polygon;

  // Optional overrides (each may be null/undefined; null = "use auto").
  const sqmOffset = validateOffsetPx(
    (body as SaveBody).sqm_total_position_offset_px,
    'sqm_total_position_offset_px',
  );
  if (sqmOffset.error) return errorResponse(sqmOffset.error, 400, req);

  const addrPos = validateLatLng(
    (body as SaveBody).address_overlay_position_latlng,
    'address_overlay_position_latlng',
  );
  if (addrPos.error) return errorResponse(addrPos.error, 400, req);

  const sideOverrides = validateSideOverrides((body as SaveBody).side_measurements_overrides);
  if (sideOverrides.error) return errorResponse(sideOverrides.error, 400, req);

  const sqmValue =
    (body as SaveBody).sqm_total_value_override === null ||
    (body as SaveBody).sqm_total_value_override === undefined
      ? null
      : Number((body as SaveBody).sqm_total_value_override);
  if (sqmValue !== null && (!Number.isFinite(sqmValue) || sqmValue < 0)) {
    return errorResponse('sqm_total_value_override must be a non-negative number or null', 400, req);
  }

  const addrText =
    (body as SaveBody).address_overlay_text_override === null ||
    (body as SaveBody).address_overlay_text_override === undefined
      ? null
      : String((body as SaveBody).address_overlay_text_override);

  // Boolean toggles default to true (matching schema defaults) so a client
  // that omits them doesn't accidentally hide overlays.
  const sideEnabled = (body as SaveBody).side_measurements_enabled !== false;
  const sqmEnabled = (body as SaveBody).sqm_total_enabled !== false;
  const addrEnabled = (body as SaveBody).address_overlay_enabled !== false;

  // ── Capture cadastral_snapshot on first operator edit ─────────────────
  // Per spec: snapshot whenever existing IS NULL OR existing.source='cadastral'.
  // Source = the polygon as it stood BEFORE this operator edit.
  //
  //   - existing.source='cadastral' → existing.polygon_latlng was the DCDB
  //     polygon. Copy it directly; no extra HTTP call.
  //   - existing IS NULL → fetch from drone-cadastral. If that fails we
  //     still allow the save but cadastral_snapshot stays null (Reset will
  //     just be unavailable until the next successful cadastral fetch).
  let cadastralSnapshot: Array<[number, number]> | null = existing?.cadastral_snapshot ?? null;
  const isFirstOperatorEdit = !existing || existing.source === 'cadastral';
  if (isFirstOperatorEdit) {
    if (existing && existing.source === 'cadastral' && Array.isArray(existing.polygon_latlng)) {
      cadastralSnapshot = existing.polygon_latlng;
    } else {
      // First write ever — try to grab the DCDB polygon for Reset support.
      try {
        const cad = await fetchCadastral(req, projectId);
        if (cad && Array.isArray(cad.polygon) && cad.polygon.length >= 3) {
          cadastralSnapshot = cad.polygon
            .filter((v): v is { lat: number; lng: number } =>
              v && typeof v === 'object' && isFiniteNumber((v as { lat?: unknown }).lat) && isFiniteNumber((v as { lng?: unknown }).lng),
            )
            .map((v) => [v.lat, v.lng] as [number, number]);
          if (cadastralSnapshot.length < 3) cadastralSnapshot = null;
        }
      } catch (e) {
        console.warn(
          `[${GENERATOR}] cadastral snapshot fetch failed (non-fatal):`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  // ── UPSERT ───────────────────────────────────────────────────────────────
  // ON CONFLICT (project_id) DO UPDATE — schema has UNIQUE(project_id).
  // We always set source='operator' on a save; reset is a separate branch.
  const payload = {
    project_id: projectId,
    source: 'operator' as const,
    polygon_latlng: polygon,
    cadastral_snapshot: cadastralSnapshot,
    side_measurements_enabled: sideEnabled,
    side_measurements_overrides: sideOverrides.value,
    sqm_total_enabled: sqmEnabled,
    sqm_total_position_offset_px: sqmOffset.value,
    sqm_total_value_override: sqmValue,
    address_overlay_enabled: addrEnabled,
    address_overlay_position_latlng: addrPos.value,
    address_overlay_text_override: addrText,
    updated_by: actorId,
  };

  const { data: upRowRaw, error: upErr } = await admin
    .from('drone_property_boundary')
    .upsert(payload, { onConflict: 'project_id' })
    .select('*')
    .maybeSingle();
  if (upErr || !upRowRaw) {
    console.error(`[${GENERATOR}] upsert failed:`, upErr);
    return errorResponse(
      `Boundary upsert failed: ${upErr?.message || 'no row returned'}`,
      500,
      req,
    );
  }
  const savedRow = upRowRaw as BoundaryRow;

  // Compute the diff for the audit event payload — surfaces what changed.
  const changedFields = computeChangedFields(existing, savedRow);

  const { event_id, cascade_pending, cascade_error } = await emitEventAndEnqueueCascade(
    admin,
    {
      projectId,
      savedRow,
      actorId,
      actorIsService: user.id === '__service_role__',
      priorVersion: existing?.version ?? null,
      changeKind: existing ? 'boundary_edit' : 'boundary_create',
      changedFields,
    },
  );

  if (!cascade_pending && cascade_error) {
    return jsonResponse(
      {
        success: false,
        error: 'cascade_enqueue_failed',
        message: cascade_error,
        saved_row: savedRow,
        version: savedRow.version,
        event_id,
      },
      500,
      req,
    );
  }

  return jsonResponse(
    {
      success: true,
      version: savedRow.version,
      row: savedRow,
      event_id,
      cascade_kind: 'boundary_save_render_cascade',
      cascade_pending,
      // Telemetry: list of fields whose value differs between prior and saved
      // row. Useful for the swimlane to decide which downstream caches to
      // invalidate (e.g. only invalidate edited renders if polygon_latlng
      // changed; toggling address_overlay_enabled doesn't need a re-render
      // if the dispatcher is smart, but in the v1 cascade we always re-run).
      changed_fields: changedFields,
    },
    200,
    req,
  );
});

/**
 * Emit the drone_events row + enqueue the cascade job. Returns the event_id
 * (or null) and a cascade_pending flag (true on success). cascade_error is
 * set on failure so the caller can surface 500 with the saved row.
 *
 * The dispatcher (S3 stream) routes kind='boundary_save_render_cascade' to
 * drone-render-edited which fans out per-shoot. We deliberately do NOT do
 * the per-shoot enqueue here — separation of concerns + future-proof.
 */
async function emitEventAndEnqueueCascade(
  admin: ReturnType<typeof getAdminClient>,
  args: {
    projectId: string;
    savedRow: BoundaryRow;
    actorId: string | null;
    actorIsService: boolean;
    priorVersion: number | null;
    changeKind: 'boundary_create' | 'boundary_edit' | 'reset_to_cadastral';
    changedFields: string[];
  },
): Promise<{ event_id: number | null; cascade_pending: boolean; cascade_error?: string }> {
  let event_id: number | null = null;
  {
    const { data: evRow, error: evErr } = await admin
      .from('drone_events')
      .insert({
        project_id: args.projectId,
        shoot_id: null,
        event_type: 'boundary_edit_saved',
        actor_type: args.actorIsService ? 'system' : 'user',
        actor_id: args.actorIsService ? null : args.actorId,
        payload: {
          change_kind: args.changeKind,
          new_version: args.savedRow.version,
          prior_version: args.priorVersion,
          new_source: args.savedRow.source,
          changed_fields: args.changedFields,
          vertex_count: Array.isArray(args.savedRow.polygon_latlng)
            ? args.savedRow.polygon_latlng.length
            : 0,
        },
      })
      .select('id')
      .maybeSingle();
    if (evErr) {
      console.warn(`[drone-boundary-save] event insert failed (non-fatal):`, evErr);
    } else if (evRow) {
      event_id = (evRow as { id: number }).id;
    }
  }

  // Cascade: ONE row of kind='boundary_save_render_cascade'. The dispatcher
  // is responsible for fanning out to per-shoot render_edited jobs.
  //
  // pipeline='edited' is carried in the payload so the dispatcher can route
  // without re-querying drone_renders. shoot_id is intentionally null at
  // this enqueue — boundary edits are project-scoped (every shot in every
  // shoot in the project re-projects with the new polygon).
  const { data: jobRow, error: jobErr } = await admin
    .from('drone_jobs')
    .insert({
      project_id: args.projectId,
      shoot_id: null,
      kind: 'boundary_save_render_cascade',
      status: 'pending',
      payload: {
        project_id: args.projectId,
        pipeline: 'edited',
        source_event_id: event_id,
        source_version: args.savedRow.version,
        change_kind: args.changeKind,
        changed_fields: args.changedFields,
      },
    })
    .select('id')
    .maybeSingle();
  if (jobErr || !jobRow) {
    const msg = jobErr?.message || 'cascade enqueue returned no row';
    console.error(`[drone-boundary-save] cascade enqueue failed:`, jobErr);
    return { event_id, cascade_pending: false, cascade_error: msg };
  }
  return { event_id, cascade_pending: true };
}

/**
 * Compare the prior and saved boundary rows; return the list of column
 * names that differ. Used for the audit event payload + telemetry.
 */
function computeChangedFields(
  prior: BoundaryRow | null,
  saved: BoundaryRow,
): string[] {
  if (!prior) return ['__created__'];
  const changed: string[] = [];
  const keys: (keyof BoundaryRow)[] = [
    'source',
    'polygon_latlng',
    'cadastral_snapshot',
    'side_measurements_enabled',
    'side_measurements_overrides',
    'sqm_total_enabled',
    'sqm_total_position_offset_px',
    'sqm_total_value_override',
    'address_overlay_enabled',
    'address_overlay_position_latlng',
    'address_overlay_text_override',
  ];
  for (const k of keys) {
    if (JSON.stringify(prior[k]) !== JSON.stringify(saved[k])) changed.push(k as string);
  }
  return changed;
}

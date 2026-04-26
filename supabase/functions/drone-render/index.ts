/**
 * drone-render
 * ────────────
 * Renders annotated RAW drone images for a shoot. Wave 5 P2 reduced this
 * function to the RAW pipeline ONLY — the edited pipeline is owned by
 * drone-render-edited (S3). Any caller that passes `body.pipeline='edited'`
 * is hard-rejected with a 400; pin-editor saves now route to the edited
 * function and are rejected here too.
 *
 * For each shot in the shoot:
 *   1. Resolves theme via shared `loadThemeChain` (person → org → system).
 *   2. Loads drone_custom_pins (manual + AI POIs, mig 268 unified model).
 *   3. Fetches POIs (drone-pois) + cadastral polygon (drone-cadastral).
 *   4. Downloads source image from Dropbox — ALWAYS shot.dropbox_path
 *      (raw JPG). Edited paths are never read by this function.
 *   5. Calls Modal render worker via shared callModalRender helper.
 *   6. Uploads rendered output to drones_raws_shortlist_proposed_previews/
 *      (the Raw Pool column in the new swimlane reads from this folder).
 *   7. Inserts drone_renders row with pipeline='raw' (explicit, even though
 *      mig 282 set DEFAULT 'raw') and column_state defaulting to 'pool'.
 *
 * Inputs:
 *   POST { shoot_id }                 → render every shot in the shoot
 *   POST { shoot_id, shot_id }        → render one specific shot (re-render)
 *   POST { shoot_id, kind }           → 'poi' | 'boundary' | 'poi_plus_boundary'
 *                                       (default: 'poi_plus_boundary')
 *   POST { shoot_id, wipe_existing }  → wipe pipeline='raw' rows for the shoot
 *                                       BEFORE rendering (Re-analyse swimlane action)
 *   POST { shoot_id, column_state }   → caller-requested initial column_state
 *                                       (must be one of pool|accepted|rejected)
 *
 * Auth:
 *   - master_admin / admin / manager / employee with project access
 *   - OR service_role (called by drone-job-dispatcher)
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from "../_shared/supabase.ts";
import { getFolderPath } from "../_shared/projectFolders.ts";
import { downloadFile, uploadFile } from "../_shared/dropbox.ts";
import { mergeConfigChain } from "../_shared/themeResolver.ts";
import {
  type RenderKind,
  type RenderResult,
  type PoisSubcallTelemetry,
  RENDER_TOKEN,
  resolveRenderKind,
  applyKindToTheme,
  loadThemeChain,
  loadCustomPins,
  fetchPois,
  fetchCadastral,
  needsPois,
  needsBoundary,
  callModalRender,
  decodeModalVariants,
  buildAddressOverlay,
  normalisePoisForModal,
  buildSceneCustomPins,
  capPinsByMax,
  filenameForRender,
} from "../_shared/droneRenderCommon.ts";

const GENERATOR = "drone-render";

/**
 * Wave 5 P2 (S2): the only pipeline this function handles. Stamped on every
 * drone_renders insert and on every continuation drone_jobs payload.
 */
const PIPELINE: 'raw' = 'raw';

/**
 * Raw-pipeline column_state lanes (mig 282 CHECK). 'pool' is the swimlane's
 * Raw Pool column (was 'preview'/'proposed' pre-mig); accepted/rejected are
 * operator-locked transitions.
 */
const RAW_COLUMN_STATES = ['pool', 'accepted', 'rejected'] as const;
type RawColumnState = typeof RAW_COLUMN_STATES[number];

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === "__service_role__";
  if (!isService) {
    if (!user) return errorResponse("Authentication required", 401, req);
    if (!["master_admin", "admin", "manager", "employee"].includes(user.role || "")) {
      return errorResponse("Forbidden", 403, req);
    }
  }

  let body: {
    shoot_id?: string;
    shot_id?: string;
    kind?: RenderKind;
    /**
     * Caller-requested column_state for the resulting drone_renders row.
     * RAW pipeline only — must be one of ('pool','accepted','rejected').
     * Defaults to 'pool' (the swimlane's Raw Pool column).
     */
    column_state?: RawColumnState;
    /**
     * When true, DELETE existing pipeline='raw' renders for this shoot
     * BEFORE rendering. Used by the swimlane Re-analyse action so a fresh
     * render run replaces the prior raw renders rather than piling up
     * alongside them. Edited-pipeline rows (handled by drone-render-edited)
     * are NEVER touched by this wipe — strict pipeline isolation.
     *
     * Wave 5 P2 change: previously this could wipe 'adjustments' or other
     * non-raw lanes when the pin-edit alias was set. That routing now belongs
     * to drone-render-edited; here wipe_existing=true wipes RAW only.
     */
    wipe_existing?: boolean;
    /**
     * Pipeline routing field — when present MUST equal 'raw'. Wave 5 P2:
     * this function rejects pipeline='edited' with a 400 directing the
     * caller to drone-render-edited. Callers that don't set the field are
     * implicitly raw (back-compat for pre-S2 dispatcher payloads).
     */
    pipeline?: 'raw' | 'edited';
    /**
     * Pre-S2 alias for the Pin Editor save path. Wave 5 P2: this routing
     * moved to drone-render-edited (S3 owns the edited pipeline). drone-render
     * rejects 'pin_edit_saved' with a 400 so any stale caller is forced to
     * update its endpoint rather than silently producing wrong-pipeline rows.
     */
    reason?: string;
    /**
     * W10-S2: dispatcher sets this on the retry payload after detecting a
     * Modal-side resource limit (WORKER_RESOURCE_LIMIT or 5xx). When true,
     * we lower PER_INVOCATION_CAP from 4 to 2 for THIS invocation only so
     * the next attempt has a smaller per-call working set and is less
     * likely to OOM the Modal worker. The flag is one-shot — the
     * continuation enqueue does not propagate it.
     */
    next_attempt_smaller_batch?: boolean;
    _health_check?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: "v2.0-raw-only", _fn: GENERATOR }, 200, req);
  }

  // ── PIPELINE GUARD (Wave 5 P2 S2) ────────────────────────────────
  // drone-render is now the RAW-ONLY pipeline. Any explicit edited request
  // is rejected at the door so no row can be misrouted. Callers that don't
  // set body.pipeline are implicitly raw (back-compat).
  if (body.pipeline === 'edited') {
    return errorResponse(
      "drone-render handles raw pipeline only. Use drone-render-edited for the edited pipeline.",
      400,
      req,
    );
  }
  if (body.reason === 'pin_edit_saved') {
    return errorResponse(
      "Pin Editor saves route to drone-render-edited (edited pipeline). drone-render rejects reason='pin_edit_saved'.",
      400,
      req,
    );
  }
  if (body.column_state && !RAW_COLUMN_STATES.includes(body.column_state)) {
    return errorResponse(
      `column_state '${body.column_state}' not allowed on raw pipeline (allowed: ${RAW_COLUMN_STATES.join(', ')}). For 'adjustments' or 'final' use drone-render-edited.`,
      400,
      req,
    );
  }

  if (!body.shoot_id) return errorResponse("shoot_id required", 400, req);
  if (!RENDER_TOKEN) {
    return errorResponse(
      "FLEXSTUDIOS_RENDER_TOKEN secret not set; render bridge unavailable",
      500,
      req,
    );
  }

  // ── Resolve render kind ───────────────────────────────────────────
  // resolveRenderKind maps 'preview' → 'poi_plus_boundary' (kind enum CHECK
  // forbids 'preview' as a stored value — mig 225) and validates the rest.
  const kindResolved = resolveRenderKind(body.kind as string | undefined);
  if (kindResolved.error) {
    return errorResponse(kindResolved.error, 400, req);
  }
  const kind = kindResolved.kind!;

  const admin = getAdminClient();

  // ── Load shoot + project ─────────────────────────────────────────
  const { data: shoot, error: shootErr } = await admin
    .from("drone_shoots")
    .select("id, project_id, has_nadir_grid, status, image_count, theme_id, sfm_residual_median_m")
    .eq("id", body.shoot_id)
    .maybeSingle();
  if (shootErr) return errorResponse(`shoot lookup failed: ${shootErr.message}`, 500, req);
  if (!shoot) return errorResponse(`shoot ${body.shoot_id} not found`, 404, req);

  const { data: project, error: projErr } = await admin
    .from("projects")
    .select(
      "id, property_address, property_suburb, geocoded_lat, geocoded_lng, confirmed_lat, confirmed_lng, agency_id, primary_contact_person_id",
    )
    .eq("id", shoot.project_id)
    .maybeSingle();
  if (projErr || !project)
    return errorResponse(`project lookup failed: ${projErr?.message || "missing"}`, 500, req);

  // ── Load drone_custom_pins (UNIFIED model, mig 268) ────────────────
  const pinsLoaded = await loadCustomPins(admin, { shoot_id: shoot.id, project_id: project.id });
  if (pinsLoaded.warning) {
    console.warn(`[${GENERATOR}] ${pinsLoaded.warning}`);
  }
  const { worldCustomPins, pixelPinsByShot } = pinsLoaded;

  // ── Load shots to render ─────────────────────────────────────────
  let shotQ = admin
    .from("drone_shots")
    .select(
      // edited_dropbox_path is intentionally NOT selected — raw pipeline
      // never reads it (Wave 5 P2). drone-render-edited owns that column.
      "id, shoot_id, dropbox_path, filename, gps_lat, gps_lon, relative_altitude, flight_yaw, gimbal_pitch, gimbal_roll, flight_roll, shot_role, sfm_pose, registered_in_sfm",
    )
    .eq("shoot_id", shoot.id);
  if (body.shot_id) shotQ = shotQ.eq("id", body.shot_id);
  // Render eligibility (same set as pre-S2; nadir_grid stays SfM-only):
  shotQ = shotQ.in(
    "shot_role",
    ["nadir_hero", "orbital", "oblique_hero", "building_hero", "unclassified"],
  );

  const { data: shotsAll, error: shotsErr } = await shotQ;
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);
  if (!shotsAll || shotsAll.length === 0) {
    return errorResponse("no eligible shots found for shoot", 400, req);
  }

  // ── Source resolution: ALWAYS shot.dropbox_path (RAW pipeline) ───
  // Wave 5 P2: removed the per-shot edited_dropbox_path branch. Raw pipeline
  // never reads the editor-delivered file — that's drone-render-edited's job.
  // Even nadir_hero (which historically could go either way) renders from
  // the raw here, since this function defines the raw lane outputs.
  function resolveSourcePath(shot: { dropbox_path: string }): { path: string } {
    return { path: shot.dropbox_path };
  }

  // ── Optional wipe of prior renders for THIS pipeline ──────────────
  // Wave 5 P2: wipe_existing=true now wipes pipeline='raw' renders only.
  // Edited-pipeline rows are owned by drone-render-edited and untouched here.
  // Final/rejected slots are NEVER wiped (operator-locked) but for raw the
  // analogous "operator-locked" lane is column_state='accepted' — strictly
  // we wipe column_state IN ('pool') only. 'accepted'/'rejected' are
  // operator decisions and must survive a Re-analyse.
  if (body.wipe_existing === true) {
    const shotIds = shotsAll.map((s) => s.id);
    const { error: wipeErr } = await admin
      .from("drone_renders")
      .delete()
      .eq("kind", kind)
      .eq("pipeline", PIPELINE)
      .eq("column_state", "pool")
      .in("shot_id", shotIds);
    if (wipeErr) {
      return errorResponse(`wipe_existing failed: ${wipeErr.message}`, 500, req);
    }
  }

  // ── Skip shots that already have an active raw render row ────────
  // The unique partial index from migration 233 + 282's pipeline-aware
  // column_state CHECK mean writing a duplicate (shot,kind,variant,state,
  // pipeline) row would 23505 the insert. Pre-filtering also lets us split a
  // 34-shot ingest across multiple Edge Function invocations (each capped at
  // 145s wall-clock).
  //
  // We skip against pool/accepted/rejected — every raw column_state. A shot
  // that operators have already accepted shouldn't be re-rendered into the
  // pool by a routine Re-analyse (the wipe above only clears 'pool', so
  // accepted survives, and this skip prevents a duplicate insert).
  const { data: existingRenders } = await admin
    .from("drone_renders")
    .select("shot_id")
    .eq("kind", kind)
    .eq("pipeline", PIPELINE)
    .in("column_state", RAW_COLUMN_STATES as readonly string[])
    .in("shot_id", shotsAll.map((s) => s.id));
  const alreadyRenderedSet = new Set((existingRenders || []).map((r) => r.shot_id));
  const shots = shotsAll.filter((s) => !alreadyRenderedSet.has(s.id));
  if (shots.length === 0) {
    return jsonResponse({
      success: true,
      pipeline: PIPELINE,
      shoot_id: shoot.id,
      kind,
      shots_total: shotsAll.length,
      shots_rendered: 0,
      shots_already_rendered: shotsAll.length,
      results: [],
    }, 200, req);
  }
  // Cap per-invocation work to avoid OOM. With concurrency=1 (sequential)
  // only ONE shot's footprint is live at any time, so the cap is wall-clock-
  // bound (4 × ~40s = 160s, slightly over the 145s wall-clock cap; the
  // continuation enqueue below picks up where we left off).
  //
  // W10-S2: when the dispatcher sets payload.next_attempt_smaller_batch=true
  // (on a retry after detecting a Modal WORKER_RESOURCE_LIMIT or 5xx), drop
  // the cap from 4 to 2 for THIS invocation. Smaller working set = less
  // RAM contention on the Modal worker = better chance of clean completion.
  // The continuation enqueue below intentionally does NOT propagate the
  // flag — we only want the smaller batch on the immediate retry tick.
  const PER_INVOCATION_CAP = body.next_attempt_smaller_batch === true ? 2 : 4;
  if (body.next_attempt_smaller_batch === true) {
    console.warn(
      `[${GENERATOR}] next_attempt_smaller_batch=true — capping invocation at ${PER_INVOCATION_CAP} shots (Modal resource-limit retry)`,
    );
  }
  const shotsCapped = shots.slice(0, PER_INVOCATION_CAP);
  const moreRemaining = shots.length - shotsCapped.length;

  // ── Resolve theme via inheritance chain ──────────────────────────
  const themeChain = await loadThemeChain(admin, {
    person_id: project.primary_contact_person_id,
    organisation_id: project.agency_id,
  });
  const orderedForMerge = [...themeChain].reverse();
  const themeResolved = mergeConfigChain(orderedForMerge.map((t) => t.config));
  const themeForKind = applyKindToTheme(themeResolved, kind);

  // ── Fetch POIs + cadastral via internal Edge Functions ───────────
  const projectCoord = {
    lat: Number(project.confirmed_lat ?? project.geocoded_lat),
    lng: Number(project.confirmed_lng ?? project.geocoded_lng),
  };
  if (!Number.isFinite(projectCoord.lat) || !Number.isFinite(projectCoord.lng)) {
    return errorResponse("project has no usable coordinates (confirmed or geocoded)", 400, req);
  }

  // ── POIs (W3-PINS): unified drone_custom_pins is canonical now ────────
  // After mig 268 + drone-pois rewrite, AI POIs live as drone_custom_pins
  // rows with source='ai' (already in `worldCustomPins`). The legacy fetchPois
  // sub-call is retained ONLY for projects whose drone-pois has not yet been
  // re-run post-mig 268 (so the unified table is empty for that project).
  const haveAiPinsAlready = worldCustomPins.some((p) => p.source === 'ai');
  const themeRadius = Number((themeForKind as { poi_selection?: { radius_m?: number } })?.poi_selection?.radius_m);
  const radiusToUse = Number.isFinite(themeRadius) && themeRadius > 0 ? themeRadius : undefined;
  const themeQuotas = (themeForKind as { poi_selection?: { type_quotas?: Record<string, { priority?: number; max?: number }> | null } })?.poi_selection?.type_quotas ?? null;
  const poiSubcallTelemetry: PoisSubcallTelemetry = {};
  const [pois, cadastral] = await Promise.all([
    needsPois(kind) && !haveAiPinsAlready
      ? fetchPois(req, project.id, poiSubcallTelemetry, { radiusM: radiusToUse, typeQuotas: themeQuotas, pipeline: PIPELINE })
      : Promise.resolve([]),
    needsBoundary(kind) ? fetchCadastral(req, project.id) : Promise.resolve(null),
  ]);

  // ── Render-time snapshots ────────────────────────────────────────
  // Per architect plan B.1: ensure theme/pois/boundary snapshots are
  // populated on every drone_renders row so post-hoc audits can reproduce
  // the inputs that produced any given output. The drone_renders table only
  // has the legacy `theme_snapshot` jsonb column today; we stash POI +
  // boundary snapshots inside it as a composite { theme, pois_snapshot,
  // boundary_snapshot } when there's no canonical theme_id to point at,
  // and we put pois_snapshot + boundary_snapshot into pin_overrides
  // unconditionally so the data is reproducible regardless. A future
  // migration can promote these to dedicated columns; the wrapper shape
  // here is forward-compatible (consumers read the wrapped keys directly).
  //
  // boundary_snapshot for raw pipeline = the cadastral DCDB polygon at
  // fetch time. S5 wires the operator-edited boundary into
  // drone-render-edited; raw side stays cadastral-only.
  const renderTimeIso = new Date().toISOString();
  const poisSnapshot = pois && Array.isArray(pois) ? { fetched_at: renderTimeIso, count: pois.length, pois } : null;
  const boundarySnapshot = cadastral && Array.isArray(cadastral.polygon)
    ? { fetched_at: renderTimeIso, source: 'cadastral', polygon: cadastral.polygon }
    : null;

  // ── Output folder + initial column_state (RAW pipeline) ──────────
  // Wave 5 P2: the raw pipeline writes to drones_raws_shortlist_proposed_previews/.
  // The new swimlane's "Raw Pool" column reads from this folder via the
  // pipeline='raw' + column_state='pool' filter on drone_renders.
  const outFolder = await getFolderPath(project.id, "drones_raws_shortlist_proposed_previews");
  const requestedColumnState = body.column_state;
  const initialColumnState: RawColumnState = requestedColumnState ?? 'pool';

  // Defensive: warn if the request is for a non-default raw column_state
  // (e.g. caller pre-sets 'accepted' which would skip the operator review
  // step). Don't fail — operators occasionally re-render an already-accepted
  // row and want to keep the column_state — but surface the unusual state.
  if (initialColumnState !== 'pool') {
    console.warn(
      `[${GENERATOR}] raw render writing column_state='${initialColumnState}' (non-default 'pool') for shoot=${shoot.id}`,
    );
  }

  // ── Update shoot status to 'rendering' ───────────────────────────
  // Optimistic update — only flip if not already in a terminal state.
  await admin
    .from("drone_shoots")
    .update({ status: "rendering" })
    .eq("id", shoot.id)
    .in("status", ["ingested", "sfm_complete", "rendering", "proposed_ready", "adjustments_ready", "render_failed"]);

  // ── Render each shot in parallel chunks ──────────────────────────────
  const renderResults: RenderResult[] = [];
  // Concurrency 1 — see PER_INVOCATION_CAP comment above for OOM rationale.
  const RENDER_CONCURRENCY = 1;

  // fallback='gps_only' is informational; the per-shot loop below does
  // GPS-only projection in all cases (sfm_pose is loaded but unused pending
  // Stream-Z drone-render SfM-aware projection). (#16 audit fix)
  const fallbackGpsOnly = (body as { fallback?: string }).fallback === "gps_only";
  void fallbackGpsOnly;

  // Single-shot render fn (closes over scene/theme deps).
  const renderOneShot = async (shot: typeof shots[number]): Promise<RenderResult> => {
    try {
      const srcResolved = resolveSourcePath(shot);

      // Download source image
      const dlRes = await downloadFile(srcResolved.path);
      if (!dlRes.ok) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: `Dropbox download failed: ${dlRes.status}`,
        };
      }
      const srcBytes = new Uint8Array(await dlRes.arrayBuffer());

      // Build scene. Skip shots with missing GPS (Number(null) = NaN would
      // silently cascade through to Modal). Also skip shots with missing
      // relative_altitude — we no longer fall back to gps_altitude (MSL ≠
      // AGL) so missing AGL means the projection math can't run reliably.
      const scene: Record<string, unknown> = {
        lat: Number(shot.gps_lat),
        lon: Number(shot.gps_lon),
        alt: Number(shot.relative_altitude),
        yaw: Number(shot.flight_yaw),
        pitch: Number(shot.gimbal_pitch),
        property_lat: projectCoord.lat,
        property_lon: projectCoord.lng,
        address: buildAddressOverlay(project),
      };
      if (!Number.isFinite(scene.lat as number) || !Number.isFinite(scene.lon as number)) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: "shot has missing or unparseable GPS — cannot render",
        };
      }
      if (!Number.isFinite(scene.alt as number)) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: "shot has missing relative_altitude (AGL) — cannot render",
        };
      }
      // POIs only render on ORBITAL shots (Joseph 2026-04-25 Everton review).
      const poisAllowedForRole = shot.shot_role === 'orbital';
      if (poisAllowedForRole && pois && pois.length > 0) {
        scene.pois = normalisePoisForModal(pois);
      }
      if (cadastral && Array.isArray(cadastral.polygon)) {
        scene.polygon_latlon = cadastral.polygon.map((v: { lat: number; lng: number }) => [v.lat, v.lng]);
      }

      // ── Custom pins (UNIFIED — operator + AI, mig 268) ───────────
      const pinsForThisShot = buildSceneCustomPins({
        worldCustomPins,
        pixelPinsByShot,
        shotId: shot.id,
        poisAllowedForRole,
      });
      const cappedPins = capPinsByMax(pinsForThisShot, themeForKind);
      if (cappedPins.length > 0) {
        scene.custom_pins = cappedPins;
      }

      // Determine if this theme requested multi-variant output
      const variantsCfg = Array.isArray((themeForKind as { output_variants?: unknown })?.output_variants)
        ? ((themeForKind as { output_variants: Array<Record<string, unknown>> }).output_variants)
        : [];
      const wantVariants = variantsCfg.length > 0;

      // POST to Modal (shared helper handles bearer auth + timeout).
      let modalJson;
      try {
        modalJson = await callModalRender({
          imageBytes: srcBytes,
          theme: themeForKind,
          scene,
          variants: wantVariants,
        });
      } catch (e) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      const variants = decodeModalVariants(modalJson);
      if (variants.length === 0) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: "Modal returned no usable image payload",
        };
      }

      // Upload + insert per variant
      const variantResults: Array<{ variant: string; out_path: string }> = [];
      let anyVariantFailed = false;
      let firstError: string | null = null;
      for (const v of variants) {
        try {
          const outName = filenameForRender(shot.filename, kind, v.name, v.format);
          const outDropboxPath = `${outFolder}/${outName}`;
          const uploadRes = await uploadFile(outDropboxPath, v.bytes, "overwrite");
          if (!uploadRes || !(uploadRes.path_display || uploadRes.path_lower)) {
            anyVariantFailed = true;
            firstError = firstError || `Dropbox upload (${v.name}) returned no path`;
            continue;
          }

          // Theme persistence: when there's a real theme_id in the chain,
          // store the id + version pointer only — the snapshot can be
          // reproduced from drone_themes. Inline snapshot is reserved for
          // ad-hoc previews where there's no canonical theme to refer to.
          const themeIdForRow = themeChain[0]?.theme_id || null;
          const themeIdAtRender = themeChain[0]?.theme_id || null;
          const themeVersionAtRender = themeChain[0]?.version_int ?? null;
          // Composite snapshot bundle (architect B.1 spec). When we own the
          // theme_snapshot column (no canonical theme_id), the snapshot is
          // the wrapped composite { theme, pois_snapshot, boundary_snapshot }
          // so a single jsonb read reproduces all render-time inputs.
          const themeSnapshotBundle = themeIdForRow
            ? null
            : {
                theme: themeForKind,
                pois_snapshot: poisSnapshot,
                boundary_snapshot: boundarySnapshot,
                rendered_at: renderTimeIso,
              };
          // Stash POI + boundary snapshots in pin_overrides regardless of
          // whether theme_snapshot owns them — pin_overrides was previously
          // null and is the safest existing jsonb column for the architect
          // B.1 snapshot requirement until a future migration adds dedicated
          // columns. Consumers read the wrapped keys (pois_snapshot,
          // boundary_snapshot) directly.
          const pinOverridesSnapshot = {
            pois_snapshot: poisSnapshot,
            boundary_snapshot: boundarySnapshot,
            theme_snapshot_at_render: themeForKind,
            rendered_at: renderTimeIso,
          };
          const renderRow: Record<string, unknown> = {
            shot_id: shot.id,
            pipeline: PIPELINE,
            column_state: initialColumnState,
            kind,
            dropbox_path: (uploadRes.path_display || uploadRes.path_lower),
            theme_id: themeIdForRow,
            theme_snapshot: themeSnapshotBundle,
            theme_id_at_render: themeIdAtRender,
            theme_version_int_at_render: themeVersionAtRender,
            property_coord_used: {
              source: project.confirmed_lat ? "confirmed" : "geocoded",
              ...projectCoord,
            },
            pin_overrides: pinOverridesSnapshot,
            output_variant: v.name,
          };
          const { error: insErr } = await admin.from("drone_renders").insert(renderRow);
          if (insErr) {
            anyVariantFailed = true;
            firstError = firstError || `drone_renders insert (${v.name}) failed: ${insErr.message}`;
            continue;
          }

          // Per-variant audit event. Wave 5 P2: raw renders use a single
          // event_type 'render_raw_pool' since the raw pipeline writes to
          // a single column_state (pool) by default. Operators distinguish
          // accepted/rejected via the column_state field on the row, not
          // the event_type.
          await admin.from("drone_events").insert({
            project_id: project.id,
            shoot_id: shot.shoot_id,
            shot_id: shot.id,
            event_type: "render_raw_pool",
            actor_type: isService ? "system" : "user",
            actor_id: isService ? null : user?.id,
            payload: {
              kind,
              pipeline: PIPELINE,
              dropbox_path: (uploadRes.path_display || uploadRes.path_lower),
              theme_chain_levels: themeChain.length,
              output_variant: v.name,
              column_state: initialColumnState,
            },
          });

          variantResults.push({ variant: v.name, out_path: (uploadRes.path_display || uploadRes.path_lower) });
        } catch (vErr) {
          anyVariantFailed = true;
          firstError =
            firstError || (vErr instanceof Error ? vErr.message : String(vErr));
        }
      }

      if (variantResults.length === 0) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: firstError || "All variants failed",
        };
      }

      return {
        shot_id: shot.id,
        filename: shot.filename,
        ok: !anyVariantFailed,
        out_path: variantResults[0].out_path,
        pois_passed: Array.isArray(scene.pois) ? (scene.pois as unknown[]).length : 0,
        pois_first_keys: Array.isArray(scene.pois) && (scene.pois as unknown[])[0]
          ? Object.keys((scene.pois as Record<string, unknown>[])[0])
          : undefined,
        pois_from_fetch: Array.isArray(pois) ? pois.length : -1,
        shot_role_at_render: shot.shot_role || "(null)",
        needs_pois: needsPois(kind),
        pois_subcall_url: poiSubcallTelemetry.url,
        pois_subcall_status: poiSubcallTelemetry.status,
        pois_subcall_body_head: poiSubcallTelemetry.body_head,
        ...(variantResults.length > 1
          ? { variants: variantResults }
          : {}),
        ...(anyVariantFailed ? { error: firstError || undefined } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          fn: GENERATOR,
          pipeline: PIPELINE,
          project_id: project.id,
          shoot_id: shoot.id,
          shot_id: shot.id,
          filename: shot.filename,
          err: msg,
        }),
      );
      return { shot_id: shot.id, filename: shot.filename, ok: false, error: msg };
    }
  };

  for (let i = 0; i < shotsCapped.length; i += RENDER_CONCURRENCY) {
    const chunk = shotsCapped.slice(i, i + RENDER_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(renderOneShot));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === "fulfilled") {
        renderResults.push(r.value);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        const shot = chunk[j];
        console.error(
          JSON.stringify({
            fn: GENERATOR,
            pipeline: PIPELINE,
            project_id: project.id,
            shoot_id: shoot.id,
            shot_id: shot.id,
            err: `unhandled rejection: ${msg}`,
          }),
        );
        renderResults.push({
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: msg,
        });
      }
    }
  }

  const successCount = renderResults.filter((r) => r.ok).length;

  // ── Continuation enqueue ─────────────────────────────────────────
  // If there are still unrendered shots, re-enqueue another render job so
  // the dispatcher picks it up next tick. Wave 5 P2 (architect QC2-1 #4):
  // MUST propagate pipeline='raw' AND column_state AND wipe_existing on the
  // continuation payload. Pre-S2 the continuation dropped these so a 34-
  // shot shoot's later batches would default to whatever the dispatcher
  // synthesised, breaking the operator's intent (e.g. column_state='pool'
  // they explicitly requested would silently flip back).
  if (moreRemaining > 0) {
    const continuationPayload: Record<string, unknown> = {
      shoot_id: shoot.id,
      kind,
      pipeline: PIPELINE,
      reason: "render_continuation",
    };
    if (body.column_state) continuationPayload.column_state = body.column_state;
    // wipe_existing is one-shot — we already wiped above, don't re-wipe on
    // the continuation tick (would race with rows we just inserted). Leave
    // out of the continuation payload by design.
    await admin.from("drone_jobs").insert({
      project_id: project.id,
      shoot_id: shoot.id,
      kind: "render",
      status: "pending",
      pipeline: PIPELINE,
      payload: continuationPayload,
      scheduled_for: new Date(Date.now() + 5_000).toISOString(),
    });
  }

  // Update shoot status. Move to 'proposed_ready' only when ALL shots are done
  // (partial progress keeps it at 'rendering' so the UI shows a spinner).
  let nextStatus = shoot.status;
  if (moreRemaining === 0 && successCount > 0) nextStatus = "proposed_ready";
  else if (moreRemaining === 0 && successCount === 0) nextStatus = "render_failed";
  // else leave at 'rendering' — there's still more to do
  await admin.from("drone_shoots").update({ status: nextStatus }).eq("id", shoot.id);

  return jsonResponse(
    {
      success: true,
      pipeline: PIPELINE,
      shoot_id: shoot.id,
      kind,
      shots_total: shotsAll.length,
      shots_rendered: successCount,
      shots_rendered_this_run: successCount,
      shots_already_rendered: shotsAll.length - shots.length,
      shots_failed_this_run: shotsCapped.length - successCount,
      shots_remaining: moreRemaining,
      results: renderResults,
    },
    200,
    req,
  );
});

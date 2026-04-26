/**
 * drone-render-edited
 * ───────────────────
 * Renders annotated EDITED drone images for a shoot. Wave 5 P2 (S3) is the
 * canonical owner of the edited pipeline — drone-render handles the raw side
 * only and rejects pipeline='edited' at the door, so any caller routing an
 * edited render against drone-render is surfaced as a 400 rather than
 * silently producing a wrong-pipeline row.
 *
 * For each shot in the shoot:
 *   1. Resolves theme via shared `loadThemeChain` (person → org → system).
 *   2. Loads drone_custom_pins (manual + AI POIs, mig 268 unified model)
 *      AT RENDER TIME — this is what makes Pin Editor edits land in the
 *      delivered renders without any explicit hand-off.
 *   3. Resolves boundary: drone_property_boundary row (operator polygon +
 *      overrides) when present, else falls back to drone-cadastral. The
 *      Boundary Editor (S5) writes drone_property_boundary on save and the
 *      cascade re-runs this function so the operator polygon takes effect
 *      across the project's edited renders.
 *   4. Fetches POIs (drone-pois) inline only when the unified custom_pins
 *      table doesn't already carry the AI pin set for this project.
 *   5. Downloads source image from Dropbox — ALWAYS shot.edited_dropbox_path
 *      (the post-production-edited JPG). Hard-fail with skipped_no_edit
 *      when NULL so the dispatcher's deferred path can short-circuit.
 *   6. Calls Modal render worker via shared callModalRender helper.
 *   7. Uploads rendered output to drones_editors_ai_proposed_enriched/
 *      (the swimlane's Adjustments lane reads from this folder via the
 *      pipeline='edited' + column_state filter on drone_renders).
 *   8. Inserts drone_renders row with pipeline='edited' (explicit) and
 *      column_state per request (defaults to 'pool' for fresh editor
 *      delivery; 'adjustments' for Pin Editor / Boundary Editor cascades).
 *
 * CASCADE FAN-OUT (architect plan B.2 — absorbs from drone-pins-save):
 *   When called with `payload.cascade=true` (project-wide world-pin or
 *   boundary edit), this function fans out per-shot drone_jobs of
 *   kind='render_edited' rather than rendering inline. Each fan-out row
 *   targets a single shot in the project that has edited_dropbox_path
 *   set; shots without an editor-delivered file are skipped at fan-out
 *   time (we know they'd defer anyway). The partial unique index from
 *   migration 282 (shoot_id, COALESCE(pipeline,'raw')) deduplicates
 *   repeated invocations via INSERT ... ON CONFLICT DO NOTHING.
 *
 * Inputs:
 *   POST { shoot_id }                 → render every eligible shot in the shoot
 *   POST { shoot_id, shot_id }        → render one specific shot
 *   POST { shot_id }                  → look up shoot via the shot row
 *   POST { kind }                     → 'poi' | 'boundary' | 'poi_plus_boundary'
 *                                       (default: 'poi_plus_boundary')
 *   POST { wipe_existing }            → wipe pipeline='edited' + column_state='pool'
 *                                       rows BEFORE rendering (cascade default true)
 *   POST { column_state }             → caller-requested initial column_state
 *                                       (must be one of pool|adjustments|final|rejected)
 *   POST { cascade: true,             → project-scope fan-out (absorbed from
 *          project_id }                  drone-pins-save & boundary save trigger)
 *   POST { reason }                   → informational (pin_edit_cascade_edited,
 *                                       pin_edit_saved compat, boundary_edit_cascade,
 *                                       render_continuation, ...)
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
import { updateShootStatus } from "../_shared/droneShootStatus.ts";

const GENERATOR = "drone-render-edited";

/**
 * Wave 5 P2 (S3): the only pipeline this function handles. Stamped on every
 * drone_renders insert and on every continuation drone_jobs payload.
 */
const PIPELINE: 'edited' = 'edited';

/**
 * Edited-pipeline column_state lanes (mig 282 CHECK).
 *   pool        — fresh editor delivery (dropbox-webhook chain default).
 *   adjustments — Pin Editor / Boundary Editor cascade target.
 *   final       — operator-locked deliverable.
 *   rejected    — operator-rejected (un-rejectable, never delivered).
 */
const EDITED_COLUMN_STATES = ['pool', 'adjustments', 'final', 'rejected'] as const;
type EditedColumnState = typeof EDITED_COLUMN_STATES[number];

/**
 * Reasons that flip the default column_state from 'pool' to 'adjustments'.
 * Mirrors the cascade triggers documented in the architect plan:
 *   - pin_edit_cascade_edited: world-pin edit cascade (S4 enqueues this)
 *   - pin_edit_saved:          legacy alias from pre-S3 drone-pins-save
 *                              (kept for back-compat with in-flight rows)
 *   - boundary_edit_cascade:   drone-job-dispatcher emits this when the
 *                              kind='boundary_save_render_cascade' job fires
 */
const ADJUSTMENTS_REASONS = new Set<string>([
  'pin_edit_cascade_edited',
  'pin_edit_saved',
  'boundary_edit_cascade',
  'boundary_save_render_cascade',
]);

/** Cap per-invocation to keep Edge Function under wall-clock budget. */
const PER_INVOCATION_CAP = 4;

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
    project_id?: string;
    kind?: RenderKind;
    /**
     * Caller-requested column_state for the resulting drone_renders row.
     * Edited pipeline only — must be one of ('pool','adjustments','final',
     * 'rejected'). Defaults: 'adjustments' for cascade-triggered reasons
     * (pin_edit / boundary_edit); 'pool' for fresh editor delivery.
     */
    column_state?: EditedColumnState;
    /**
     * When true, DELETE existing pipeline='edited' AND column_state='pool'
     * renders for the targeted shots BEFORE rendering. Cascade fan-outs
     * default this to true so the per-shot render starts from a clean
     * slate. The 'adjustments' / 'final' / 'rejected' lanes are NEVER
     * wiped — operator-locked by definition.
     */
    wipe_existing?: boolean;
    /**
     * Pipeline routing field — when present MUST equal 'edited'. Wave 5
     * P2: this function rejects pipeline='raw' with a 400 directing the
     * caller to drone-render. Callers that don't set the field are
     * implicitly edited (the dispatcher always passes 'edited' via the
     * render_edited route).
     */
    pipeline?: 'raw' | 'edited';
    /**
     * Cascade flag (architect plan B.2). When true the function fans out
     * one drone_jobs row of kind='render_edited' per eligible shot in the
     * project rather than rendering inline. Combined with project_id and
     * (optionally) shoot_id NULL.
     */
    cascade?: boolean;
    /**
     * Cascade orchestration parent (Wave 10 S1, mig 302). When the
     * dispatcher routes a kind='boundary_save_render_cascade' or a
     * kind='render_edited' (cascade=true) row through to this function,
     * it passes the orchestration row's id here so we can stamp it on
     * each per-shot fan-out child via drone_jobs.parent_job_id. The
     * mig 302 trigger then rolls children status into the parent's
     * children_summary + terminal_status. Optional for back-compat with
     * direct invocations; warning-logged if missing on a cascade.
     */
    parent_job_id?: string;
    /** Informational reason — drives column_state default + audit payload. */
    reason?: string;
    _health_check?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: "v1.0-edited", _fn: GENERATOR }, 200, req);
  }

  // ── PIPELINE GUARD (Wave 5 P2 S3) ────────────────────────────────
  // drone-render-edited owns the EDITED pipeline only. Any explicit raw
  // request is rejected at the door so no row can be misrouted.
  if (body.pipeline === 'raw') {
    return errorResponse(
      "drone-render-edited handles edited pipeline only. Use drone-render for the raw pipeline.",
      400,
      req,
    );
  }
  if (body.column_state && !EDITED_COLUMN_STATES.includes(body.column_state)) {
    return errorResponse(
      `column_state '${body.column_state}' not allowed on edited pipeline (allowed: ${EDITED_COLUMN_STATES.join(', ')}).`,
      400,
      req,
    );
  }

  if (!RENDER_TOKEN) {
    return errorResponse(
      "FLEXSTUDIOS_RENDER_TOKEN secret not set; render bridge unavailable",
      500,
      req,
    );
  }

  // ── Resolve render kind ───────────────────────────────────────────
  const kindResolved = resolveRenderKind(body.kind as string | undefined);
  if (kindResolved.error) {
    return errorResponse(kindResolved.error, 400, req);
  }
  const kind = kindResolved.kind!;

  const admin = getAdminClient();

  // ── CASCADE FAN-OUT branch (architect B.2) ────────────────────────
  // When cascade=true we don't render inline; we enqueue one
  // drone_jobs(kind='render_edited', cascade=false) per eligible shot. The
  // dispatcher then claims each row in turn and re-enters this function
  // on the per-shot path below. ON CONFLICT DO NOTHING is provided by the
  // partial unique index from mig 282 (shoot_id, pipeline) — so two
  // overlapping cascades (e.g. boundary save + pin edit on the same beat)
  // don't double-enqueue per shoot.
  if (body.cascade === true) {
    const projectId = body.project_id;
    const shootIdScope = body.shoot_id || null;
    if (!projectId) {
      return errorResponse("cascade=true requires project_id", 400, req);
    }

    // ── W10-S1: cascade orchestration parent (mig 302) ──────────────
    // The dispatcher hands us body.parent_job_id when it routes a
    // boundary_save_render_cascade / render_edited(cascade=true) job
    // through. We stamp it on each fan-out child below so the mig 302
    // trigger can roll children status into parent.children_summary +
    // parent.terminal_status. Missing parent_job_id is back-compat with
    // direct callers — log a warning so it's visible if the dispatcher
    // somehow stops sending it.
    const parentJobId = body.parent_job_id || null;
    if (!parentJobId) {
      console.warn(
        `[${GENERATOR}] cascade fan-out without parent_job_id — orchestration roll-up disabled (project=${projectId} reason=${body.reason || '(none)'})`,
      );
    }

    // Resolve eligible shots: every shot in the project with
    // edited_dropbox_path NOT NULL. (Shots without an edited file would
    // defer in the dispatcher; we save the round-trip by skipping them
    // at fan-out time.)
    let shotQ = admin
      .from("drone_shots")
      .select("id, shoot_id, drone_shoots!inner(project_id, id)")
      .eq("drone_shoots.project_id", projectId)
      .not("edited_dropbox_path", "is", null);
    if (shootIdScope) {
      shotQ = shotQ.eq("shoot_id", shootIdScope);
    }
    const { data: cascadeShots, error: cascadeErr } = await shotQ;
    if (cascadeErr) {
      return errorResponse(`cascade shot lookup failed: ${cascadeErr.message}`, 500, req);
    }
    const eligibleShots = (cascadeShots || []) as Array<{ id: string; shoot_id: string }>;

    const cascadeReason = body.reason || 'pin_edit_cascade_edited';
    const cascadeColumnState: EditedColumnState =
      body.column_state || (ADJUSTMENTS_REASONS.has(cascadeReason) ? 'adjustments' : 'pool');

    let enqueued = 0;
    let debounced = 0;
    let failedToEnqueue = 0;
    const enqueueErrors: Array<{ shot_id: string; message: string }> = [];
    const enqueuedShootIds = new Set<string>();
    const enqueuedJobIds: string[] = [];
    for (const shot of eligibleShots) {
      const { data: jobRow, error: jobErr } = await admin
        .from("drone_jobs")
        .insert({
          project_id: projectId,
          shoot_id: shot.shoot_id,
          shot_id: shot.id, // Wave 11 S2 Cluster D — surface per-shot identity at top level for joins/audit
          kind: "render_edited",
          status: "pending",
          pipeline: PIPELINE,
          // W10-S1: link child to orchestration parent (mig 302). Trigger
          // trg_drone_jobs_refresh_parent_ins fires on this INSERT and
          // refreshes parent.children_summary + parent.terminal_status.
          ...(parentJobId ? { parent_job_id: parentJobId } : {}),
          payload: {
            shoot_id: shot.shoot_id,
            shot_id: shot.id,
            reason: cascadeReason,
            cascade: false,
            pipeline: PIPELINE,
            wipe_existing: true,
            column_state: cascadeColumnState,
            // Mirror parent_job_id in payload too for downstream visibility
            // (e.g. ad-hoc queries against payload, log lines that don't
            // join to drone_jobs).
            ...(parentJobId ? { parent_job_id: parentJobId } : {}),
          },
        })
        .select("id")
        .maybeSingle();
      if (jobErr) {
        const code = (jobErr as { code?: string }).code;
        if (code === '23505') {
          // 23505 = unique_violation against mig 282's
          // idx_drone_jobs_unique_pending_render(shoot_id,
          // COALESCE(pipeline,'raw')). A pending edited render for this
          // shoot already exists — treat as debounced success.
          debounced += 1;
          enqueuedShootIds.add(shot.shoot_id);
        } else {
          // W8 FIX 5 (P1, W6-A2): non-23505 enqueue failures used to be
          // logged-and-forgotten while the orchestration row went on to
          // status='succeeded' — making telemetry lie about partial
          // failures. Track them in the result so monitoring can flag
          // cascades where fan-out is lossy. (Future Wave 9 will move to
          // a proper waiting_children orchestration; for this sprint we
          // surface the metadata and document the limitation.)
          failedToEnqueue += 1;
          enqueueErrors.push({ shot_id: shot.id, message: jobErr.message });
          console.warn(
            `[${GENERATOR}] cascade enqueue failed for shot ${shot.id} (non-fatal): ${jobErr.message}`,
          );
        }
        continue;
      }
      if (jobRow) {
        enqueued += 1;
        enqueuedShootIds.add(shot.shoot_id);
        if (jobRow.id) enqueuedJobIds.push(jobRow.id as string);
      }
    }

    // ── W10-S1: write baseline children_summary on the parent ────────
    // The mig 302 trigger fires per-INSERT so by the time we get here
    // the parent's children_summary already reflects the most recent
    // child insert. But: (1) the trigger uses COUNT(*) over the entire
    // child set so it's authoritative regardless of ordering; (2) for
    // the zero-children case (no eligible shots) the trigger never
    // fires, so we must set terminal_status='succeeded' manually here
    // so the orchestration row doesn't sit forever in NULL state.
    //
    // We always write a snapshot post-loop so the values are correct
    // even if the trigger is somehow disabled (defensive). insertedCount
    // is enqueued + debounced (debounced rows already exist as pending
    // children of THIS or a prior cascade — for the parent_job_id
    // contract a 23505 means the row is already linked to a different
    // parent, which is pre-existing behaviour and not something we can
    // fix here without breaking the dedup invariant).
    if (parentJobId) {
      const insertedCount = enqueued; // freshly-inserted children of THIS parent
      const nowIso = new Date().toISOString();
      const baselineSummary = {
        total: insertedCount,
        pending: insertedCount,
        running: 0,
        succeeded: 0,
        failed: 0,
        dead_letter: 0,
        last_updated_at: nowIso,
        last_child_finished_at: null,
      };
      // terminal_status: 'in_progress' if we enqueued any children;
      // 'succeeded' (graceful no-op) if zero children to avoid the
      // orchestration row sitting forever in NULL state.
      const baselineTerminal = insertedCount > 0 ? 'in_progress' : 'succeeded';
      const { error: parentUpdErr } = await admin
        .from("drone_jobs")
        .update({
          children_summary: baselineSummary,
          terminal_status: baselineTerminal,
        })
        .eq("id", parentJobId);
      if (parentUpdErr) {
        console.warn(
          `[${GENERATOR}] baseline children_summary update on parent ${parentJobId} failed (non-fatal): ${parentUpdErr.message}`,
        );
      }
    }

    return jsonResponse(
      {
        success: true,
        cascade: true,
        pipeline: PIPELINE,
        project_id: projectId,
        shoot_id: shootIdScope,
        reason: cascadeReason,
        column_state: cascadeColumnState,
        // W10-S1: surface parent linkage in the response for telemetry.
        parent_job_id: parentJobId,
        cascaded_shoot_count: enqueuedShootIds.size,
        enqueued,
        debounced,
        eligible_shot_count: eligibleShots.length,
        // W8 FIX 5: cascade orchestration telemetry. The orchestration row
        // continues to be marked 'succeeded' once fan-out completes (which
        // is operationally correct — the orchestrator's job is to enqueue
        // children, not to wait for them). But monitoring needs visibility
        // into whether the fan-out itself was clean. fan_out_failed counts
        // children that hit a non-23505 enqueue error; fan_out_summary
        // gives a one-line health stamp. W10-S1: superseded for cascade
        // orchestration by parent.children_summary roll-up (mig 302) but
        // kept here for back-compat with existing dashboards.
        fan_out_count: enqueued + debounced,
        fan_out_failed: failedToEnqueue,
        fan_out_errors: enqueueErrors.slice(0, 20),
        fan_out_summary: `enqueued=${enqueued} debounced=${debounced} failed=${failedToEnqueue} eligible=${eligibleShots.length}`,
        fan_out_job_ids: enqueuedJobIds.slice(0, 50),
      },
      200,
      req,
    );
  }

  // ── Per-shoot / per-shot render path ─────────────────────────────
  // Resolve shoot_id: caller passes shoot_id directly, OR shot_id (we
  // look up the shoot via drone_shots).
  let shootId = body.shoot_id;
  if (!shootId && body.shot_id) {
    const { data: shotRow, error: shotErr } = await admin
      .from("drone_shots")
      .select("shoot_id")
      .eq("id", body.shot_id)
      .maybeSingle();
    if (shotErr) {
      return errorResponse(`shot lookup failed: ${shotErr.message}`, 500, req);
    }
    if (!shotRow) {
      return errorResponse(`shot ${body.shot_id} not found`, 404, req);
    }
    shootId = (shotRow as { shoot_id: string }).shoot_id;
  }
  if (!shootId) {
    return errorResponse("shoot_id (or shot_id resolvable to a shoot) required", 400, req);
  }

  // ── Load shoot + project ─────────────────────────────────────────
  const { data: shoot, error: shootErr } = await admin
    .from("drone_shoots")
    .select("id, project_id, has_nadir_grid, status, image_count, theme_id, sfm_residual_median_m")
    .eq("id", shootId)
    .maybeSingle();
  if (shootErr) return errorResponse(`shoot lookup failed: ${shootErr.message}`, 500, req);
  if (!shoot) return errorResponse(`shoot ${shootId} not found`, 404, req);

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

  // ── Determine target column_state & wipe semantics ────────────────
  const reason = body.reason || '';
  const cascadeTriggeredColumnState: EditedColumnState = ADJUSTMENTS_REASONS.has(reason)
    ? 'adjustments'
    : 'pool';
  const initialColumnState: EditedColumnState =
    body.column_state ?? cascadeTriggeredColumnState;
  // Wipe defaults: when caller is a cascade-triggered render (reason set
  // and present in ADJUSTMENTS_REASONS) we default wipe_existing=true so
  // each per-shot render replaces the prior 'pool' lane row instead of
  // accumulating alongside it. Manual one-off renders default to false.
  const wipeRequested =
    body.wipe_existing !== undefined
      ? body.wipe_existing === true
      : ADJUSTMENTS_REASONS.has(reason);

  if (initialColumnState !== 'pool') {
    console.warn(
      `[${GENERATOR}] edited render writing column_state='${initialColumnState}' for shoot=${shoot.id} (reason='${reason || '(none)'}')`,
    );
  }

  // ── Load shots to render ─────────────────────────────────────────
  // Edited pipeline reads edited_dropbox_path; raw dropbox_path stays in
  // the SELECT only as a back-pointer for diagnostics on shots whose
  // editor file is NULL.
  let shotQ = admin
    .from("drone_shots")
    .select(
      "id, shoot_id, dropbox_path, edited_dropbox_path, filename, gps_lat, gps_lon, relative_altitude, flight_yaw, gimbal_pitch, gimbal_roll, flight_roll, shot_role, sfm_pose, registered_in_sfm",
    )
    .eq("shoot_id", shoot.id);
  if (body.shot_id) shotQ = shotQ.eq("id", body.shot_id);
  // Same role filter as raw side — nadir_grid stays SfM-only.
  shotQ = shotQ.in(
    "shot_role",
    ["nadir_hero", "orbital", "oblique_hero", "building_hero", "unclassified"],
  );

  const { data: shotsAll, error: shotsErr } = await shotQ;
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);
  if (!shotsAll || shotsAll.length === 0) {
    return errorResponse("no eligible shots found for shoot", 400, req);
  }

  // ── Optional wipe of prior renders for THIS pipeline ──────────────
  // wipe_existing=true wipes pipeline='edited' + column_state='pool' rows
  // only. Operator-locked lanes (adjustments/final/rejected) survive.
  if (wipeRequested === true) {
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

  // ── Skip shots with no editor-delivered file ─────────────────────
  // Hard-fail per shot when edited_dropbox_path is NULL — the dispatcher
  // observes shots_skipped_no_edit and defers the job rather than
  // marking it failed. This is the editor team's "owe us a file" signal.
  const shotsWithEdit = shotsAll.filter(
    (s) => typeof (s as { edited_dropbox_path?: string | null }).edited_dropbox_path === 'string'
      && (s as { edited_dropbox_path: string }).edited_dropbox_path.length > 0,
  );
  const shotsNoEdit = shotsAll.filter(
    (s) => !(typeof (s as { edited_dropbox_path?: string | null }).edited_dropbox_path === 'string'
      && (s as { edited_dropbox_path: string }).edited_dropbox_path.length > 0),
  );

  // Pre-build skipped_no_edit results so the dispatcher's deferred path
  // sees the right shape regardless of whether ALL shots were skipped or
  // only some.
  const skippedResults: RenderResult[] = shotsNoEdit.map((s) => ({
    shot_id: s.id,
    filename: (s as { filename: string }).filename,
    ok: false,
    skipped_no_edit: true,
    error: "shot.edited_dropbox_path is NULL — editor delivery pending",
  }));

  // If every eligible shot is skipped, return immediately so the
  // dispatcher's allFailedAreSkipped check fires and the job defers.
  if (shotsWithEdit.length === 0) {
    return jsonResponse(
      {
        success: false,
        skipped_no_edit: true,
        pipeline: PIPELINE,
        shoot_id: shoot.id,
        kind,
        shots_total: shotsAll.length,
        shots_rendered: 0,
        shots_failed_this_run: skippedResults.length,
        shots_skipped_no_edit: skippedResults.length,
        results: skippedResults,
      },
      200,
      req,
    );
  }

  // ── Skip shots already rendered into a non-pool lane ─────────────
  // If a shot already has an active edited render in adjustments/final/
  // rejected, don't auto-create another pool row alongside it (operator
  // will explicitly request via wipe_existing if they want to redo).
  // Pool itself was wiped above (when wipeRequested) so re-rendering into
  // pool is the default replace-behaviour.
  const { data: existingRenders } = await admin
    .from("drone_renders")
    .select("shot_id, column_state")
    .eq("kind", kind)
    .eq("pipeline", PIPELINE)
    .in("column_state", EDITED_COLUMN_STATES as readonly string[])
    .in("shot_id", shotsWithEdit.map((s) => s.id));
  const lockedShotIds = new Set(
    (existingRenders || [])
      .filter((r) => initialColumnState === r.column_state || r.column_state !== 'pool')
      // For the requested column_state, presence already means "skip"
      // (avoid 23505 on the active-per-variant unique index). For other
      // column_states, presence is an operator-locked row that survives.
      .map((r) => r.shot_id),
  );
  const shots = shotsWithEdit.filter((s) => !lockedShotIds.has(s.id));

  if (shots.length === 0) {
    return jsonResponse(
      {
        success: true,
        pipeline: PIPELINE,
        shoot_id: shoot.id,
        kind,
        shots_total: shotsAll.length,
        shots_rendered: 0,
        shots_already_rendered: shotsWithEdit.length,
        shots_skipped_no_edit: skippedResults.length,
        results: skippedResults,
      },
      200,
      req,
    );
  }

  // Cap per-invocation work; continuation enqueue picks up the rest.
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

  // ── Project coord (reused for scene + cadastral fallback) ────────
  const projectCoord = {
    lat: Number(project.confirmed_lat ?? project.geocoded_lat),
    lng: Number(project.confirmed_lng ?? project.geocoded_lng),
  };
  if (!Number.isFinite(projectCoord.lat) || !Number.isFinite(projectCoord.lng)) {
    return errorResponse("project has no usable coordinates (confirmed or geocoded)", 400, req);
  }

  // ── POIs (inline fetch only when unified table is empty) ─────────
  const haveAiPinsAlready = worldCustomPins.some((p) => p.source === 'ai');
  const themeRadius = Number((themeForKind as { poi_selection?: { radius_m?: number } })?.poi_selection?.radius_m);
  const radiusToUse = Number.isFinite(themeRadius) && themeRadius > 0 ? themeRadius : undefined;
  const themeQuotas = (themeForKind as { poi_selection?: { type_quotas?: Record<string, { priority?: number; max?: number }> | null } })?.poi_selection?.type_quotas ?? null;
  const poiSubcallTelemetry: PoisSubcallTelemetry = {};

  // ── Boundary resolution ──────────────────────────────────────────
  // Edited pipeline prefers the operator-edited drone_property_boundary
  // row when present (mig 283). Falls back to cadastral when absent or
  // when the row's source is 'cadastral' (i.e. operator hasn't touched).
  // Either way the scene receives a uniform polygon_latlon list.
  let boundaryRow: {
    source: 'cadastral' | 'operator';
    polygon_latlng: Array<{ lat: number; lng: number }> | null;
    side_measurements_enabled: boolean;
    side_measurements_overrides: Record<string, unknown> | null;
    sqm_total_enabled: boolean;
    sqm_total_position_offset_px: Record<string, unknown> | null;
    sqm_total_value_override: number | null;
    address_overlay_enabled: boolean;
    address_overlay_position_latlng: Record<string, unknown> | null;
    address_overlay_text_override: string | null;
    version: number;
  } | null = null;
  if (needsBoundary(kind)) {
    const { data: brow, error: bErr } = await admin
      .from("drone_property_boundary")
      .select(
        "source, polygon_latlng, side_measurements_enabled, side_measurements_overrides, sqm_total_enabled, sqm_total_position_offset_px, sqm_total_value_override, address_overlay_enabled, address_overlay_position_latlng, address_overlay_text_override, version",
      )
      .eq("project_id", project.id)
      .maybeSingle();
    if (bErr) {
      console.warn(`[${GENERATOR}] drone_property_boundary lookup failed (non-fatal): ${bErr.message}`);
    } else if (brow) {
      boundaryRow = brow as typeof boundaryRow;
    }
  }

  const [pois, cadastral] = await Promise.all([
    needsPois(kind) && !haveAiPinsAlready
      ? fetchPois(req, project.id, poiSubcallTelemetry, { radiusM: radiusToUse, typeQuotas: themeQuotas, pipeline: PIPELINE })
      : Promise.resolve([]),
    // Cadastral fallback only when there's no operator boundary row OR
    // the existing row is a stale cadastral snapshot we can refresh from.
    needsBoundary(kind) && (!boundaryRow || boundaryRow.source === 'cadastral')
      ? fetchCadastral(req, project.id)
      : Promise.resolve(null),
  ]);

  // Final polygon for the scene: operator polygon when available,
  // else cadastral. Boundary overrides (sqm/side measurements/address
  // overlay) are forwarded so the renderer can apply per-feature toggles.
  //
  // SHAPE NOTE (Wave 6 fix QC3-2 B1+B2):
  // drone-boundary-save writes drone_property_boundary.polygon_latlng as
  //   [[lat,lng], [lat,lng], ...]   (validatePolygon at line 145 enforces tuples)
  // BUT historical / fallback paths (cadastral.polygon, in-flight legacy
  // rows) carried the {lat,lng} object shape. The downstream Modal scene
  // expects polygon_latlon as [[num,num], ...] so we read defensively
  // accepting BOTH shapes and normalise downstream.
  // Type widened to `unknown[]` to admit either tuple or object element shape.
  const boundaryPolygon: Array<unknown> | null = boundaryRow?.polygon_latlng
    ? (boundaryRow.polygon_latlng as Array<unknown>)
    : cadastral && Array.isArray(cadastral.polygon)
      ? (cadastral.polygon as Array<unknown>)
      : null;
  const boundaryOverrides = boundaryRow
    ? {
        source: boundaryRow.source,
        side_measurements_enabled: boundaryRow.side_measurements_enabled,
        side_measurements_overrides: boundaryRow.side_measurements_overrides,
        sqm_total_enabled: boundaryRow.sqm_total_enabled,
        sqm_total_position_offset_px: boundaryRow.sqm_total_position_offset_px,
        sqm_total_value_override: boundaryRow.sqm_total_value_override,
        address_overlay_enabled: boundaryRow.address_overlay_enabled,
        address_overlay_position_latlng: boundaryRow.address_overlay_position_latlng,
        address_overlay_text_override: boundaryRow.address_overlay_text_override,
      }
    : null;

  // ── Render-time snapshots (architect B.1) ────────────────────────
  // Wrapper key shape stays forward-compatible with a future migration
  // promoting these to dedicated columns.
  const renderTimeIso = new Date().toISOString();
  const poisSnapshot = pois && Array.isArray(pois) ? { fetched_at: renderTimeIso, count: pois.length, pois } : null;
  const boundarySnapshot = boundaryPolygon
    ? {
        fetched_at: renderTimeIso,
        source: boundaryRow?.source || 'cadastral',
        polygon: boundaryPolygon,
        version: boundaryRow?.version ?? null,
        overrides: boundaryOverrides,
      }
    : null;

  // ── Output folder ────────────────────────────────────────────────
  // Wave 5 P2: edited pipeline writes to drones_editors_ai_proposed_enriched.
  // The existing dormant kind becomes canonical for edited renders. Rows
  // in the swimlane's Adjustments lane read from this folder via the
  // pipeline='edited' + column_state filter on drone_renders.
  const outFolder = await getFolderPath(project.id, "drones_editors_ai_proposed_enriched");

  // ── Update shoot status to 'rendering' ───────────────────────────
  // W14-S3: routed through unified updateShootStatus helper for audit logs.
  await updateShootStatus(admin, shoot.id, "rendering", {
    generator: GENERATOR,
    reason: "render_start",
  }, {
    allowedFromStatuses: ["ingested", "sfm_complete", "rendering", "proposed_ready", "adjustments_ready", "render_failed"],
  });

  // ── Render each shot (concurrency 1 — see drone-render notes) ────
  const renderResults: RenderResult[] = [];
  const RENDER_CONCURRENCY = 1;

  const renderOneShot = async (shot: typeof shots[number]): Promise<RenderResult> => {
    try {
      const editedPath = (shot as { edited_dropbox_path: string }).edited_dropbox_path;

      const dlRes = await downloadFile(editedPath);
      if (!dlRes.ok) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: `Dropbox download failed: ${dlRes.status}`,
        };
      }
      const srcBytes = new Uint8Array(await dlRes.arrayBuffer());

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

      // POIs gated to ORBITAL role (Joseph 2026-04-25 Everton review).
      const poisAllowedForRole = shot.shot_role === 'orbital';
      if (poisAllowedForRole && pois && pois.length > 0) {
        scene.pois = normalisePoisForModal(pois);
      }
      if (boundaryPolygon) {
        // Defensive read — accept BOTH shapes:
        //   [[lat,lng], ...]    (drone-boundary-save canonical write shape)
        //   [{lat,lng}, ...]    (cadastral fallback / legacy rows)
        // Without this defensive read, an operator-saved boundary lands as
        // [[NaN, NaN], ...] in scene.polygon_latlon and Modal renders an
        // empty polygon (silent zero-vertex output).
        scene.polygon_latlon = boundaryPolygon
          .map((v: unknown): [number, number] | null => {
            if (Array.isArray(v) && v.length >= 2) {
              const lat = Number((v as unknown[])[0]);
              const lng = Number((v as unknown[])[1]);
              return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
            }
            if (v && typeof v === 'object') {
              const obj = v as { lat?: unknown; lng?: unknown };
              const lat = Number(obj.lat);
              const lng = Number(obj.lng);
              return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
            }
            return null;
          })
          .filter((p): p is [number, number] => p !== null);
        if (boundaryOverrides) {
          scene.boundary_overrides = boundaryOverrides;
        }
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

      const variantsCfg = Array.isArray((themeForKind as { output_variants?: unknown })?.output_variants)
        ? ((themeForKind as { output_variants: Array<Record<string, unknown>> }).output_variants)
        : [];
      const wantVariants = variantsCfg.length > 0;

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

          const themeIdForRow = themeChain[0]?.theme_id || null;
          const themeIdAtRender = themeChain[0]?.theme_id || null;
          const themeVersionAtRender = themeChain[0]?.version_int ?? null;
          const themeSnapshotBundle = themeIdForRow
            ? null
            : {
                theme: themeForKind,
                pois_snapshot: poisSnapshot,
                boundary_snapshot: boundarySnapshot,
                rendered_at: renderTimeIso,
              };
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

          // Per-variant audit event. Edited pipeline uses one of two
          // event_types: 'render_edited_pool' (fresh editor delivery)
          // or 'render_edited_adjustments' (Pin Editor / Boundary Editor
          // cascade). Operators distinguish the lanes via column_state.
          const eventType = initialColumnState === 'adjustments'
            ? 'render_edited_adjustments'
            : 'render_edited_pool';
          const { error: evErr } = await admin.from("drone_events").insert({
            project_id: project.id,
            shoot_id: shot.shoot_id,
            shot_id: shot.id,
            event_type: eventType,
            actor_type: isService ? "system" : "user",
            actor_id: isService ? null : user?.id,
            payload: {
              kind,
              pipeline: PIPELINE,
              dropbox_path: (uploadRes.path_display || uploadRes.path_lower),
              theme_chain_levels: themeChain.length,
              output_variant: v.name,
              column_state: initialColumnState,
              reason: reason || null,
              boundary_source: boundaryRow?.source || (cadastral ? 'cadastral' : null),
            },
          });
          if (evErr) {
            console.warn(`[${GENERATOR}] drone_events insert failed (non-fatal): ${evErr.message}`);
          }

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

  // Append the pre-computed skipped_no_edit results to the response so
  // the dispatcher's `allFailedAreSkipped` check can include them in the
  // failed_this_run denominator. Same treatment as drone-render.
  const allResults = [...renderResults, ...skippedResults];
  const successCount = renderResults.filter((r) => r.ok).length;

  // ── Continuation enqueue ─────────────────────────────────────────
  // When more eligible shots remain, enqueue a continuation render_edited
  // job. Mirrors drone-render's behaviour (architect QC2-1 #4): MUST
  // propagate pipeline + column_state + reason on the continuation
  // payload. wipe_existing intentionally NOT propagated — the wipe
  // already happened on this tick and re-wiping would race the rows we
  // just inserted.
  if (moreRemaining > 0) {
    const continuationPayload: Record<string, unknown> = {
      shoot_id: shoot.id,
      kind,
      pipeline: PIPELINE,
      reason: "render_continuation",
      // Keep the original cascade reason for audit trail.
      ...(reason ? { source_reason: reason } : {}),
    };
    if (body.column_state) continuationPayload.column_state = body.column_state;
    else if (initialColumnState !== 'pool') continuationPayload.column_state = initialColumnState;
    // QC iter 6 A: capture continuation enqueue error — silent failure here
    // strands the remaining shots indefinitely (no retry path).
    const { error: contErr } = await admin.from("drone_jobs").insert({
      project_id: project.id,
      shoot_id: shoot.id,
      kind: "render_edited",
      status: "pending",
      pipeline: PIPELINE,
      payload: continuationPayload,
      scheduled_for: new Date(Date.now() + 5_000).toISOString(),
    });
    if (contErr) {
      console.error(`[${GENERATOR}] continuation enqueue failed for shoot ${shoot.id} (${moreRemaining} shots stranded): ${contErr.message}`);
    }
  }

  // Update shoot status. Edited pipeline lands in 'adjustments_ready'
  // when the cascade target is the adjustments lane; otherwise
  // 'proposed_ready' (fresh editor delivery feels equivalent to the
  // raw-side proposed_ready terminus).
  // W14-S3: routed through unified updateShootStatus helper (centralises
  // the per-site console.warn that previously lived inline here).
  let nextStatus = shoot.status;
  if (moreRemaining === 0 && successCount > 0) {
    nextStatus = initialColumnState === 'adjustments' ? 'adjustments_ready' : 'proposed_ready';
  } else if (moreRemaining === 0 && successCount === 0) {
    nextStatus = 'render_failed';
  }
  await updateShootStatus(admin, shoot.id, nextStatus, {
    generator: GENERATOR,
    reason: "render_complete",
  });

  return jsonResponse(
    {
      success: true,
      pipeline: PIPELINE,
      shoot_id: shoot.id,
      kind,
      column_state: initialColumnState,
      reason: reason || null,
      shots_total: shotsAll.length,
      shots_rendered: successCount,
      shots_rendered_this_run: successCount,
      shots_already_rendered: shotsWithEdit.length - shots.length,
      shots_failed_this_run: shotsCapped.length - successCount + skippedResults.length,
      shots_skipped_no_edit: skippedResults.length,
      shots_remaining: moreRemaining,
      results: allResults,
    },
    200,
    req,
  );
});

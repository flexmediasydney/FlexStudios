/**
 * drone-render
 * ────────────
 * Renders annotated drone images for a shoot.
 *
 * For each shot in the shoot:
 *   1. Resolves theme via internal `themeResolver` lib (person → org → system)
 *   2. Fetches POIs (drone-pois) + cadastral polygon (drone-cadastral)
 *   3. Downloads source image from Dropbox
 *   4. Calls Modal render worker via HTTP endpoint with theme + scene
 *   5. Uploads rendered output to `06_ENRICHMENT/drone_renders_proposed/`
 *   6. Inserts `drone_renders` row with column_state='proposed'
 *
 * Inputs:
 *   POST { shoot_id }                 → render every shot in the shoot
 *   POST { shoot_id, shot_id }        → render one specific shot (re-render)
 *   POST { shoot_id, kind }           → 'poi' | 'boundary' | 'poi_plus_boundary'
 *                                       (default: 'poi_plus_boundary')
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
import { resolveFromChain, mergeConfigChain } from "../_shared/themeResolver.ts";

const GENERATOR = "drone-render";
const MODAL_RENDER_URL =
  Deno.env.get("MODAL_RENDER_URL") ||
  "https://joseph-89037--flexstudios-drone-render-render-http.modal.run";
const RENDER_TOKEN = Deno.env.get("FLEXSTUDIOS_RENDER_TOKEN") || "";

type RenderKind = "poi" | "boundary" | "poi_plus_boundary";

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
     * When true, allow the renderer to source from `drone_shots.dropbox_path`
     * (raw drone JPG) even when the shot has no `edited_dropbox_path` set.
     * Used by drone-raw-preview (which by design renders from raws to give the
     * operator a preview before the editor pass) and as an explicit safety
     * hatch for ad-hoc previews. Without this flag, non-`nadir_hero` shots
     * with NULL edited_dropbox_path are hard-failed because the post-prod
     * edited version is what gets enriched, not the raw.
     */
    allow_raw_source?: boolean;
    /**
     * Caller-requested column_state for the resulting drone_renders row.
     * Currently honoured values:
     *   - 'adjustments' → Pin-Editor save path (legacy `reason: pin_edit_saved`
     *                     also routes here). Output goes to drone_renders_adjusted/.
     *   - 'preview'     → drone-raw-preview path. Output goes to
     *                     Drones/Raws/Shortlist Proposed/Previews/, the row is
     *                     informational and excluded from the active-per-variant
     *                     uniqueness scope (migration 243).
     *   - undefined / 'proposed' → default; standard AI render lane.
     */
    column_state?: 'proposed' | 'adjustments' | 'preview';
    /**
     * When true, DELETE existing renders for this shoot in column_state
     * 'proposed' BEFORE rendering. Used by the swimlane Re-analyse action so
     * a fresh render run replaces the AI's prior proposals rather than piling
     * up alongside them. Adjustments / final / rejected rows are preserved —
     * we only wipe the proposed slot.
     */
    wipe_existing?: boolean;
    /** Pin-Editor flag — also routes to adjustments lane (legacy alias). */
    reason?: string;
    _health_check?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: "v1.0", _fn: GENERATOR }, 200, req);
  }

  if (!body.shoot_id) return errorResponse("shoot_id required", 400, req);
  if (!RENDER_TOKEN) {
    return errorResponse(
      "FLEXSTUDIOS_RENDER_TOKEN secret not set; render bridge unavailable",
      500,
      req,
    );
  }

  const kind: RenderKind = body.kind || "poi_plus_boundary";

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

  // ── Load shots to render ─────────────────────────────────────────
  let shotQ = admin
    .from("drone_shots")
    .select(
      "id, shoot_id, dropbox_path, edited_dropbox_path, filename, gps_lat, gps_lon, relative_altitude, flight_yaw, gimbal_pitch, gimbal_roll, flight_roll, shot_role, sfm_pose, registered_in_sfm",
    )
    .eq("shoot_id", shoot.id);
  if (body.shot_id) shotQ = shotQ.eq("id", body.shot_id);
  // Render eligibility:
  //   - nadir_hero, orbital, oblique_hero, building_hero, unclassified → delivered
  //   - nadir_grid                                                     → SfM-only, NOT delivered
  //   - ground_level                                                   → projection math
  //                                                                      doesn't fit horizontal
  //                                                                      cameras well
  // The nadir grid was historically rendered as deliverable too, but operators
  // never wanted 26 near-identical top-down shots in the swimlane — for unit
  // blocks they want zero top-downs, for houses they want at most one MLS hero
  // shot. nadir_hero (an isolated single nadir, distinguished from sequential
  // grid bursts by the refineNadirClassifications post-pass) IS delivered:
  // it's the MLS hero shot operators expect. (2026-04-25)
  shotQ = shotQ.in(
    "shot_role",
    ["nadir_hero", "orbital", "oblique_hero", "building_hero", "unclassified"],
  );

  const { data: shotsAll, error: shotsErr } = await shotQ;
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);
  if (!shotsAll || shotsAll.length === 0) {
    return errorResponse("no eligible shots found for shoot", 400, req);
  }

  // ── Per-shot source resolution ──────────────────────────────────
  // The post-edit workflow: editors drop polished JPGs in
  // Drones/Editors/Edited Post Production/, the dropbox-webhook links them
  // to drone_shots.edited_dropbox_path, and the renderer pulls THAT for the
  // delivered roles. Source-resolution rules (applied per-shot, not per-batch):
  //
  //   - shot_role='nadir_grid' OR 'nadir_hero'              → always use shot.dropbox_path
  //     (nadir_grid is SfM-only and never edited; nadir_hero may not have an
  //     editor pass either — operators sometimes deliver the raw MLS top-down)
  //   - everything else (orbital/oblique_hero/building_hero/unclassified) →
  //     prefer shot.edited_dropbox_path. If NULL → SKIP the shot (add to
  //     errors[]) and KEEP rendering the others. Don't fail the whole batch.
  //
  // Override flags (bypass the edited-path requirement entirely):
  //   - body.allow_raw_source: true        → drone-raw-preview / ad-hoc
  //   - body.column_state === 'preview'     → Stream E preview pipeline
  //   - body.kind === 'preview'             → alt preview signal
  //
  // Previews always render from raws (they show operators what raws look like
  // PRE-editing). Both the new edited-path requirement and Stream E's preview
  // path coexist additively.
  const isPreviewRun =
    body?.column_state === "preview" ||
    (body as { kind?: string }).kind === "preview";
  const allowRawSource = body.allow_raw_source === true || isPreviewRun;

  function resolveSourcePath(
    shot: { id: string; filename: string; dropbox_path: string; edited_dropbox_path: string | null; shot_role: string },
  ): { path: string | null; error?: string } {
    if (allowRawSource) {
      return { path: shot.dropbox_path };
    }
    if (shot.shot_role === "nadir_grid" || shot.shot_role === "nadir_hero") {
      return { path: shot.dropbox_path };
    }
    if (shot.edited_dropbox_path) {
      return { path: shot.edited_dropbox_path };
    }
    return {
      path: null,
      error: `shot ${shot.id} (${shot.shot_role}) has no edited_dropbox_path — needs editor upload before render`,
    };
  }

  // ── Optional wipe of prior 'proposed' renders (Re-analyse action) ──
  // Stream D's swimlane Re-analyse calls drone-render with wipe_existing=true
  // so a fresh AI render replaces the prior proposals rather than colliding
  // with them. Adjustments/final/rejected slots are preserved — only the
  // 'proposed' lane is cleared, which lets the existing-renders pre-filter
  // below treat the shoot as if it had never been rendered.
  if (body.wipe_existing === true) {
    const shotIds = shotsAll.map((s) => s.id);
    const { error: wipeErr } = await admin
      .from("drone_renders")
      .delete()
      .eq("kind", kind)
      .eq("column_state", "proposed")
      .in("shot_id", shotIds);
    if (wipeErr) {
      return errorResponse(`wipe_existing failed: ${wipeErr.message}`, 500, req);
    }
  }

  // Skip shots that ALREADY have an active render row for this kind. The
  // unique partial index from migration 233 covers (shot_id,kind,variant,state)
  // so duplicates would 500 the insert anyway — pre-filter saves the work +
  // lets us split a 34-shot ingest across multiple Edge Function invocations
  // (each capped at 145s wall-clock).
  //
  // For preview lane: previews are excluded from the unique partial index so
  // they CAN stack — but we still skip shots that have a preview render to
  // make drone-raw-preview idempotent (the dispatcher chains it once after
  // SfM+poi_fetch; re-runs shouldn't re-render every shot). We pre-filter
  // against preview rows ONLY, ignoring proposed/adjustments/final since the
  // Edited Post Production source is different from the raw source used here.
  // Note: use isPreviewRun here directly. isPreviewRender (an alias for the
  // same value) is declared further down in the output-folder block.
  const skipStates = isPreviewRun
    ? ["preview"]
    : ["proposed", "adjustments", "final"];
  const { data: existingRenders } = await admin
    .from("drone_renders")
    .select("shot_id")
    .eq("kind", kind)
    .in("column_state", skipStates)
    .in("shot_id", shotsAll.map((s) => s.id));
  const alreadyRenderedSet = new Set((existingRenders || []).map((r) => r.shot_id));
  const shots = shotsAll.filter((s) => !alreadyRenderedSet.has(s.id));
  if (shots.length === 0) {
    return jsonResponse({
      success: true,
      shoot_id: shoot.id,
      kind,
      shots_total: shotsAll.length,
      shots_rendered: 0,
      shots_already_rendered: shotsAll.length,
      results: [],
    }, 200, req);
  }
  // Cap per-invocation work to avoid OOM. Each shot's source download (~10MB),
  // base64-encode (~13MB string), Modal request (~13MB body), Modal response
  // (~4MB for 2 variants), and upload buffers each occupy memory simultaneously
  // in flight. Even with concurrency=1, V8's GC can lag behind, so a hard cap
  // of 2 shots per invocation is the safest. Continuation jobs handle the rest.
  const PER_INVOCATION_CAP = 2;
  const shotsCapped = shots.slice(0, PER_INVOCATION_CAP);
  const moreRemaining = shots.length - shotsCapped.length;

  // ── Resolve theme via inheritance chain ──────────────────────────
  // loadThemeChain returns highest-priority first ([person, org, system]).
  // mergeConfigChain is a left-fold deep-merge where right wins, so we MUST
  // reverse to lowest-first ([system, org, person]) before merging — otherwise
  // the system default overrides every branded customisation. (#87 audit fix)
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

  const themeRadius = Number(themeForKind?.poi_selection?.radius_m);
  const radiusToUse = Number.isFinite(themeRadius) && themeRadius > 0 ? themeRadius : undefined;
  const [pois, cadastral] = await Promise.all([
    needsPois(kind) ? fetchPois(req, project.id, radiusToUse) : Promise.resolve([]),
    needsBoundary(kind) ? fetchCadastral(req, project.id) : Promise.resolve(null),
  ]);

  // ── Output folder path + initial column_state ─────────────────────
  // Three render lanes share this code path:
  //   - 'preview'     → drone-raw-preview pipeline. Sources from raw drone
  //                     JPGs (allow_raw_source=true), writes to
  //                     Drones/Raws/Shortlist Proposed/Previews/, row is
  //                     informational (excluded from the active-per-variant
  //                     uniqueness scope by migration 243).
  //   - 'adjustments' → Pin-Editor save (legacy alias: `reason='pin_edit_saved'`).
  //                     Writes to drone_renders_adjusted/ + adjustments lane.
  //   - 'proposed'    → default AI render after ingest. Writes to
  //                     drone_renders_proposed/.
  // Reuse `isPreviewRun` (defined above near source resolution) so we have a
  // single source of truth for "are we in the preview lane". `isPreviewRender`
  // is the local alias for the column-state slice of that decision.
  const isPreviewRender = isPreviewRun;
  const isAdjustedRender =
    !isPreviewRender &&
    (body?.reason === "pin_edit_saved" || body?.column_state === "adjustments");
  const outFolderKind = isPreviewRender
    ? "drones_raws_shortlist_proposed_previews"
    : isAdjustedRender
      ? "enrichment_drone_renders_adjusted"
      : "enrichment_drone_renders_proposed";
  const initialColumnState = isPreviewRender
    ? "preview"
    : isAdjustedRender
      ? "adjustments"
      : "proposed";
  const outFolder = await getFolderPath(project.id, outFolderKind);

  // ── Update shoot status to 'rendering' ───────────────────────────
  // Optimistic update — only flip if not already in a terminal state. Without
  // this, a render kicked off concurrently with an SfM job would clobber
  // status='sfm_running'. (#4 audit fix)
  // Preview renders skip the status flip — they're informational and
  // shouldn't move the production-lane shoot status.
  if (!isPreviewRender) {
    await admin
      .from("drone_shoots")
      .update({ status: "rendering" })
      .eq("id", shoot.id)
      .in("status", ["ingested", "sfm_complete", "rendering", "proposed_ready", "adjustments_ready", "render_failed"]);
  }

  // ── Render each shot in parallel chunks ──────────────────────────────
  // Modal has soft caps on concurrent worker invocations; 3 shots in flight
  // is conservative and keeps memory bounded for large nadir grids. Chunks
  // run sequentially to preserve result order. (#9 audit fix)
  type RenderResult = {
    shot_id: string;
    filename: string;
    ok: boolean;
    out_path?: string;
    error?: string;
    /**
     * True when the shot was skipped because it has no edited_dropbox_path
     * and the render context requires the edited source. Surfaced separately
     * from generic failures so the caller (UI / dispatcher) can distinguish
     * "editor team owes us a file" from "render genuinely failed".
     */
    skipped_no_edit?: boolean;
    variants?: Array<{ variant: string; out_path: string }>;
  };
  const renderResults: RenderResult[] = [];
  // Concurrency 1 — each shot's source download (~10-20MB) + base64 encode
  // (~25MB) + Modal response (~4MB for 2 variants) blows the Edge Function's
  // 256MB cap with concurrency >1. Sequential keeps peak memory bounded.
  // (Post-live-test refit of #9.)
  const RENDER_CONCURRENCY = 1;

  // Honour fallback='gps_only' from the dispatcher payload — when set, we
  // skip the per-shot SfM pose lookup and project everything via GPS-only
  // (the existing render path already does this since we don't pass sfm_pose
  // to Modal in this function; the flag is a future-proof signal that this
  // shoot should never block on SfM availability). (#16 audit fix)
  const fallbackGpsOnly = (body as { fallback?: string }).fallback === "gps_only";
  void fallbackGpsOnly; // currently informational; the per-shot loop below
  // does GPS-only projection in all cases (sfm_pose is loaded but unused
  // pending Stream-Z drone-render SfM-aware projection).

  // Single-shot render fn (closes over scene/theme deps).
  const renderOneShot = async (shot: typeof shots[number]): Promise<RenderResult> => {
    try {
      // Resolve source path per shot — see resolveSourcePath comment.
      // For preview / nadir / explicit-raw flows: shot.dropbox_path.
      // For everything else: shot.edited_dropbox_path; SKIP if NULL.
      const srcResolved = resolveSourcePath(shot);
      if (!srcResolved.path) {
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: srcResolved.error || "no source path resolved",
          skipped_no_edit: true,
        };
      }

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

      // Build scene. Skip shots whose GPS is missing/unparseable — Number(null)
      // is NaN, which would silently cascade through to Modal and produce a
      // visually-broken render with POIs landing at frame center. (#B4 audit fix)
      // Also skip shots with missing relative_altitude — we no longer fall back
      // to gps_altitude (MSL ≠ AGL) so a missing AGL means the projection math
      // can't run reliably. (#18 audit fix)
      const scene: Record<string, unknown> = {
        lat: Number(shot.gps_lat),
        lon: Number(shot.gps_lon),
        alt: Number(shot.relative_altitude),
        yaw: Number(shot.flight_yaw),
        pitch: Number(shot.gimbal_pitch),
        property_lat: projectCoord.lat,
        property_lon: projectCoord.lng,
        address: [project.property_address, project.property_suburb].filter(Boolean).join(", "),
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
      if (pois && pois.length > 0) scene.pois = pois;
      if (cadastral && Array.isArray(cadastral.polygon)) {
        scene.polygon_latlon = cadastral.polygon.map((v: { lat: number; lng: number }) => [v.lat, v.lng]);
      }

      // Determine if this theme requested multi-variant output
      const variantsCfg = Array.isArray(themeForKind?.output_variants)
        ? (themeForKind.output_variants as Array<Record<string, unknown>>)
        : [];
      const wantVariants = variantsCfg.length > 0;

      // POST to Modal HTTP endpoint. RENDER_TOKEN is sent as a Bearer header to
      // avoid leaking it through Modal's request-body error logs. The body field
      // (_token) is retained for backward compat with the deployed Modal worker.
      // TODO: drop the body _token field once the Modal render_http endpoint
      // accepts header-only auth. (#7 audit fix)
      const modalResp = await fetch(MODAL_RENDER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RENDER_TOKEN}`,
        },
        body: JSON.stringify({
          _token: RENDER_TOKEN,
          image_b64: base64Encode(srcBytes),
          theme: themeForKind,
          scene,
          variants: wantVariants,
        }),
      });

      if (!modalResp.ok) {
        const errText = await modalResp.text().catch(() => "");
        return {
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: `Modal returned ${modalResp.status}: ${errText.slice(0, 200)}`,
        };
      }
      const modalJson = await modalResp.json();

      // Build a uniform list of {name, bytes, format} regardless of single/multi.
      type Variant = { name: string; bytes: Uint8Array; format: string };
      const variants: Variant[] = [];
      if (modalJson.variants && typeof modalJson.variants === "object") {
        for (const [name, v] of Object.entries(modalJson.variants as Record<string, any>)) {
          if (v?.image_b64) {
            variants.push({
              name,
              bytes: base64Decode(v.image_b64),
              format: (v.format || "JPEG").toUpperCase(),
            });
          }
        }
      }
      if (variants.length === 0 && modalJson.image_b64) {
        variants.push({
          name: "default",
          bytes: base64Decode(modalJson.image_b64),
          format: (modalJson.format || "JPEG").toUpperCase(),
        });
      }
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
          if (!uploadRes || !uploadRes.path_lower) {
            anyVariantFailed = true;
            firstError = firstError || `Dropbox upload (${v.name}) returned no path`;
            continue;
          }

          // Theme persistence (#10 audit fix): when there's a real theme_id in
          // the chain, store the id + version pointer only — the snapshot can
          // be reproduced from drone_themes. Inline snapshot is reserved for
          // ad-hoc previews where there's no canonical theme to refer to.
          const themeIdForRow = themeChain[0]?.theme_id || null;
          const themeVersion = (themeForKind as { _version?: string | number } | null | undefined)
            ?._version ?? null;
          const renderRow: Record<string, unknown> = {
            shot_id: shot.id,
            column_state: initialColumnState,
            kind,
            dropbox_path: uploadRes.path_lower,
            theme_id: themeIdForRow,
            // Only inline-snapshot when we have no canonical theme to point at.
            theme_snapshot: themeIdForRow ? null : themeForKind,
            property_coord_used: {
              source: project.confirmed_lat ? "confirmed" : "geocoded",
              ...projectCoord,
            },
            pin_overrides: null,
            output_variant: v.name,
          };
          if (themeIdForRow && themeVersion !== null) {
            renderRow.theme_version = themeVersion;
          }
          const { error: insErr } = await admin.from("drone_renders").insert(renderRow);
          if (insErr) {
            anyVariantFailed = true;
            firstError = firstError || `drone_renders insert (${v.name}) failed: ${insErr.message}`;
            continue;
          }

          // Per-variant audit event. Use a distinct event_type per lane so
          // operators can filter the audit feed (preview renders are
          // informational; proposed/adjustments are operator-facing).
          const eventType = isPreviewRender
            ? "render_preview"
            : isAdjustedRender
              ? "render_adjusted"
              : "render_proposed";
          await admin.from("drone_events").insert({
            project_id: project.id,
            shoot_id: shot.shoot_id,
            shot_id: shot.id,
            event_type: eventType,
            actor_type: isService ? "system" : "user",
            actor_id: isService ? null : user?.id,
            payload: {
              kind,
              dropbox_path: uploadRes.path_lower,
              theme_chain_levels: themeChain.length,
              output_variant: v.name,
              column_state: initialColumnState,
            },
          });

          variantResults.push({ variant: v.name, out_path: uploadRes.path_lower });
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
        ...(variantResults.length > 1
          ? { variants: variantResults }
          : {}),
        ...(anyVariantFailed ? { error: firstError || undefined } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Structured per-shot error log so it's machine-greppable in the
      // function logs alongside other Edge Function output. (#11 audit fix)
      console.error(
        JSON.stringify({
          fn: GENERATOR,
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

  // If there are still unrendered shots, immediately re-enqueue another
  // render job so the dispatcher picks it up next tick. Without this, a
  // 34-shot shoot would only get 6 rendered before drone-render returned
  // 'success' and the operator would think the rest had failed.
  //
  // Preview lane: enqueue `kind='raw_preview_render'` so the continuation
  // re-enters via drone-raw-preview (which is itself idempotent — already-
  // rendered preview shots are skipped via the skipStates filter above). This
  // keeps the preview pipeline self-contained: we never promote a preview run
  // into the production proposed lane.
  if (moreRemaining > 0) {
    const continuationKind = isPreviewRender ? "raw_preview_render" : "render";
    const continuationPayload = isPreviewRender
      ? { shoot_id: shoot.id, reason: "raw_preview_continuation" }
      : { shoot_id: shoot.id, kind, reason: "render_continuation" };
    await admin.from("drone_jobs").insert({
      project_id: project.id,
      shoot_id: shoot.id,
      kind: continuationKind,
      status: "pending",
      payload: continuationPayload,
      scheduled_for: new Date(Date.now() + 5_000).toISOString(),
    });
  }

  // Update shoot status. Move to 'proposed_ready' only when ALL shots are done
  // (partial progress keeps it at 'rendering' so the UI shows a spinner).
  // Preview renders are informational — they don't drive shoot status (which
  // tracks the production-deliverable lane).
  if (!isPreviewRender) {
    let nextStatus = shoot.status;
    if (moreRemaining === 0 && successCount > 0) nextStatus = "proposed_ready";
    else if (moreRemaining === 0 && successCount === 0) nextStatus = "render_failed";
    // else leave at 'rendering' — there's still more to do

    await admin.from("drone_shoots").update({ status: nextStatus }).eq("id", shoot.id);
  }

  const skippedNoEditCount = renderResults.filter((r) => r.skipped_no_edit === true).length;

  return jsonResponse(
    {
      success: true,
      shoot_id: shoot.id,
      kind,
      shots_total: shotsAll.length,
      shots_rendered: successCount,
      shots_rendered_this_run: successCount,
      shots_already_rendered: shotsAll.length - shots.length,
      shots_failed_this_run: shotsCapped.length - successCount,
      shots_skipped_no_edit: skippedNoEditCount,
      shots_remaining: moreRemaining,
      results: renderResults,
    },
    200,
    req,
  );
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function needsPois(kind: RenderKind): boolean {
  return kind === "poi" || kind === "poi_plus_boundary";
}
function needsBoundary(kind: RenderKind): boolean {
  return kind === "boundary" || kind === "poi_plus_boundary";
}

function applyKindToTheme(theme: any, kind: RenderKind): any {
  // Defensive copy; tweak feature toggles per kind so the renderer doesn't
  // double-up. The render engine reads boundary.enabled and pois length.
  const t = JSON.parse(JSON.stringify(theme || {}));
  if (kind === "poi") {
    if (t.boundary) t.boundary.enabled = false;
  }
  if (kind === "boundary") {
    // keep boundary.enabled as is
    t.poi_selection = { ...(t.poi_selection || {}), max_pins_per_shot: 0 };
  }
  if (kind === "poi_plus_boundary") {
    if (t.boundary) t.boundary.enabled = true;
  }
  return t;
}

function filenameForRender(
  srcFilename: string,
  kind: RenderKind,
  variantName?: string,
  format?: string,
): string {
  // Strip extension, append _<kind>[__<variant>].<ext>
  const dot = srcFilename.lastIndexOf(".");
  const base = dot > 0 ? srcFilename.slice(0, dot) : srcFilename;
  const ext =
    (format || "JPEG").toUpperCase() === "PNG"
      ? "png"
      : (format || "JPEG").toUpperCase() === "TIFF"
        ? "tif"
        : "jpg";
  // Skip the variant suffix for the legacy "default" name to preserve
  // pre-variant filenames (no churn for existing renders).
  if (!variantName || variantName === "default") {
    return `${base}__${kind}.${ext}`;
  }
  return `${base}__${kind}__${variantName}.${ext}`;
}

async function loadThemeChain(
  admin: ReturnType<typeof getAdminClient>,
  ids: { person_id: string | null; organisation_id: string | null },
): Promise<Array<{ owner_kind: string; theme_id: string; config: any }>> {
  const chain: Array<{ owner_kind: string; theme_id: string; config: any }> = [];

  if (ids.person_id) {
    const { data } = await admin
      .from("drone_themes")
      .select("id, config")
      .eq("owner_kind", "person")
      .eq("owner_id", ids.person_id)
      .eq("is_default", true)
      .eq("status", "active")
      .maybeSingle();
    if (data) chain.push({ owner_kind: "person", theme_id: data.id, config: data.config });
  }
  if (ids.organisation_id) {
    const { data } = await admin
      .from("drone_themes")
      .select("id, config")
      .eq("owner_kind", "organisation")
      .eq("owner_id", ids.organisation_id)
      .eq("is_default", true)
      .eq("status", "active")
      .maybeSingle();
    if (data) chain.push({ owner_kind: "organisation", theme_id: data.id, config: data.config });
  }
  // Brand level: forward-compat (skip)

  // System default — always last
  const { data: sys } = await admin
    .from("drone_themes")
    .select("id, config")
    .eq("owner_kind", "system")
    .eq("is_default", true)
    .eq("status", "active")
    .maybeSingle();
  if (sys) chain.push({ owner_kind: "system", theme_id: sys.id, config: sys.config });

  return chain;
}

// TODO (#8 audit): when this function is called from the drone-job-dispatcher
// the forwarded Authorization header carries a service-role JWT. drone-pois /
// drone-cadastral both gate via getUserClient(req) which doesn't recognise the
// service-role principal → the sub-call returns 0 POIs / null cadastral and
// the chained render comes out blank. Fix is owned by the drone-pois /
// drone-cadastral team (Z2): they need to detect the service-role JWT and skip
// the per-user RLS check (e.g. accept ?internal=1 + service-role JWT). Until
// that lands, dispatcher-chained renders won't show POIs/boundary even when
// the data exists. Tracking: see audit finding #8.
async function fetchPois(req: Request, projectId: string, radiusM?: number): Promise<any[]> {
  const baseUrl = req.url.replace(/\/drone-render(\?.*)?$/, "/drone-pois");
  const auth = req.headers.get("Authorization");
  const r = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ project_id: projectId, ...(radiusM ? { radius_m: radiusM } : {}) }),
  });
  if (!r.ok) {
    console.warn(`drone-pois sub-call failed ${r.status}`);
    return [];
  }
  const j = await r.json().catch(() => ({}));
  return j.pois || [];
}

// TODO (#8 audit): same caveat as fetchPois — when invoked via the dispatcher's
// service-role JWT, drone-cadastral's getUserClient doesn't recognise the
// principal so we get null back. Fix is owned by drone-cadastral (Z2).
async function fetchCadastral(req: Request, projectId: string): Promise<any | null> {
  const baseUrl = req.url.replace(/\/drone-render(\?.*)?$/, "/drone-cadastral");
  const auth = req.headers.get("Authorization");
  const r = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!r.ok) {
    console.warn(`drone-cadastral sub-call failed ${r.status}`);
    return null;
  }
  const j = await r.json().catch(() => ({}));
  return j.success ? j : null;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[]);
  }
  return btoa(binary);
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

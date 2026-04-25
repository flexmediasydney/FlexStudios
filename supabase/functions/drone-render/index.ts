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

  let body: { shoot_id?: string; shot_id?: string; kind?: RenderKind; _health_check?: boolean } = {};
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
      "id, shoot_id, dropbox_path, filename, gps_lat, gps_lon, relative_altitude, flight_yaw, gimbal_pitch, gimbal_roll, flight_roll, shot_role, sfm_pose, registered_in_sfm",
    )
    .eq("shoot_id", shoot.id);
  if (body.shot_id) shotQ = shotQ.eq("id", body.shot_id);
  // Skip ground_level shots — projection math doesn't fit horizontal cameras well
  shotQ = shotQ.in("shot_role", ["nadir_grid", "orbital", "oblique_hero", "unclassified"]);

  const { data: shots, error: shotsErr } = await shotQ;
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);
  if (!shots || shots.length === 0) {
    return errorResponse("no eligible shots found for shoot", 400, req);
  }

  // ── Resolve theme via inheritance chain ──────────────────────────
  const themeChain = await loadThemeChain(admin, {
    person_id: project.primary_contact_person_id,
    organisation_id: project.agency_id,
  });
  const themeResolved = mergeConfigChain(themeChain.map((t) => t.config));
  const themeForKind = applyKindToTheme(themeResolved, kind);

  // ── Fetch POIs + cadastral via internal Edge Functions ───────────
  const projectCoord = {
    lat: Number(project.confirmed_lat ?? project.geocoded_lat),
    lng: Number(project.confirmed_lng ?? project.geocoded_lng),
  };
  if (!Number.isFinite(projectCoord.lat) || !Number.isFinite(projectCoord.lng)) {
    return errorResponse("project has no usable coordinates (confirmed or geocoded)", 400, req);
  }

  const [pois, cadastral] = await Promise.all([
    needsPois(kind) ? fetchPois(req, project.id) : Promise.resolve([]),
    needsBoundary(kind) ? fetchCadastral(req, project.id) : Promise.resolve(null),
  ]);

  // ── Output folder path ────────────────────────────────────────────
  const outFolder = await getFolderPath(project.id, "enrichment_drone_renders_proposed");

  // ── Update shoot status to 'rendering' ───────────────────────────
  await admin.from("drone_shoots").update({ status: "rendering" }).eq("id", shoot.id);

  // ── Render each shot in sequence (Modal handles concurrency upstream) ───
  const renderResults: Array<{
    shot_id: string;
    filename: string;
    ok: boolean;
    out_path?: string;
    error?: string;
  }> = [];

  for (const shot of shots) {
    try {
      // Download source image
      const dlRes = await downloadFile(shot.dropbox_path);
      if (!dlRes.ok) {
        renderResults.push({
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: `Dropbox download failed: ${dlRes.status}`,
        });
        continue;
      }
      const srcBytes = new Uint8Array(await dlRes.arrayBuffer());

      // Build scene
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
      if (pois && pois.length > 0) scene.pois = pois;
      if (cadastral && Array.isArray(cadastral.polygon)) {
        scene.polygon_latlon = cadastral.polygon.map((v: { lat: number; lng: number }) => [v.lat, v.lng]);
      }

      // POST to Modal HTTP endpoint
      const modalResp = await fetch(MODAL_RENDER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _token: RENDER_TOKEN,
          image_b64: base64Encode(srcBytes),
          theme: themeForKind,
          scene,
        }),
      });

      if (!modalResp.ok) {
        const errText = await modalResp.text().catch(() => "");
        renderResults.push({
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: `Modal returned ${modalResp.status}: ${errText.slice(0, 200)}`,
        });
        continue;
      }
      const modalJson = await modalResp.json();
      const outBytes = base64Decode(modalJson.image_b64);

      // Upload rendered output to Dropbox
      const outName = filenameForRender(shot.filename, kind);
      const outDropboxPath = `${outFolder}/${outName}`;
      const uploadRes = await uploadFile(outDropboxPath, outBytes, "overwrite");
      if (!uploadRes || !uploadRes.path_lower) {
        renderResults.push({
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: "Dropbox upload returned no path",
        });
        continue;
      }

      // Insert drone_renders row
      const { error: insErr } = await admin.from("drone_renders").insert({
        shot_id: shot.id,
        column_state: "proposed",
        kind,
        dropbox_path: uploadRes.path_lower,
        theme_id: themeChain[0]?.theme_id || null,
        theme_snapshot: themeForKind,
        property_coord_used: { source: project.confirmed_lat ? "confirmed" : "geocoded", ...projectCoord },
        pin_overrides: null,
        output_variant: "default",
      });
      if (insErr) {
        renderResults.push({
          shot_id: shot.id,
          filename: shot.filename,
          ok: false,
          error: `drone_renders insert failed: ${insErr.message}`,
        });
        continue;
      }

      // Audit
      await admin.from("drone_events").insert({
        project_id: project.id,
        shoot_id: shot.shoot_id,
        shot_id: shot.id,
        event_type: "render_proposed",
        actor_type: isService ? "system" : "user",
        actor_id: isService ? null : user?.id,
        payload: { kind, dropbox_path: uploadRes.path_lower, theme_chain_levels: themeChain.length },
      });

      renderResults.push({
        shot_id: shot.id,
        filename: shot.filename,
        ok: true,
        out_path: uploadRes.path_lower,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderResults.push({ shot_id: shot.id, filename: shot.filename, ok: false, error: msg });
    }
  }

  const successCount = renderResults.filter((r) => r.ok).length;

  // Update shoot status based on results
  let nextStatus = shoot.status;
  if (successCount === shots.length) nextStatus = "proposed_ready";
  else if (successCount > 0) nextStatus = "proposed_ready"; // partial success counts as ready
  else nextStatus = "rendering"; // total failure — leave as rendering for retry

  await admin.from("drone_shoots").update({ status: nextStatus }).eq("id", shoot.id);

  return jsonResponse(
    {
      success: true,
      shoot_id: shoot.id,
      kind,
      shots_total: shots.length,
      shots_rendered: successCount,
      shots_failed: shots.length - successCount,
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

function filenameForRender(srcFilename: string, kind: RenderKind): string {
  // Strip extension, append _render_<kind>.jpg
  const dot = srcFilename.lastIndexOf(".");
  const base = dot > 0 ? srcFilename.slice(0, dot) : srcFilename;
  return `${base}__${kind}.jpg`;
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

async function fetchPois(req: Request, projectId: string): Promise<any[]> {
  const baseUrl = req.url.replace(/\/drone-render(\?.*)?$/, "/drone-pois");
  const auth = req.headers.get("Authorization");
  const r = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!r.ok) {
    console.warn(`drone-pois sub-call failed ${r.status}`);
    return [];
  }
  const j = await r.json().catch(() => ({}));
  return j.pois || [];
}

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

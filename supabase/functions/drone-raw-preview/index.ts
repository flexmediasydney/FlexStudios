/**
 * drone-raw-preview
 * ─────────────────
 * Wave-2 drone curation — runs the same render engine against every
 * raw_proposed non-SfM shot in a shoot, outputs to
 *   /Drones/Raws/Shortlist Proposed/Previews/
 * (folder kind `drones_raws_shortlist_proposed_previews`), and runs the
 * smart-shortlist algorithm to flag the top picks as
 * `drone_shots.is_ai_recommended=true`. Output is INFORMATIONAL — never a
 * customer deliverable. Operators use the previews to triage which raws to
 * promote into Drones/Raws/Final Shortlist (a separate Lock action owned by
 * drone-shortlist-lock).
 *
 * POST { shoot_id }
 *
 * Auth: master_admin / admin / manager / employee. Contractors no.
 *       Service role (called by drone-job-dispatcher).
 *
 * Idempotent: skips shots that already have a preview render row in
 * drone_renders with column_state='preview' (migration 243). The smart
 * shortlist runs every invocation and overwrites is_ai_recommended for the
 * full eligible set so re-runs converge to the algorithm's current verdict.
 *
 * Render chain: drone-raw-preview internally enqueues kind='render' jobs
 * with column_state='preview' for each shot — actually no, it calls
 * drone-render directly with column_state='preview' so the render output
 * lands in the previews folder + the row is seeded with column_state='preview'
 * (which migration 243 added to the CHECK and excluded from the active-per-
 * variant uniqueness scope so they can stack freely).
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
import {
  pickAiShortlist,
  type ShortlistableShot,
} from "../_shared/droneShortlist.ts";

const GENERATOR = "drone-raw-preview";
const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") || "https://rjzdznwkxnzfekgcdkei.supabase.co";

// Shot roles eligible for delivery / preview rendering. Mirrors the whitelist
// in drone-render so the two functions agree on what counts as a "real"
// candidate. nadir_grid is excluded because it's SfM input only.
const PREVIEWABLE_ROLES = [
  "nadir_hero",
  "orbital",
  "oblique_hero",
  "building_hero",
  "unclassified",
];

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

  let body: { shoot_id?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: "v1.0", _fn: GENERATOR }, 200, req);
  }
  if (!body.shoot_id) return errorResponse("shoot_id required", 400, req);

  const admin = getAdminClient();

  // ── Load shoot + project ─────────────────────────────────────────
  const { data: shoot, error: shootErr } = await admin
    .from("drone_shoots")
    .select("id, project_id, status")
    .eq("id", body.shoot_id)
    .maybeSingle();
  if (shootErr) return errorResponse(`shoot lookup failed: ${shootErr.message}`, 500, req);
  if (!shoot) return errorResponse(`shoot ${body.shoot_id} not found`, 404, req);

  const { data: project, error: projErr } = await admin
    .from("projects")
    .select("id, property_address")
    .eq("id", shoot.project_id)
    .maybeSingle();
  if (projErr || !project)
    return errorResponse(
      `project lookup failed: ${projErr?.message || "missing"}`,
      500,
      req,
    );

  // ── Resolve previews folder (verify it's provisioned for this project) ──
  // Throws if missing — surfaces a clear error rather than letting the
  // downstream render call fail with a less obvious "no folder of kind X".
  try {
    await getFolderPath(project.id, "drones_raws_shortlist_proposed_previews");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(
      `previews folder not provisioned for project ${project.id}: ${msg}. ` +
        "Re-run createProjectFolders() to provision the new drone tree.",
      500,
      req,
    );
  }

  // ── Load eligible shots (raw_proposed AND deliverable role) ─────
  const { data: shots, error: shotsErr } = await admin
    .from("drone_shots")
    .select(
      "id, captured_at, gps_lat, gps_lon, flight_yaw, flight_roll, shot_role, lifecycle_state",
    )
    .eq("shoot_id", shoot.id)
    .eq("lifecycle_state", "raw_proposed")
    .in("shot_role", PREVIEWABLE_ROLES);
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);

  if (!shots || shots.length === 0) {
    return jsonResponse(
      {
        success: true,
        shoot_id: shoot.id,
        eligible_shots: 0,
        ai_recommended_count: 0,
        render_call: { dispatched: false, reason: "no eligible shots" },
      },
      200,
      req,
    );
  }

  // ── Run shortlist algorithm ─────────────────────────────────────
  const shortlistInput: ShortlistableShot[] = shots.map((s) => ({
    id: s.id,
    captured_at: s.captured_at,
    gps_lat: s.gps_lat === null ? null : Number(s.gps_lat),
    gps_lon: s.gps_lon === null ? null : Number(s.gps_lon),
    flight_yaw: s.flight_yaw === null ? null : Number(s.flight_yaw),
    flight_roll: s.flight_roll === null ? null : Number(s.flight_roll),
    shot_role: s.shot_role,
  }));
  const recommendedIds = pickAiShortlist(shortlistInput);

  // ── Bulk-update is_ai_recommended for the eligible set ──────────
  // Two updates so re-runs converge cleanly on the algorithm's current
  // verdict: clear the flag for the entire eligible set, then set it for the
  // recommended subset. Cheaper than diffing in-app, and atomic enough for a
  // single shoot (eligible counts are typically <50).
  const eligibleIds = shots.map((s) => s.id);
  const { error: clearErr } = await admin
    .from("drone_shots")
    .update({ is_ai_recommended: false })
    .in("id", eligibleIds);
  if (clearErr) {
    console.warn(
      `[${GENERATOR}] clear is_ai_recommended failed: ${clearErr.message} — continuing`,
    );
  }
  if (recommendedIds.length > 0) {
    const { error: setErr } = await admin
      .from("drone_shots")
      .update({ is_ai_recommended: true })
      .in("id", recommendedIds);
    if (setErr) {
      console.warn(
        `[${GENERATOR}] set is_ai_recommended failed: ${setErr.message} — render still proceeds`,
      );
    }
  }

  // ── Audit event for the shortlist decision ──────────────────────
  await admin.from("drone_events").insert({
    project_id: project.id,
    shoot_id: shoot.id,
    shot_id: null,
    event_type: "ai_shortlist_picked",
    actor_type: isService ? "system" : "user",
    actor_id: isService ? null : user?.id,
    payload: {
      eligible_shots: eligibleIds.length,
      recommended_count: recommendedIds.length,
      recommended_ids: recommendedIds,
    },
  });

  // ── Dispatch the render call ────────────────────────────────────
  // Call drone-render directly with column_state='preview' + allow_raw_source.
  // drone-render understands the preview lane (output folder, row state,
  // status flip suppression) — see the lane comment block in drone-render.
  // We forward the original Authorization header so the service-role JWT
  // (or the user's JWT, if invoked manually) propagates and drone-render's
  // auth check sees the same principal.
  const renderUrl = `${SUPABASE_URL}/functions/v1/drone-render`;
  const auth = req.headers.get("Authorization");
  const renderPayload = {
    shoot_id: shoot.id,
    kind: "poi_plus_boundary" as const,
    column_state: "preview" as const,
    allow_raw_source: true,
    reason: "raw_preview_render",
  };

  let renderStatus = 0;
  let renderBody: Record<string, unknown> | null = null;
  let renderError: string | null = null;
  try {
    const renderResp = await fetch(renderUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
        "x-caller-context": GENERATOR,
      },
      body: JSON.stringify(renderPayload),
    });
    renderStatus = renderResp.status;
    const txt = await renderResp.text().catch(() => "");
    if (txt.length > 0) {
      try {
        renderBody = JSON.parse(txt) as Record<string, unknown>;
      } catch {
        renderBody = { raw: txt.slice(0, 500) };
      }
    }
    if (!renderResp.ok) {
      renderError = `drone-render returned ${renderStatus}`;
    }
  } catch (err) {
    renderError = err instanceof Error ? err.message : String(err);
  }

  return jsonResponse(
    {
      success: renderError === null,
      shoot_id: shoot.id,
      eligible_shots: eligibleIds.length,
      ai_recommended_count: recommendedIds.length,
      ai_recommended_ids: recommendedIds,
      render_call: {
        dispatched: true,
        status: renderStatus,
        error: renderError,
        body: renderBody,
      },
    },
    renderError ? 502 : 200,
    req,
  );
});

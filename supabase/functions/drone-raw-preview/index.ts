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
 * IMPORTANT — AI never auto-promotes shots:
 *   The operator's lifecycle_state ('raw_proposed' on entry) is INTENTIONALLY
 *   left untouched. AI only sets the `is_ai_recommended` flag — accept/reject
 *   decisions remain a manual operator step. Any future change that flips
 *   lifecycle_state from this function would be a regression of the curate-
 *   then-edit-then-render workflow.
 *
 * POST { shoot_id }
 *
 * Auth: master_admin / admin / manager / employee. Contractors no.
 *       Service role (called by drone-job-dispatcher).
 *
 * Idempotent: skips shots that already have a preview render row in
 * drone_renders with column_state='pool' (post-mig-282; was 'preview' pre-
 * mig-282 — backfilled to 'pool' by that migration). The smart shortlist
 * runs every invocation and overwrites is_ai_recommended for the full
 * eligible set so re-runs converge to the algorithm's current verdict.
 *
 * Render chain: drone-raw-preview calls drone-render directly with
 * column_state='pool' + allow_raw_source=true so the render output lands
 * in the drones_raws_shortlist_proposed_previews/ folder and the row is
 * seeded with column_state='pool' (the post-mig-282 raw-pipeline starting
 * lane). Pre-mig-282 this was column_state='preview'; QC4 NB-1 caught the
 * stale value still being sent post-deploy → drone-render rejected with
 * 502 → entire raw render generation pipeline was dead.
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

  let body: { shoot_id?: string; parent_job_id?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: "v1.1-fanout", _fn: GENERATOR }, 200, req);
  }
  if (!body.shoot_id) return errorResponse("shoot_id required", 400, req);
  // W10-S2: parent_job_id is the dispatcher-passed id of the
  // raw_preview_render drone_jobs row that triggered this invocation. When
  // present, the per-shot child render jobs we fan out below are written
  // with parent_job_id=<this id> so the mig-302 trigger refreshes the
  // parent's children_summary as the children resolve. When absent
  // (manual / curl invocation), the fan-out still happens but children
  // are orphan-style (no parent linkage).
  const parentJobId = body.parent_job_id ?? null;

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

  const eligibleIds = shots.map((s) => s.id);

  // ── W10-S2 Change A: Pre-render skip-when-rendered ──────────────
  // Before doing any work (AI shortlist update OR render fan-out), check
  // whether every eligible shot already has an active raw render row. If
  // so, this invocation is a no-op — return early so retries / chained
  // re-fires don't re-flag is_ai_recommended unnecessarily and don't
  // create duplicate per-shot child render jobs.
  //
  // Match the same column_state set drone-render uses to skip duplicates:
  // pool/accepted/rejected covers every raw lane after mig 282.
  const { count: existingRenderCount } = await admin
    .from("drone_renders")
    .select("id", { count: "exact", head: true })
    .in("shot_id", eligibleIds)
    .eq("pipeline", "raw")
    .eq("kind", "poi_plus_boundary")
    .in("column_state", ["pool", "accepted", "rejected"]);

  const existingCount = existingRenderCount ?? 0;
  if (existingCount >= eligibleIds.length) {
    // All eligible shots already rendered — nothing to do.
    return jsonResponse(
      {
        success: true,
        shoot_id: shoot.id,
        already_rendered: existingCount,
        eligible_shots: eligibleIds.length,
        message: "all eligible shots already rendered — no work needed",
      },
      200,
      req,
    );
  }

  // ── W10-S2 Change B: Gated shortlist update ─────────────────────
  // Only run the shortlist algorithm + is_ai_recommended writes when there
  // is real rendering work to do. Without the gate, every retry / chained
  // re-fire would re-execute these mutations even when there is nothing
  // to render — wasteful, and risks racing against a manual operator
  // override of is_ai_recommended that happened between ticks.
  let recommendedIds: string[] = [];
  if (existingCount < eligibleIds.length) {
    // ── Run shortlist algorithm ───────────────────────────────────
    const shortlistInput: ShortlistableShot[] = shots.map((s) => ({
      id: s.id,
      captured_at: s.captured_at,
      gps_lat: s.gps_lat === null ? null : Number(s.gps_lat),
      gps_lon: s.gps_lon === null ? null : Number(s.gps_lon),
      flight_yaw: s.flight_yaw === null ? null : Number(s.flight_yaw),
      flight_roll: s.flight_roll === null ? null : Number(s.flight_roll),
      shot_role: s.shot_role,
    }));
    recommendedIds = pickAiShortlist(shortlistInput);

    // ── Bulk-update is_ai_recommended for the eligible set ────────
    // Two updates so re-runs converge cleanly on the algorithm's current
    // verdict: clear the flag for the entire eligible set, then set it for
    // the recommended subset. Cheaper than diffing in-app, and atomic enough
    // for a single shoot (eligible counts are typically <50).
    //
    // INVARIANT — DO NOT REGRESS: this function ONLY mutates is_ai_recommended.
    // The shot's lifecycle_state MUST remain 'raw_proposed' so the operator
    // explicitly triages each AI-flagged candidate via the Raw Proposed swimlane
    // (Accept moves to raw_accepted, Reject to rejected). Auto-promoting to
    // raw_accepted would skip the operator's curation step and silently
    // change which files end up in the deliverable Shortlist Final folder.
    // If a future revision needs to set lifecycle_state from this codepath,
    // it MUST be gated behind an explicit operator-confirmed flag.
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
    console.log(
      `[${GENERATOR}] flagged ${recommendedIds.length}/${eligibleIds.length} shots is_ai_recommended=true; lifecycle_state intentionally unchanged (operator must triage via Raw Proposed swimlane).`,
    );

    // ── Audit event for the shortlist decision ──────────────────
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
  }

  // ── W10-S2 Change C: Per-shot fan-out instead of batch render ───
  // Pre-W10 this function POSTed once to drone-render with the full shoot
  // and let drone-render iterate. That batched all per-shot Modal failures
  // into one drone_jobs row, hid partial-failure detail, and tied every
  // retry to a 145s wall-clock budget regardless of per-shot success.
  //
  // Now we identify the per-shot subset that still needs rendering, then
  // INSERT one kind='render' drone_jobs child row per shot with
  // parent_job_id=<this raw_preview_render row's id>. The dispatcher will
  // claim each child independently next tick(s), and the mig-302 trigger
  // refreshes the parent's children_summary so operators / telemetry see
  // accurate per-shot progress instead of the all-or-nothing outcome of
  // the prior batch.
  //
  // Identify the unrendered subset (eligible − already-rendered).
  const { data: existingRenderRows } = await admin
    .from("drone_renders")
    .select("shot_id")
    .in("shot_id", eligibleIds)
    .eq("pipeline", "raw")
    .eq("kind", "poi_plus_boundary")
    .in("column_state", ["pool", "accepted", "rejected"]);
  const renderedSet = new Set(
    (existingRenderRows ?? []).map((r) => r.shot_id as string),
  );
  const shotsNeedingRender = eligibleIds.filter((id) => !renderedSet.has(id));

  if (shotsNeedingRender.length === 0) {
    // Defensive — pre-skip-check above should have caught this, but keep
    // the explicit branch in case of a race between count() and select().
    return jsonResponse(
      {
        success: true,
        shoot_id: shoot.id,
        already_rendered: existingCount,
        eligible_shots: eligibleIds.length,
        fanned_out: 0,
        parent_job_id: parentJobId,
        ai_recommended_count: recommendedIds.length,
        message: "no shots needed render after recheck",
      },
      200,
      req,
    );
  }

  // Build the per-shot child rows. Each child is a drone_jobs row of
  // kind='render' with parent_job_id pointing at THIS raw_preview_render
  // job (when known via parent_job_id). The dispatcher's existing
  // 'render' case handles them with the same auth/abort/backoff envelope
  // as any other render dispatch — no special-casing needed downstream.
  const childRows = shotsNeedingRender.map((shotId) => ({
    project_id: project.id,
    shoot_id: shoot.id,
    shot_id: shotId, // W11-S2 Cluster D parity: top-level column for hot index + queryability
    kind: "render",
    status: "pending",
    pipeline: "raw" as const,
    parent_job_id: parentJobId,
    payload: {
      shoot_id: shoot.id,
      shot_id: shotId,
      kind: "poi_plus_boundary",
      pipeline: "raw",
      column_state: "pool",
      reason: "raw_preview_render_per_shot",
      allow_raw_source: true,
    },
    // Stagger so the dispatcher's MAX_JOBS_PER_RUN cap doesn't get
    // overwhelmed by a 30+-shot fan-out arriving at the same instant.
    scheduled_for: new Date(Date.now() + 5_000).toISOString(),
  }));

  const { error: childInsErr } = await admin.from("drone_jobs").insert(childRows);
  if (childInsErr) {
    return errorResponse(
      `failed to fan out per-shot render children: ${childInsErr.message}`,
      500,
      req,
    );
  }

  return jsonResponse(
    {
      success: true,
      shoot_id: shoot.id,
      eligible_shots: eligibleIds.length,
      already_rendered: existingCount,
      fanned_out: shotsNeedingRender.length,
      parent_job_id: parentJobId,
      ai_recommended_count: recommendedIds.length,
      ai_recommended_ids: recommendedIds,
      message: parentJobId
        ? `fanned out ${shotsNeedingRender.length} per-shot render children under parent ${parentJobId}`
        : `fanned out ${shotsNeedingRender.length} per-shot render children (no parent linkage — parent_job_id not provided)`,
    },
    200,
    req,
  );
});

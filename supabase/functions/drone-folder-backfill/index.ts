/**
 * drone-folder-backfill — one-shot drone-folder restructure migrator (2026-04)
 *
 * Migrates a project's drone files from the old Phase 1 layout to the new
 * operator-curation-aware tree:
 *
 *   01_RAW_WORKING/drones/*                       → Drones/Raws/Shortlist Proposed/*
 *   06_ENRICHMENT/drone_renders_proposed/*        → Drones/Editors/AI Proposed Enriched/*
 *   06_ENRICHMENT/drone_renders_adjusted/*        → Drones/Editors/AI Proposed Enriched/*
 *   07_FINAL_DELIVERY/drones/*                    → Drones/Finals/* (move) + Drones/Editors/Final Enriched/* (copy)
 *
 * Inserts the 9 new project_folders rows, rewrites dropbox_path on
 * drone_shots / drone_renders / project_folders, and audits each move.
 *
 * Body: { project_id?: string, dry_run?: boolean }
 *   - project_id omitted → process all in-flight projects (status NOT IN
 *     ('delivered','archived','cancelled'); confirmed status enum has no
 *     'archived'/'cancelled' yet but we exclude them for forward-compat).
 *   - dry_run=true → report planned moves, no Dropbox or DB writes.
 *
 * Idempotent — skips a project whose top-level Drones/ folder already exists
 * AND whose project_folders already include all 9 new kinds.
 *
 * Auth: master_admin only.
 *
 * Status: DRAFT — not deployed. Orchestrator will deploy + invoke separately.
 *
 * Reference: drone-migrate-paths/index.ts (similar Dropbox-move + DB-update
 * pattern from the /FlexMedia → /Flex Media Team Folder root migration).
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  handleCors,
  getCorsHeaders,
  jsonResponse,
  getAdminClient,
  getUserFromReq,
} from "../_shared/supabase.ts";
import {
  dropboxApi,
  createFolder,
  listFolder,
  copyFile,
  getMetadata,
} from "../_shared/dropbox.ts";

// Drone restructure new folder kinds + their relative paths under
// projects.dropbox_root_path. Mirrors NEW_PROJECT_FOLDER_KINDS in
// _shared/projectFolders.ts.
const NEW_DRONE_FOLDER_RELPATHS: Record<string, string> = {
  drones_raws_shortlist_proposed: "Drones/Raws/Shortlist Proposed",
  drones_raws_shortlist_proposed_previews: "Drones/Raws/Shortlist Proposed/Previews",
  drones_raws_final_shortlist: "Drones/Raws/Final Shortlist",
  drones_raws_rejected: "Drones/Raws/Rejected",
  drones_raws_others: "Drones/Raws/Others",
  drones_editors_edited_post_production: "Drones/Editors/Edited Post Production",
  drones_editors_ai_proposed_enriched: "Drones/Editors/AI Proposed Enriched",
  drones_editors_final_enriched: "Drones/Editors/Final Enriched",
  drones_finals: "Drones/Finals",
};

const NEW_DRONE_INTERMEDIATES = [
  "Drones",
  "Drones/Raws",
  "Drones/Raws/Shortlist Proposed",
  "Drones/Editors",
];

interface MovePlan {
  from: string;
  to: string;
  copy_to?: string; // for FINAL_DELIVERY which moves to Drones/Finals AND copies to Drones/Editors/Final Enriched
}

const ALLOWED_ROLES = new Set(["master_admin"]);

// Project statuses to EXCLUDE from "process all" mode. Active drone work can
// land in any other status; delivered projects don't need restructuring (they
// won't get new uploads), and the archived/cancelled values are forward-compat
// placeholders not currently in the enum.
const EXCLUDED_STATUSES = ["delivered", "archived", "cancelled"];

function err(msg: string, status: number, req: Request) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

async function dropboxFolderExists(path: string): Promise<boolean> {
  try {
    const meta = await getMetadata(path);
    return (meta as { ".tag"?: string })[".tag"] === "folder";
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("not_found")) return false;
    throw e;
  }
}

/**
 * Move many files via Dropbox /files/move_batch_v2. Returns the resolved
 * metadata list. Polls /files/move_batch/check_v2 if Dropbox returns async.
 */
async function moveBatch(
  entries: Array<{ from_path: string; to_path: string }>,
): Promise<{ moved: number; failed: Array<{ from: string; error: string }> }> {
  if (entries.length === 0) return { moved: 0, failed: [] };

  // Dropbox limits 1000 entries per move_batch_v2 call.
  const failed: Array<{ from: string; error: string }> = [];
  let moved = 0;

  for (let i = 0; i < entries.length; i += 1000) {
    const chunk = entries.slice(i, i + 1000);
    try {
      const res = await dropboxApi<{
        ".tag": string;
        async_job_id?: string;
        entries?: Array<{ ".tag": string; failure?: { ".tag": string } }>;
      }>("/files/move_batch_v2", {
        entries: chunk,
        autorename: false,
        allow_ownership_transfer: false,
      });

      if (res[".tag"] === "complete") {
        for (let j = 0; j < (res.entries?.length || 0); j++) {
          const r = res.entries![j];
          if (r[".tag"] === "success") moved++;
          else failed.push({ from: chunk[j].from_path, error: JSON.stringify(r) });
        }
      } else if (res[".tag"] === "async_job_id" && res.async_job_id) {
        const jobId = res.async_job_id;
        // Poll /files/move_batch/check_v2 until complete.
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          const check = await dropboxApi<{
            ".tag": string;
            entries?: Array<{ ".tag": string; failure?: { ".tag": string } }>;
          }>("/files/move_batch/check_v2", { async_job_id: jobId });
          if (check[".tag"] === "complete") {
            for (let j = 0; j < (check.entries?.length || 0); j++) {
              const r = check.entries![j];
              if (r[".tag"] === "success") moved++;
              else failed.push({ from: chunk[j].from_path, error: JSON.stringify(r) });
            }
            break;
          }
          if (check[".tag"] === "failed") {
            for (const e of chunk) failed.push({ from: e.from_path, error: "batch_failed" });
            break;
          }
        }
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      for (const ent of chunk) failed.push({ from: ent.from_path, error: m });
    }
  }

  return { moved, failed };
}

interface ProjectResult {
  project_id: string;
  root_path: string | null;
  skipped_reason?: string;
  drones_folder_existed: boolean;
  folders_inserted: number;
  raws_moved: number;
  proposed_moved: number;
  adjusted_moved: number;
  finals_moved: number;
  finals_copied: number;
  failures: Array<{ from: string; error: string }>;
  shots_updated: number;
  renders_updated: number;
  project_folders_updated: number;
  audit_events: number;
}

async function processProject(
  projectId: string,
  dryRun: boolean,
): Promise<ProjectResult> {
  const admin = getAdminClient();
  const result: ProjectResult = {
    project_id: projectId,
    root_path: null,
    drones_folder_existed: false,
    folders_inserted: 0,
    raws_moved: 0,
    proposed_moved: 0,
    adjusted_moved: 0,
    finals_moved: 0,
    finals_copied: 0,
    failures: [],
    shots_updated: 0,
    renders_updated: 0,
    project_folders_updated: 0,
    audit_events: 0,
  };

  const { data: proj } = await admin
    .from("projects")
    .select("id, dropbox_root_path")
    .eq("id", projectId)
    .maybeSingle();
  if (!proj || !proj.dropbox_root_path) {
    result.skipped_reason = "missing_dropbox_root_path";
    return result;
  }
  const rootPath = proj.dropbox_root_path as string;
  result.root_path = rootPath;

  // ── 1. Idempotency check ─────────────────────────────────────────────────
  const dronesRoot = `${rootPath}/Drones`;
  const existed = await dropboxFolderExists(dronesRoot);
  result.drones_folder_existed = existed;

  // Existing rows by kind (used for diffing what to insert).
  const { data: existingFolders } = await admin
    .from("project_folders")
    .select("folder_kind, dropbox_path")
    .eq("project_id", projectId);
  const existingKinds = new Set((existingFolders || []).map((f) => f.folder_kind));
  const allNewKindsPresent = Object.keys(NEW_DRONE_FOLDER_RELPATHS).every((k) =>
    existingKinds.has(k),
  );

  if (existed && allNewKindsPresent) {
    result.skipped_reason = "already_migrated";
    return result;
  }

  // ── 2. Create Dropbox tree (top-down, idempotent). ───────────────────────
  if (!dryRun) {
    for (const inter of NEW_DRONE_INTERMEDIATES) {
      await createFolder(`${rootPath}/${inter}`);
    }
    for (const relPath of Object.values(NEW_DRONE_FOLDER_RELPATHS)) {
      await createFolder(`${rootPath}/${relPath}`);
    }
  }

  // ── 3. Insert project_folders rows for new kinds. ────────────────────────
  const now = new Date().toISOString();
  const newRows = Object.entries(NEW_DRONE_FOLDER_RELPATHS).map(([kind, rel]) => ({
    project_id: projectId,
    folder_kind: kind,
    dropbox_path: `${rootPath}/${rel}`,
    last_synced_at: now,
  }));
  if (!dryRun) {
    const { error: upErr } = await admin
      .from("project_folders")
      .upsert(newRows, { onConflict: "project_id,folder_kind", ignoreDuplicates: true });
    if (upErr) {
      result.failures.push({ from: "project_folders.upsert", error: upErr.message });
    } else {
      result.folders_inserted = newRows.length;
    }
  } else {
    result.folders_inserted = newRows.filter((r) => !existingKinds.has(r.folder_kind)).length;
  }

  // ── 4. Plan + execute moves. ─────────────────────────────────────────────
  // 4a. 01_RAW_WORKING/drones/* → Drones/Raws/Shortlist Proposed/*
  const oldRaws = `${rootPath}/01_RAW_WORKING/drones`;
  const newRaws = `${rootPath}/Drones/Raws/Shortlist Proposed`;
  const rawEntries = await listFilesIfExists(oldRaws);
  const rawMoves = rawEntries.map((f) => ({
    from_path: `${oldRaws}/${f.name}`,
    to_path: `${newRaws}/${f.name}`,
  }));

  // 4b. 06_ENRICHMENT/drone_renders_proposed/* → Drones/Editors/AI Proposed Enriched/*
  const oldProposed = `${rootPath}/06_ENRICHMENT/drone_renders_proposed`;
  const newAiProposed = `${rootPath}/Drones/Editors/AI Proposed Enriched`;
  const proposedEntries = await listFilesIfExists(oldProposed);
  const proposedMoves = proposedEntries.map((f) => ({
    from_path: `${oldProposed}/${f.name}`,
    to_path: `${newAiProposed}/${f.name}`,
  }));

  // 4c. 06_ENRICHMENT/drone_renders_adjusted/* → Drones/Editors/AI Proposed Enriched/* (collapse)
  const oldAdjusted = `${rootPath}/06_ENRICHMENT/drone_renders_adjusted`;
  const adjustedEntries = await listFilesIfExists(oldAdjusted);
  const adjustedMoves = adjustedEntries.map((f) => ({
    from_path: `${oldAdjusted}/${f.name}`,
    to_path: `${newAiProposed}/${f.name}`,
  }));

  // 4d. 07_FINAL_DELIVERY/drones/* → Drones/Finals/* (move) AND copy → Drones/Editors/Final Enriched/*
  const oldFinals = `${rootPath}/07_FINAL_DELIVERY/drones`;
  const newFinals = `${rootPath}/Drones/Finals`;
  const newFinalEnriched = `${rootPath}/Drones/Editors/Final Enriched`;
  const finalEntries = await listFilesIfExists(oldFinals);

  if (dryRun) {
    result.raws_moved = rawMoves.length;
    result.proposed_moved = proposedMoves.length;
    result.adjusted_moved = adjustedMoves.length;
    result.finals_moved = finalEntries.length;
    result.finals_copied = finalEntries.length;
    return result;
  }

  // Execute the three move batches.
  const rawRes = await moveBatch(rawMoves);
  result.raws_moved = rawRes.moved;
  result.failures.push(...rawRes.failed);

  const propRes = await moveBatch(proposedMoves);
  result.proposed_moved = propRes.moved;
  result.failures.push(...propRes.failed);

  const adjRes = await moveBatch(adjustedMoves);
  result.adjusted_moved = adjRes.moved;
  result.failures.push(...adjRes.failed);

  // 4d (FINAL_DELIVERY): copy first, then move. Copy preserves the source so
  // the subsequent move still works; we copy to Final Enriched, move source to
  // Finals.
  for (const f of finalEntries) {
    try {
      await copyFile(`${oldFinals}/${f.name}`, `${newFinalEnriched}/${f.name}`);
      result.finals_copied++;
    } catch (e) {
      result.failures.push({
        from: `${oldFinals}/${f.name}`,
        error: `copy_to_final_enriched: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  const finalMoves = finalEntries.map((f) => ({
    from_path: `${oldFinals}/${f.name}`,
    to_path: `${newFinals}/${f.name}`,
  }));
  const finalsRes = await moveBatch(finalMoves);
  result.finals_moved = finalsRes.moved;
  result.failures.push(...finalsRes.failed);

  // ── 5. Rewrite drone_shots.dropbox_path. ────────────────────────────────
  // Old path prefix → new path prefix. Use raws migration map.
  const pathRewrites: Array<[string, string]> = [
    [`${oldRaws}/`, `${newRaws}/`],
    [`${oldProposed}/`, `${newAiProposed}/`],
    [`${oldAdjusted}/`, `${newAiProposed}/`],
    [`${oldFinals}/`, `${newFinals}/`],
  ];

  const { data: shots } = await admin
    .from("drone_shots")
    .select("id, dropbox_path, shoot_id, drone_shoots!inner(project_id)")
    .eq("drone_shoots.project_id", projectId);
  for (const s of shots || []) {
    const old = s.dropbox_path as string | null;
    if (!old) continue;
    for (const [from, to] of pathRewrites) {
      if (old.startsWith(from)) {
        const next = to + old.slice(from.length);
        const { error } = await admin
          .from("drone_shots")
          .update({ dropbox_path: next })
          .eq("id", s.id);
        if (error) {
          result.failures.push({ from: old, error: `drone_shots: ${error.message}` });
        } else {
          result.shots_updated++;
        }
        break;
      }
    }
  }

  // ── 6. Rewrite drone_renders.dropbox_path. ───────────────────────────────
  const { data: renders } = await admin
    .from("drone_renders")
    .select(
      "id, dropbox_path, shot_id, drone_shots!inner(shoot_id, drone_shoots!inner(project_id))",
    )
    .eq("drone_shots.drone_shoots.project_id", projectId);
  for (const r of renders || []) {
    const old = r.dropbox_path as string | null;
    if (!old) continue;
    for (const [from, to] of pathRewrites) {
      if (old.startsWith(from)) {
        const next = to + old.slice(from.length);
        const { error } = await admin
          .from("drone_renders")
          .update({ dropbox_path: next })
          .eq("id", r.id);
        if (error) {
          result.failures.push({ from: old, error: `drone_renders: ${error.message}` });
        } else {
          result.renders_updated++;
        }
        break;
      }
    }
  }

  // ── 7. Rewrite project_folders.dropbox_path for the deprecated kinds.
  // Map deprecated kinds onto their new counterpart paths so any code that
  // still reads by the old kind during the cutover gets a path that resolves.
  // (Once the orchestrator confirms no readers remain, deprecated rows can be
  // dropped in a future migration.)
  const deprecatedRewrites: Record<string, string> = {
    raw_drones: `${rootPath}/Drones/Raws/Shortlist Proposed`,
    enrichment_drone_renders_proposed: `${rootPath}/Drones/Editors/AI Proposed Enriched`,
    enrichment_drone_renders_adjusted: `${rootPath}/Drones/Editors/AI Proposed Enriched`,
    final_delivery_drones: `${rootPath}/Drones/Finals`,
  };
  for (const [kind, newPath] of Object.entries(deprecatedRewrites)) {
    const { error, count } = await admin
      .from("project_folders")
      .update({ dropbox_path: newPath, shared_link: null }, { count: "exact" })
      .eq("project_id", projectId)
      .eq("folder_kind", kind);
    if (error) {
      result.failures.push({ from: kind, error: `project_folders.update: ${error.message}` });
    } else {
      result.project_folders_updated += count ?? 0;
    }
  }

  // ── 8. Audit events ─────────────────────────────────────────────────────
  const totalMoved =
    result.raws_moved + result.proposed_moved + result.adjusted_moved + result.finals_moved;
  if (totalMoved > 0) {
    const { error: auditErr } = await admin
      .from("project_folder_events")
      .insert({
        project_id: projectId,
        folder_kind: "audit",
        event_type: "restructure_2026_04",
        actor_type: "system",
        metadata: {
          raws_moved: result.raws_moved,
          proposed_moved: result.proposed_moved,
          adjusted_moved: result.adjusted_moved,
          finals_moved: result.finals_moved,
          finals_copied: result.finals_copied,
          shots_updated: result.shots_updated,
          renders_updated: result.renders_updated,
          project_folders_updated: result.project_folders_updated,
          failures: result.failures.length,
        },
      });
    if (!auditErr) result.audit_events = 1;
  }

  return result;
}

async function listFilesIfExists(path: string): Promise<Array<{ name: string }>> {
  try {
    const { entries } = await listFolder(path, { recursive: false, maxEntries: 5000 });
    return entries
      .filter((e) => (e as { ".tag"?: string })[".tag"] === "file")
      .map((f) => ({ name: f.name }));
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("not_found")) return [];
    throw e;
  }
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return err("POST only", 405, req);

  // ── Auth: master_admin or service_role only. ────────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return err("Authentication required", 401, req);
  const isService = user.id === "__service_role__";
  if (!isService && !ALLOWED_ROLES.has(user.role || "")) {
    return err(`Role ${user.role || "(none)"} not permitted`, 403, req);
  }

  const body = await req.json().catch(() => ({}));
  const projectId: string | undefined = body.project_id;
  const dryRun: boolean = !!body.dry_run;

  const admin = getAdminClient();
  const projectIds: string[] = [];

  if (projectId) {
    projectIds.push(projectId);
  } else {
    // All in-flight projects (exclude delivered/archived/cancelled).
    const { data: projs, error } = await admin
      .from("projects")
      .select("id")
      .not("status", "in", `(${EXCLUDED_STATUSES.map((s) => `"${s}"`).join(",")})`)
      .not("dropbox_root_path", "is", null);
    if (error) return err(`project list: ${error.message}`, 500, req);
    for (const p of projs || []) projectIds.push(p.id as string);
  }

  const results: ProjectResult[] = [];
  for (const id of projectIds) {
    try {
      results.push(await processProject(id, dryRun));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      results.push({
        project_id: id,
        root_path: null,
        drones_folder_existed: false,
        folders_inserted: 0,
        raws_moved: 0,
        proposed_moved: 0,
        adjusted_moved: 0,
        finals_moved: 0,
        finals_copied: 0,
        failures: [{ from: "processProject", error: m }],
        shots_updated: 0,
        renders_updated: 0,
        project_folders_updated: 0,
        audit_events: 0,
        skipped_reason: "exception",
      });
    }
  }

  return jsonResponse(
    {
      processed: results.length,
      dry_run: dryRun,
      results,
    },
    200,
    req,
  );
});

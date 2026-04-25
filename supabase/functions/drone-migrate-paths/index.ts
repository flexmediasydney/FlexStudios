/**
 * drone-migrate-paths — one-shot migrator
 *
 * Moves a project's Dropbox folder from the old `/FlexMedia/Projects/...`
 * location to the official `/Flex Media Team Folder/Projects/...` tree, then
 * updates `projects.dropbox_root_path`, all `project_folders.dropbox_path`
 * rows, and the `dropbox_path` columns on `drone_shots` and `drone_renders`.
 *
 * Body: { project_id: string, dry_run?: boolean }
 *
 * Idempotent — if the project is already on the new path, just rewrites any
 * remaining DB rows that still point at the old path.
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleCors, getCorsHeaders, jsonResponse, getAdminClient, getUserFromReq } from "../_shared/supabase.ts";
import { dropboxApi, getMetadata } from "../_shared/dropbox.ts";

const OLD_PREFIX = "/FlexMedia/Projects/";
const NEW_PREFIX = "/Flex Media Team Folder/Projects/";
const NEW_PARENT = "/Flex Media Team Folder";

// Destructive: moves Dropbox folders + rewrites DB rows. Lock to admin/master.
const ALLOWED_ROLES = new Set(["master_admin", "admin"]);

function err(msg: string, status: number, req: Request) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

async function ensureFolder(path: string) {
  try {
    await dropboxApi("/files/create_folder_v2", { path, autorename: false });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!m.includes("path/conflict/folder")) throw e;
  }
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return err("POST only", 405, req);

  // ── Auth: master_admin/admin or service_role only. ────────────────────────
  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return err("Authentication required", 401, req);
  const isService = user.id === "__service_role__";
  if (!isService && !ALLOWED_ROLES.has(user.role || "")) {
    return err(`Role ${user.role || "(none)"} not permitted`, 403, req);
  }

  const body = await req.json().catch(() => ({}));
  const projectId: string = body.project_id;
  const dryRun: boolean = !!body.dry_run;
  if (!projectId) return err("project_id required", 400, req);

  const admin = getAdminClient();
  const { data: proj, error: projErr } = await admin
    .from("projects")
    .select("id, property_address, dropbox_root_path")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr || !proj) return err("project not found", 404, req);
  const oldRoot = proj.dropbox_root_path as string | null;
  if (!oldRoot) return err("project has no dropbox_root_path", 400, req);

  let newRoot: string;
  let needsMove = false;
  if (oldRoot.startsWith(OLD_PREFIX)) {
    newRoot = NEW_PREFIX + oldRoot.slice(OLD_PREFIX.length);
    needsMove = true;
  } else if (oldRoot.toLowerCase().startsWith(NEW_PREFIX.toLowerCase())) {
    newRoot = oldRoot;
  } else {
    return err(`unexpected dropbox_root_path: ${oldRoot}`, 400, req);
  }

  const result: Record<string, unknown> = { project_id: projectId, old_root: oldRoot, new_root: newRoot, needs_move: needsMove, dry_run: dryRun };

  if (dryRun) return jsonResponse(result, 200, req);

  // 1. Move the Dropbox folder if needed.
  if (needsMove) {
    // Make sure /Flex Media Team Folder exists (parent always should — it's the team folder).
    // Make sure /Flex Media Team Folder/Projects exists.
    await ensureFolder(NEW_PARENT);
    await ensureFolder(NEW_PREFIX.slice(0, -1));

    try {
      const moveRes = await dropboxApi<{ metadata: { path_display: string } }>("/files/move_v2", {
        from_path: oldRoot,
        to_path: newRoot,
        autorename: false,
        allow_ownership_transfer: false,
      });
      result.move = moveRes.metadata.path_display;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // If the move target already exists (idempotent retry), accept and continue.
      if (m.includes("to/conflict") || m.includes("already exists")) {
        result.move = "skipped (target exists)";
      } else {
        return err(`dropbox move failed: ${m}`, 500, req);
      }
    }
  } else {
    result.move = "skipped (already at new path)";
  }

  // Confirm the new root resolves.
  try {
    const meta = await getMetadata(newRoot);
    result.new_root_path_display = (meta as { path_display?: string }).path_display;
  } catch (e) {
    result.new_root_check = `warn: ${e instanceof Error ? e.message : e}`;
  }

  // 2. Update projects.dropbox_root_path + clear stale shared link.
  await admin
    .from("projects")
    .update({ dropbox_root_path: newRoot, dropbox_root_shared_link: null })
    .eq("id", projectId);

  // 3. Update project_folders rows.
  const { data: folders } = await admin
    .from("project_folders")
    .select("id, folder_kind, dropbox_path, shared_link")
    .eq("project_id", projectId);
  const folderUpdates: Array<{ id: string; folder_kind: string; old: string; new: string }> = [];
  for (const f of folders || []) {
    const oldPath = f.dropbox_path as string;
    if (oldPath.startsWith(OLD_PREFIX)) {
      const newPath = NEW_PREFIX + oldPath.slice(OLD_PREFIX.length);
      await admin
        .from("project_folders")
        .update({ dropbox_path: newPath, shared_link: null })
        .eq("id", f.id);
      folderUpdates.push({ id: f.id, folder_kind: f.folder_kind, old: oldPath, new: newPath });
    }
  }
  result.project_folders_updated = folderUpdates.length;

  // 4. Update drone_shots.dropbox_path.
  const { data: shots } = await admin
    .from("drone_shots")
    .select("id, dropbox_path, shoot_id, drone_shoots!inner(project_id)")
    .eq("drone_shoots.project_id", projectId);
  let shotsUpdated = 0;
  for (const s of shots || []) {
    const old = s.dropbox_path as string;
    if (old?.toLowerCase().startsWith(OLD_PREFIX.toLowerCase())) {
      const newPath = NEW_PREFIX.toLowerCase() + old.slice(OLD_PREFIX.length);
      await admin.from("drone_shots").update({ dropbox_path: newPath }).eq("id", s.id);
      shotsUpdated++;
    }
  }
  result.drone_shots_updated = shotsUpdated;

  // 5. Update drone_renders.dropbox_path. Need to filter by project via shoot.
  const { data: renders } = await admin
    .from("drone_renders")
    .select("id, dropbox_path, shot_id, drone_shots!inner(shoot_id, drone_shoots!inner(project_id))")
    .eq("drone_shots.drone_shoots.project_id", projectId);
  let rendersUpdated = 0;
  for (const r of renders || []) {
    const old = r.dropbox_path as string;
    if (old?.toLowerCase().startsWith(OLD_PREFIX.toLowerCase())) {
      const newPath = NEW_PREFIX.toLowerCase() + old.slice(OLD_PREFIX.length);
      await admin.from("drone_renders").update({ dropbox_path: newPath }).eq("id", r.id);
      rendersUpdated++;
    }
  }
  result.drone_renders_updated = rendersUpdated;

  // 6. Invalidate any cached thumbnails for this project's old paths.
  const { count: cacheDeleted } = await admin
    .from("media_cache")
    .delete({ count: "exact" })
    .eq("project_id", projectId);
  result.media_cache_invalidated = cacheDeleted ?? 0;

  return jsonResponse(result, 200, req);
});

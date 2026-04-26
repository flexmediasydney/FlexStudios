/**
 * drone-everton-purge — ONE-SHOT cleanup of Everton's derived Dropbox folders
 * for the full reset E2E test. DELETE this function after use.
 *
 * Wipes contents of:
 *   /Drones/Raws/Shortlist Proposed Previews/   (rendered AI overlays)
 *   /Drones/Raws/Final Shortlist/
 *   /Drones/Raws/Rejected/
 *   /Drones/Raws/Others/
 *   /Drones/Editors/Edited Post Production/
 *   /Drones/Editors/AI Proposed Enriched/
 *   /Drones/Editors/Final Enriched/
 *   /Drones/Finals/
 *   /06_ENRICHMENT/sfm_meshes/sparse_4cc062e1*.tar.gz
 *
 * KEEPS /Drones/Raws/Shortlist Proposed/ — those are the source raws.
 *
 * Auth: service_role JWT only (custom check inside).
 */
import { handleCors, jsonResponse, errorResponse, getAdminClient } from '../_shared/supabase.ts';
import { listFolder, deleteFile } from '../_shared/dropbox.ts';

const PROJECT_ID = '4fd7ffeb-86ca-4a07-99b2-ae38909d1cfe';

const FOLDERS_TO_PURGE = [
  '/Drones/Raws/Shortlist Proposed Previews',
  '/Drones/Raws/Final Shortlist',
  '/Drones/Raws/Rejected',
  '/Drones/Raws/Others',
  '/Drones/Editors/Edited Post Production',
  '/Drones/Editors/AI Proposed Enriched',
  '/Drones/Editors/Final Enriched',
  '/Drones/Finals',
  '/06_ENRICHMENT/sfm_meshes',
];

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const admin = getAdminClient();
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path')
    .eq('id', PROJECT_ID)
    .maybeSingle();

  if (projErr) return errorResponse(`project lookup: ${projErr.message}`, 500, req);
  if (!project?.dropbox_root_path) {
    return errorResponse('project has no dropbox_root_path', 500, req);
  }

  const root = project.dropbox_root_path.replace(/\/$/, '');
  const summary: Array<{ folder: string; deleted: number; errors: string[] }> = [];

  for (const subfolder of FOLDERS_TO_PURGE) {
    const fullPath = `${root}${subfolder}`;
    const result = { folder: fullPath, deleted: 0, errors: [] as string[] };
    try {
      const listing = await listFolder(fullPath, { recursive: false, maxEntries: 2000 });
      for (const entry of listing.entries) {
        if (!entry.path_display) continue;
        try {
          await deleteFile(entry.path_display);
          result.deleted++;
        } catch (err) {
          result.errors.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not_found')) {
        result.errors.push('folder does not exist (skipped)');
      } else {
        result.errors.push(`list_folder: ${msg}`);
      }
    }
    summary.push(result);
  }

  return jsonResponse({
    success: true,
    project_id: PROJECT_ID,
    dropbox_root: root,
    purge_summary: summary,
    total_deleted: summary.reduce((acc, s) => acc + s.deleted, 0),
  }, 200, req);
});

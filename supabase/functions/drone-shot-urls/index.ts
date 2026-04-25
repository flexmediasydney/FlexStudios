/**
 * drone-shot-urls
 * ────────────────
 * Returns short-lived (4h) raw HTTPS download URLs for the nadir_grid shots
 * in a drone shoot. Used by the Modal SfM worker (sfm_http endpoint) to
 * fetch images via plain HTTPS without carrying any Dropbox auth.
 *
 * The URLs come from Dropbox's `/files/get_temporary_link` API — they're
 * authenticated by token in the URL and expire in 4 hours, so they can be
 * passed to a third-party (Modal) worker safely.
 *
 * Request:  POST { shoot_id: string, role_filter?: string[] }
 *           role_filter defaults to ['nadir_grid'] which is what SfM needs.
 *
 * Response: {
 *   shoot_id, project_id, count,
 *   shots: [{ shot_id, filename, dropbox_path, url, expires_at, gps_lat, gps_lon, relative_altitude }]
 * }
 *
 * Auth: service_role (called by drone-job-dispatcher / Modal SfM worker via
 * service-role bearer token) OR master_admin / admin (manual debugging).
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { dropboxApi } from '../_shared/dropbox.ts';

const GENERATOR = 'drone-shot-urls';

interface ShotRow {
  id: string;
  shoot_id: string;
  dropbox_path: string;
  filename: string;
  shot_role: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  relative_altitude: number | null;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: { shoot_id?: string; role_filter?: string[]; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }
  if (!body.shoot_id) return errorResponse('shoot_id required', 400, req);

  const roleFilter = body.role_filter && body.role_filter.length > 0
    ? body.role_filter
    : ['nadir_grid'];

  const admin = getAdminClient();

  const { data: shoot, error: shootErr } = await admin
    .from('drone_shoots')
    .select('id, project_id')
    .eq('id', body.shoot_id)
    .maybeSingle();
  if (shootErr) return errorResponse(`shoot lookup failed: ${shootErr.message}`, 500, req);
  if (!shoot) return errorResponse(`shoot ${body.shoot_id} not found`, 404, req);

  const { data: shots, error: shotsErr } = await admin
    .from('drone_shots')
    .select('id, shoot_id, dropbox_path, filename, shot_role, gps_lat, gps_lon, relative_altitude')
    .eq('shoot_id', body.shoot_id)
    .in('shot_role', roleFilter);
  if (shotsErr) return errorResponse(`shots query failed: ${shotsErr.message}`, 500, req);

  const rows = (shots || []) as ShotRow[];
  if (rows.length === 0) {
    return jsonResponse(
      { success: true, shoot_id: body.shoot_id, project_id: shoot.project_id, count: 0, shots: [] },
      200,
      req,
    );
  }

  // Mint a 4h temp link per shot. Dropbox's get_temporary_link is rate-limited
  // (we've seen 30 req/s across the app's app key), so we serialise.
  // For Carrington (1 shot) and typical nadir grids (10–100 shots) this is fine.
  const out: Array<{
    shot_id: string;
    filename: string;
    dropbox_path: string;
    url: string;
    gps_lat: number | null;
    gps_lon: number | null;
    relative_altitude: number | null;
  }> = [];
  const failed: Array<{ shot_id: string; filename: string; error: string }> = [];

  for (const r of rows) {
    try {
      const linkResp = await dropboxApi<{ link: string; metadata: unknown }>(
        '/files/get_temporary_link',
        { path: r.dropbox_path },
      );
      out.push({
        shot_id: r.id,
        filename: r.filename,
        dropbox_path: r.dropbox_path,
        url: linkResp.link,
        gps_lat: r.gps_lat,
        gps_lon: r.gps_lon,
        relative_altitude: r.relative_altitude,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ shot_id: r.id, filename: r.filename, error: msg.slice(0, 200) });
    }
  }

  return jsonResponse(
    {
      success: true,
      shoot_id: body.shoot_id,
      project_id: shoot.project_id,
      count: out.length,
      shots: out,
      failed,
    },
    200,
    req,
  );
});

/**
 * list-stage4-overrides
 * ─────────────────────
 * Wave 11.7.7 / W11.6 — read-only queue API for the Stage 4 override review
 * page. Lists shortlisting_stage4_overrides rows joined with the round +
 * project + composition_group context the queue UI needs to render each
 * row (stem + thumbnail + Stage 1/4 values + reason + project address).
 *
 * Spec: docs/design-specs/W11-7-7-master-listing-copy.md (Stage 4 override
 *       audit trail) + W11.6 §F (Stage 4 self-correction events).
 *
 * Auth: master_admin or admin.
 *
 * GET / POST body:
 *   { status?: 'pending_review' | 'approved' | 'rejected' | 'deferred' | 'all',
 *     round_id?: string,                  // optional filter
 *     project_id?: string,                // optional filter
 *     limit?: number,                     // default 50, max 200
 *     offset?: number }                   // default 0
 *
 * Response:
 *   { ok: true,
 *     rows: Array<{ id, round_id, project_id, project_address, stem,
 *                   field, stage_1_value, stage_4_value, reason,
 *                   review_status, reviewed_by, reviewed_at, created_at,
 *                   group_id, preview_path? }>,
 *     total: number,                      // total matching rows pre-pagination
 *     status_counts: { pending_review, approved, rejected, deferred } }
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'list-stage4-overrides';

const ALLOWED_STATUSES = new Set(['pending_review', 'approved', 'rejected', 'deferred', 'all']);

interface ReqBody {
  status?: string;
  round_id?: string;
  project_id?: string;
  limit?: number;
  offset?: number;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST' && req.method !== 'GET') {
    return errorResponse('Method not allowed', 405, req);
  }

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden — master_admin or admin only', 403, req);
    }
  }

  let body: ReqBody = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      return errorResponse('JSON body required for POST', 400, req);
    }
  } else {
    // GET — read query params
    const url = new URL(req.url);
    body = {
      status: url.searchParams.get('status') ?? undefined,
      round_id: url.searchParams.get('round_id') ?? undefined,
      project_id: url.searchParams.get('project_id') ?? undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
    };
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const status = body.status ?? 'pending_review';
  if (!ALLOWED_STATUSES.has(status)) {
    return errorResponse(
      `status must be one of: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
      400,
      req,
    );
  }
  const limit = Math.min(Math.max(Number(body.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(body.offset ?? 0) || 0, 0);

  const admin = getAdminClient();

  // Build the base query.
  let query = admin
    .from('shortlisting_stage4_overrides')
    .select(
      'id, round_id, group_id, stem, field, stage_1_value, stage_4_value, ' +
      'reason, review_status, reviewed_by, reviewed_at, review_notes, created_at',
      { count: 'exact' },
    );

  if (status !== 'all') {
    query = query.eq('review_status', status);
  }
  if (body.round_id) {
    query = query.eq('round_id', body.round_id);
  }

  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data: overrides, error: ovErr, count } = await query;
  if (ovErr) {
    return errorResponse(`overrides query failed: ${ovErr.message}`, 500, req);
  }

  const overrideRows = overrides || [];

  // Resolve project context (need project_id + address) via shortlisting_rounds
  // → projects join. Two-step lookup keeps the query simple.
  const roundIds = Array.from(new Set(overrideRows.map((r) => r.round_id).filter(Boolean)));
  let roundsById: Map<string, { project_id: string; round_number?: number }> = new Map();
  let projectsById: Map<string, { id: string; property_address?: string; title?: string; property_tier?: string }> = new Map();

  if (roundIds.length > 0) {
    const { data: roundRows, error: roundErr } = await admin
      .from('shortlisting_rounds')
      .select('id, project_id, round_number, property_tier')
      .in('id', roundIds);
    if (roundErr) {
      return errorResponse(`rounds lookup failed: ${roundErr.message}`, 500, req);
    }
    roundsById = new Map((roundRows || []).map((r) => [r.id, {
      project_id: r.project_id,
      round_number: r.round_number,
      property_tier: r.property_tier,
    }]));

    const projectIds = Array.from(new Set((roundRows || []).map((r) => r.project_id).filter(Boolean)));
    if (projectIds.length > 0) {
      const { data: projectRows, error: projErr } = await admin
        .from('projects')
        .select('id, property_address, title, dropbox_root_path, property_tier')
        .in('id', projectIds);
      if (projErr) {
        return errorResponse(`projects lookup failed: ${projErr.message}`, 500, req);
      }
      projectsById = new Map((projectRows || []).map((p) => [p.id, p]));
    }
  }

  // Optional: also pull project filter at this stage. If body.project_id is
  // set we filter the result set after the join (cheaper than re-running
  // the query with a JOIN on PostgREST).
  let filteredRows = overrideRows;
  if (body.project_id) {
    filteredRows = overrideRows.filter((r) => {
      const round = roundsById.get(r.round_id);
      return round?.project_id === body.project_id;
    });
  }

  // Resolve composition_group preview path (best-effort — null if missing).
  // Only fetch for the rows we're returning, not the full set.
  const groupIds = Array.from(new Set(
    filteredRows.map((r) => r.group_id).filter((g) => g != null) as string[],
  ));
  let groupsById: Map<string, { id: string; dropbox_preview_path?: string; best_bracket_stem?: string }> = new Map();
  if (groupIds.length > 0) {
    const { data: groupRows, error: groupErr } = await admin
      .from('composition_groups')
      .select('id, dropbox_preview_path, best_bracket_stem')
      .in('id', groupIds);
    if (groupErr) {
      // Non-fatal — preview is decorative
      console.warn(`[${GENERATOR}] composition_groups lookup failed: ${groupErr.message}`);
    } else {
      groupsById = new Map((groupRows || []).map((g) => [g.id, g]));
    }
  }

  // Status counts (across all the query's filters but ignoring status=*).
  const { data: statusCountRows, error: statusErr } = await admin
    .from('shortlisting_stage4_overrides')
    .select('review_status', { count: 'exact', head: false })
    .in('review_status', ['pending_review', 'approved', 'rejected', 'deferred']);
  if (statusErr) {
    console.warn(`[${GENERATOR}] status counts query failed: ${statusErr.message}`);
  }
  const statusCounts: Record<string, number> = {
    pending_review: 0,
    approved: 0,
    rejected: 0,
    deferred: 0,
  };
  for (const r of statusCountRows || []) {
    const s = r.review_status as string;
    if (s in statusCounts) statusCounts[s] += 1;
  }

  // Stitch the response.
  const rows = filteredRows.map((r) => {
    const round = roundsById.get(r.round_id);
    const project = round ? projectsById.get(round.project_id) : null;
    const group = r.group_id ? groupsById.get(r.group_id) : null;
    return {
      id: r.id,
      round_id: r.round_id,
      round_number: round?.round_number ?? null,
      project_id: round?.project_id ?? null,
      project_address: project?.property_address ?? null,
      project_name: project?.title ?? null,
      property_tier: project?.property_tier ?? round?.property_tier ?? null,
      stem: r.stem,
      field: r.field,
      stage_1_value: r.stage_1_value,
      stage_4_value: r.stage_4_value,
      reason: r.reason,
      review_status: r.review_status,
      reviewed_by: r.reviewed_by,
      reviewed_at: r.reviewed_at,
      review_notes: r.review_notes,
      created_at: r.created_at,
      group_id: r.group_id,
      preview_path: group?.dropbox_preview_path ?? null,
      best_bracket_stem: group?.best_bracket_stem ?? null,
    };
  });

  return jsonResponse(
    {
      ok: true,
      rows,
      total: count ?? rows.length,
      offset,
      limit,
      status_counts: statusCounts,
    },
    200,
    req,
  );
});

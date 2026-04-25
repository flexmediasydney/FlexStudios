/**
 * getDroneTheme
 * ─────────────
 * POST { project_id }
 *   → { success, resolved_config, source_chain, inheritance_diff }
 *
 * Walks the theme inheritance chain for a project:
 *   1. person       — primary_contact_person_id
 *   2. organisation — agency_id (FlexStudios calls organisations "agencies")
 *   3. brand        — forward-compat, skipped in v1
 *   4. system       — owner_kind='system', is_default=true
 *
 * Per level, picks the row WHERE owner_kind=X AND owner_id=Y AND
 * is_default=true AND status='active' (first match wins per level).
 * Field-level deep-merge — see _shared/themeResolver.ts.
 *
 * Auth: any authenticated user. master_admin/admin always allowed; others
 * must have RLS visibility of the project (mirror getProjectFolderFiles).
 *
 * Deployed verify_jwt=false; we do our own auth via getUserFromReq.
 *
 * See IMPLEMENTATION_PLAN_V2.md §3.2.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getUserClient,
  getAdminClient,
} from '../_shared/supabase.ts';
import {
  resolveFromChain,
  type ThemeRow,
  type OwnerKind,
} from '../_shared/themeResolver.ts';

const GENERATOR = 'getDroneTheme';

interface ProjectRow {
  id: string;
  primary_contact_person_id: string | null;
  agency_id: string | null;
}

/**
 * Fetch the active default theme for one (owner_kind, owner_id) tuple.
 * For owner_kind='system' the tuple is (system, null).
 * Returns null when no row matches.
 */
async function fetchDefaultTheme(
  admin: ReturnType<typeof getAdminClient>,
  ownerKind: OwnerKind,
  ownerId: string | null,
): Promise<ThemeRow | null> {
  let q = admin
    .from('drone_themes')
    .select('id, name, owner_kind, owner_id, config, version, is_default, status')
    .eq('owner_kind', ownerKind)
    .eq('is_default', true)
    .eq('status', 'active')
    .limit(1);

  if (ownerKind === 'system') {
    q = q.is('owner_id', null);
  } else if (ownerId) {
    q = q.eq('owner_id', ownerId);
  } else {
    return null; // non-system kind without an owner_id can't match
  }

  const { data, error } = await q.maybeSingle();
  if (error) {
    console.warn(`[${GENERATOR}] fetch ${ownerKind} theme failed: ${error.message}`);
    return null;
  }
  return (data as ThemeRow) || null;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  let body: { project_id?: string; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);

  if (!body.project_id) return errorResponse('project_id required', 400, req);

  // Authz: master_admin/admin always; others must have RLS visibility of the project.
  if (!['master_admin', 'admin'].includes(user.role || '')) {
    const userClient = getUserClient(req);
    const { data: visibleProject, error: rlsErr } = await userClient
      .from('projects')
      .select('id')
      .eq('id', body.project_id)
      .maybeSingle();

    if (rlsErr) {
      console.error(`[${GENERATOR}] RLS check failed:`, rlsErr);
      return errorResponse('Project access check failed', 500, req);
    }
    if (!visibleProject) return errorResponse('Forbidden — project not visible', 403, req);
  }

  const admin = getAdminClient();

  // Pull the project row to get primary_contact_person_id + agency_id.
  const { data: projectRow, error: projErr } = await admin
    .from('projects')
    .select('id, primary_contact_person_id, agency_id')
    .eq('id', body.project_id)
    .maybeSingle();

  if (projErr) {
    console.error(`[${GENERATOR}] project fetch failed:`, projErr);
    return errorResponse(`Failed to load project: ${projErr.message}`, 500, req);
  }
  if (!projectRow) return errorResponse('Project not found', 404, req);

  const project = projectRow as ProjectRow;

  // Walk chain — highest priority first.
  const chain: ThemeRow[] = [];

  if (project.primary_contact_person_id) {
    const t = await fetchDefaultTheme(admin, 'person', project.primary_contact_person_id);
    if (t) chain.push(t);
  }
  if (project.agency_id) {
    const t = await fetchDefaultTheme(admin, 'organisation', project.agency_id);
    if (t) chain.push(t);
  }
  // Brand level: forward-compat, skipped in v1.

  const sysTheme = await fetchDefaultTheme(admin, 'system', null);
  if (sysTheme) chain.push(sysTheme);

  if (chain.length === 0) {
    return errorResponse(
      'No theme available — system default missing. Run migration 227.',
      500,
      req,
    );
  }

  const resolved = resolveFromChain(chain);

  return jsonResponse({
    success: true,
    project_id: body.project_id,
    resolved_config: resolved.resolved_config,
    source_chain: resolved.source_chain,
    inheritance_diff: resolved.inheritance_diff,
  }, 200, req);
});

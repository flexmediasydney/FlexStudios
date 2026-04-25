/**
 * setDroneTheme
 * ─────────────
 * POST { theme_id?, owner_kind, owner_id, name, config, is_default? }
 *   → { success, theme_id, version }
 *
 * Create or update a drone theme.
 *   - theme_id present  → UPDATE existing theme + insert revision row
 *   - theme_id missing  → INSERT new theme (version=1)
 *
 * Auth per owner_kind:
 *   - system        : master_admin only
 *   - organisation  : master_admin OR admin (org-admin gating arrives later)
 *   - person        : master_admin OR the person themselves (auth user.id matches)
 *   - brand         : master_admin only — but brand entity not yet implemented;
 *                     reject with 501 to make this explicit.
 *
 * On UPDATE: bumps version, snapshots PRIOR config to drone_theme_revisions
 * with a computed diff vs the new config (see _shared/themeResolver.ts).
 *
 * Deployed verify_jwt=false; we do our own auth via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import { computeConfigDiff, type OwnerKind } from '../_shared/themeResolver.ts';

const GENERATOR = 'setDroneTheme';

const VALID_OWNER_KINDS: OwnerKind[] = ['system', 'person', 'organisation', 'brand'];

interface SetThemeBody {
  theme_id?: string;
  owner_kind?: OwnerKind;
  owner_id?: string | null;
  name?: string;
  config?: Record<string, unknown>;
  is_default?: boolean;
  _health_check?: boolean;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  let body: SetThemeBody = {};
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

  // Validate body shape
  if (!body.owner_kind || !VALID_OWNER_KINDS.includes(body.owner_kind)) {
    return errorResponse(
      `owner_kind required, must be one of: ${VALID_OWNER_KINDS.join(', ')}`,
      400, req,
    );
  }

  // Brand is forward-compat — no entity yet.
  if (body.owner_kind === 'brand') {
    return errorResponse(
      'brand-level themes not yet supported — brand entity is not implemented',
      501, req,
    );
  }

  if (!body.name || typeof body.name !== 'string' || body.name.length === 0) {
    return errorResponse('name required (non-empty string)', 400, req);
  }
  if (body.config === undefined || body.config === null) {
    return errorResponse('config required', 400, req);
  }
  if (typeof body.config !== 'object' || Array.isArray(body.config)) {
    return errorResponse('config must be a JSON object', 400, req);
  }
  // Round-trip through JSON to ensure it's serialisable (rejects circular refs etc).
  let serialisedConfig: Record<string, unknown>;
  try {
    serialisedConfig = JSON.parse(JSON.stringify(body.config));
  } catch {
    return errorResponse('config is not valid JSON', 400, req);
  }

  // owner_id consistency with the schema CHECK:
  //   system → owner_id IS NULL
  //   others → owner_id required
  if (body.owner_kind === 'system') {
    if (body.owner_id) {
      return errorResponse('owner_id must be null for owner_kind=system', 400, req);
    }
  } else {
    if (!body.owner_id) {
      return errorResponse(`owner_id required for owner_kind=${body.owner_kind}`, 400, req);
    }
  }

  // ── Auth gates ──────────────────────────────────────────────────────────────
  const role = user.role || '';
  const isMasterAdmin = role === 'master_admin';
  const isAdmin = role === 'admin';

  if (body.owner_kind === 'system') {
    if (!isMasterAdmin) {
      return errorResponse('system themes are master_admin only', 403, req);
    }
  } else if (body.owner_kind === 'organisation') {
    if (!isMasterAdmin && !isAdmin) {
      return errorResponse('organisation themes require master_admin or admin', 403, req);
    }
  } else if (body.owner_kind === 'person') {
    // master_admin OR the person themselves.
    // FlexStudios calls the "person" entity `agents`. Self-check: the agent
    // row at owner_id must match either the calling user's email OR
    // assigned_to_user_id. Service-role'd for determinism.
    if (!isMasterAdmin) {
      const admin = getAdminClient();
      const { data: agentRow, error: aErr } = await admin
        .from('agents')
        .select('id, email, assigned_to_user_id')
        .eq('id', body.owner_id!)
        .maybeSingle();
      if (aErr) {
        console.error(`[${GENERATOR}] agent lookup failed:`, aErr);
        return errorResponse('Failed to verify person ownership', 500, req);
      }
      const matchesEmail = agentRow?.email && user.email
        && agentRow.email.toLowerCase() === user.email.toLowerCase();
      const matchesUserId = agentRow?.assigned_to_user_id === user.id;
      if (!agentRow || (!matchesEmail && !matchesUserId)) {
        return errorResponse('person themes require master_admin or self', 403, req);
      }
    }
  }

  const admin = getAdminClient();

  // ── UPDATE path ────────────────────────────────────────────────────────────
  if (body.theme_id) {
    const { data: priorTheme, error: fetchErr } = await admin
      .from('drone_themes')
      .select('id, owner_kind, owner_id, config, version')
      .eq('id', body.theme_id)
      .maybeSingle();

    if (fetchErr) {
      console.error(`[${GENERATOR}] fetch prior theme failed:`, fetchErr);
      return errorResponse(`Failed to load existing theme: ${fetchErr.message}`, 500, req);
    }
    if (!priorTheme) return errorResponse('theme_id not found', 404, req);

    // Don't let callers re-parent themes (changes the auth surface).
    if (priorTheme.owner_kind !== body.owner_kind || (priorTheme.owner_id || null) !== (body.owner_id || null)) {
      return errorResponse(
        'Cannot change owner_kind or owner_id on existing theme — create a new one instead',
        400, req,
      );
    }

    const newVersion = (priorTheme.version || 1) + 1;
    const diff = computeConfigDiff(
      (priorTheme.config || {}) as Record<string, unknown>,
      serialisedConfig,
    );

    const { error: updErr } = await admin
      .from('drone_themes')
      .update({
        name: body.name,
        config: serialisedConfig,
        is_default: body.is_default ?? false,
        version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq('id', body.theme_id);

    if (updErr) {
      console.error(`[${GENERATOR}] update failed:`, updErr);
      return errorResponse(`Failed to update theme: ${updErr.message}`, 500, req);
    }

    // Snapshot the PRIOR config + diff (immutable history).
    const { error: revErr } = await admin
      .from('drone_theme_revisions')
      .insert({
        theme_id: body.theme_id,
        version: priorTheme.version || 1,
        config: priorTheme.config,
        diff,
        changed_by: user.id === '__service_role__' ? null : user.id,
      });
    if (revErr) {
      // Non-fatal — the theme was updated; revision insert failing is
      // observable in logs but shouldn't roll back the user's save.
      console.warn(`[${GENERATOR}] revision insert failed: ${revErr.message}`);
    }

    return jsonResponse({
      success: true,
      theme_id: body.theme_id,
      version: newVersion,
    }, 200, req);
  }

  // ── INSERT path ────────────────────────────────────────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from('drone_themes')
    .insert({
      name: body.name,
      owner_kind: body.owner_kind,
      owner_id: body.owner_id ?? null,
      config: serialisedConfig,
      is_default: body.is_default ?? false,
      status: 'active',
      version: 1,
      created_by: user.id === '__service_role__' ? null : user.id,
    })
    .select('id, version')
    .single();

  if (insErr) {
    console.error(`[${GENERATOR}] insert failed:`, insErr);
    return errorResponse(`Failed to create theme: ${insErr.message}`, 500, req);
  }

  return jsonResponse({
    success: true,
    theme_id: inserted.id,
    version: inserted.version,
  }, 200, req);
});

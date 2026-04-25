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
  // Bug #11 — archive/restore was previously a direct PATCH that bypassed
  // validation + revision history. Route through here with status so
  // every state change is auditable.
  status?: 'active' | 'archived';
  _health_check?: boolean;
}

const VALID_STATUSES = new Set(['active', 'archived']);

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

  // Walk the config and reject any non-hex value at a key that names a colour.
  // Without this, garbage like { primary: "totally not a hex" } reaches Modal
  // and crashes (or silently produces broken renders). The Theme Editor adds
  // client-side validation but a direct API caller can bypass it. (#B2 audit fix)
  //
  // Bug #7 — `null` and the literal string "transparent" are valid: the
  // editor uses `transparent` for sqm_total.bg_color and similar, and
  // border colours allow `null` for "no border". Reject everything else
  // that isn't a 6 or 8-char hex.
  const COLOR_KEY_RE = /color|fill|stroke|background/i;
  const HEX_RE = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/;
  const badColors: string[] = [];
  function walkColors(node: unknown, path: string) {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        if (COLOR_KEY_RE.test(k)) {
          // Allow nullish (= "no colour") and literal "transparent" for
          // bg_color / fill fields. Otherwise must be a 6/8-char hex.
          if (v === null || v === undefined || v === '' || v === 'transparent') {
            // permissible
          } else if (typeof v === 'string') {
            if (!HEX_RE.test(v)) badColors.push(`${here}=${JSON.stringify(v)}`);
          } else if (typeof v === 'object') {
            walkColors(v, here);
          }
        } else if (v && typeof v === 'object') {
          walkColors(v, here);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => walkColors(item, `${path}[${i}]`));
    }
  }
  walkColors(serialisedConfig, '');
  if (badColors.length > 0) {
    return errorResponse(
      `config has invalid hex colour(s): ${badColors.slice(0, 5).join(', ')}${badColors.length > 5 ? ` (+${badColors.length - 5} more)` : ''}`,
      400,
      req,
    );
  }

  // Bug #11 — validate status if supplied (archive/restore path).
  if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
    return errorResponse(
      `status must be one of: ${[...VALID_STATUSES].join(', ')}`,
      400, req,
    );
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

  /**
   * Clear is_default on every other theme for this (owner_kind, owner_id)
   * tuple. Required because the resolver assumes exactly one default per
   * level — a second `is_default=true` would silently shadow the prior one
   * and `.maybeSingle()` would error or pick arbitrarily.
   *
   * Excludes `excludeThemeId` so the row we're about to set/insert isn't
   * itself reset. Best-effort: a failure here is logged but not fatal —
   * the user's primary save shouldn't fail because of cleanup.
   */
  async function clearOtherDefaults(excludeThemeId: string | null) {
    let q = admin
      .from('drone_themes')
      .update({ is_default: false })
      .eq('owner_kind', body.owner_kind!)
      .eq('is_default', true);
    if (body.owner_kind === 'system') {
      q = q.is('owner_id', null);
    } else {
      q = q.eq('owner_id', body.owner_id!);
    }
    if (excludeThemeId) q = q.neq('id', excludeThemeId);
    const { error } = await q;
    if (error) {
      console.warn(`[${GENERATOR}] clearOtherDefaults failed: ${error.message}`);
    }
  }

  // ── UPDATE path ────────────────────────────────────────────────────────────
  if (body.theme_id) {
    const { data: priorTheme, error: fetchErr } = await admin
      .from('drone_themes')
      .select('id, owner_kind, owner_id, config, version, version_int, status')
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

    // If this save flips is_default ON, clear it on every sibling first so
    // the resolver continues to see exactly one default per level.
    // Bug #11 — also clear is_default if archiving the default theme,
    // matching what the legacy direct-PATCH path did.
    const isArchiving = body.status === 'archived';
    const effectiveIsDefault = isArchiving ? false : (body.is_default ?? false);
    if (effectiveIsDefault === true) {
      await clearOtherDefaults(body.theme_id);
    }

    // Build update set — include status only if caller supplied it (so a
    // plain edit doesn't accidentally restore an archived theme).
    const updateSet: Record<string, unknown> = {
      name: body.name,
      config: serialisedConfig,
      is_default: effectiveIsDefault,
      version: newVersion,
      updated_at: new Date().toISOString(),
    };
    if (body.status !== undefined) {
      updateSet.status = body.status;
    }

    const { data: updated, error: updErr } = await admin
      .from('drone_themes')
      .update(updateSet)
      .eq('id', body.theme_id)
      .select('id, version, version_int')
      .single();

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

    // Bug #14 — return version_int so the client uses authoritative value
    // rather than optimistically bumping (which can drift if the trigger
    // didn't fire because nothing actually changed).
    return jsonResponse({
      success: true,
      theme_id: body.theme_id,
      version: newVersion,
      version_int: updated?.version_int ?? null,
      status: body.status ?? priorTheme.status,
    }, 200, req);
  }

  // ── INSERT path ────────────────────────────────────────────────────────────
  // If the new theme is being created as default, clear it on every sibling
  // first (no exclude — the new row doesn't exist yet).
  if (body.is_default === true) {
    await clearOtherDefaults(null);
  }

  const { data: inserted, error: insErr } = await admin
    .from('drone_themes')
    .insert({
      name: body.name,
      owner_kind: body.owner_kind,
      owner_id: body.owner_id ?? null,
      config: serialisedConfig,
      is_default: body.is_default ?? false,
      // Bug #11 — honour caller-supplied status (defaults to 'active').
      status: body.status ?? 'active',
      version: 1,
      created_by: user.id === '__service_role__' ? null : user.id,
    })
    .select('id, version, version_int, status')
    .single();

  if (insErr) {
    console.error(`[${GENERATOR}] insert failed:`, insErr);
    return errorResponse(`Failed to create theme: ${insErr.message}`, 500, req);
  }

  // Bug #14 — return version_int so the client mirrors authoritative state.
  return jsonResponse({
    success: true,
    theme_id: inserted.id,
    version: inserted.version,
    version_int: inserted.version_int ?? 1,
    status: inserted.status ?? 'active',
  }, 200, req);
});

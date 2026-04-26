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
 *   - person        : master_admin OR the agent themselves (resolved via
 *                     agents.assigned_to_user_id = auth.uid)
 *   - brand         : master_admin only — but brand entity not yet implemented;
 *                     reject with 501 to make this explicit.
 *
 * On UPDATE: bumps version, snapshots PRIOR config to drone_theme_revisions
 * with a computed diff vs the new config (see _shared/themeResolver.ts).
 *
 * Deployed verify_jwt=false; we do our own auth via getUserFromReq.
 *
 * W5 P2 S4 / mig 280: person-theme owner_id is now the agents.id (NOT the
 * auth.users.id). The function resolves the calling user's agents row via
 * assigned_to_user_id and uses that id for persistence. Legacy clients that
 * still send auth.uid() are translated transparently. Without this fix the
 * persisted row would fail RLS reads under the new mig 280 predicate
 * `owner_id IN (SELECT id FROM agents WHERE assigned_to_user_id = auth.uid())`.
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
    return jsonResponse({ _version: 'v2.0', _fn: GENERATOR }, 200, req);
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

  // ── owner_id translation for person themes (W5 P2 S4 / mig 280) ──────────
  // mig 280 changed the person-theme RLS predicate to:
  //   owner_id IN (SELECT id FROM agents WHERE assigned_to_user_id = auth.uid())
  // That means owner_id MUST be an agents.id, not an auth.users.id. Prior
  // callers (pre-mig 252 / pre-mig 280) often passed auth.uid() because the
  // initial RLS read it that way. After mig 280 those rows fail RLS with_check
  // on insert AND become invisible on read.
  //
  // Fix: when writing a person theme, RESOLVE the agent for the calling user
  // and use that agents.id as the canonical owner_id. This applies even when
  // the function uses the admin client (which bypasses RLS) — without the
  // translation the persisted owner_id would still be wrong and the actual
  // owner's normal-RLS reads would exclude the row.
  let resolvedOwnerId: string | null | undefined = body.owner_id;
  if (body.owner_kind === 'person') {
    if (isMasterAdmin) {
      // Master admin: trust the supplied owner_id but verify it resolves to
      // a real agent row (no silent FK ghost-rows). owner_id MAY equal
      // auth.uid() in legacy clients; translate to the agents.id when so.
      const admin = getAdminClient();
      const { data: agentDirect } = await admin
        .from('agents')
        .select('id, email, assigned_to_user_id')
        .eq('id', body.owner_id!)
        .maybeSingle();
      if (agentDirect) {
        resolvedOwnerId = (agentDirect as { id: string }).id;
      } else {
        // owner_id might be an auth.users.id — try resolving via assigned_to_user_id
        const { data: agentByUser } = await admin
          .from('agents')
          .select('id')
          .eq('assigned_to_user_id', body.owner_id!)
          .maybeSingle();
        if (agentByUser) {
          resolvedOwnerId = (agentByUser as { id: string }).id;
          console.info(
            `[${GENERATOR}] master_admin: translated auth.users.id ${body.owner_id} → agents.id ${resolvedOwnerId}`,
          );
        } else {
          return errorResponse(
            `owner_id ${body.owner_id} does not resolve to an agent record`,
            400, req,
          );
        }
      }
    } else {
      // Non-admin: the calling user must have an agents row, and that row's
      // id is the canonical owner_id. Resolve it server-side and ignore
      // whatever owner_id the client supplied (defence against a manager
      // trying to write a theme owned by another agent).
      const admin = getAdminClient();
      const { data: callerAgent, error: agErr } = await admin
        .from('agents')
        .select('id')
        .eq('assigned_to_user_id', user.id)
        .limit(1)
        .maybeSingle();
      if (agErr) {
        console.error(`[${GENERATOR}] agent resolve failed:`, agErr);
        return errorResponse('Failed to resolve agent record', 500, req);
      }
      if (!callerAgent) {
        return errorResponse(
          'no agent record for current user — cannot write a person theme',
          403, req,
        );
      }
      const callerAgentId = (callerAgent as { id: string }).id;
      // Defensive: if the caller supplied an explicit owner_id and it
      // doesn't match the resolved agents.id, reject — they're trying to
      // write someone else's person theme. (Master admins pass through above.)
      if (body.owner_id && body.owner_id !== callerAgentId) {
        // Allow auth.uid() → agents.id translation as a forgiveness for
        // legacy clients (we don't want every app version bump to break
        // saves) — but only when the supplied id IS the caller's auth uid.
        if (body.owner_id !== user.id) {
          return errorResponse(
            'person themes can only be written for your own agent record',
            403, req,
          );
        }
        console.info(
          `[${GENERATOR}] translated auth.users.id ${user.id} → agents.id ${callerAgentId} (legacy client)`,
        );
      }
      resolvedOwnerId = callerAgentId;
    }
  }

  if (body.owner_kind === 'system') {
    if (!isMasterAdmin) {
      return errorResponse('system themes are master_admin only', 403, req);
    }
  } else if (body.owner_kind === 'organisation') {
    if (!isMasterAdmin && !isAdmin) {
      return errorResponse('organisation themes require master_admin or admin', 403, req);
    }
  }
  // Person-theme auth was the agents-resolution block above; no further check.

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
      // mig 280: scope by RESOLVED agents.id for person themes so we don't
      // also clear defaults belonging to the (different) auth.users.id row.
      const ownerIdForScope =
        body.owner_kind === 'person' ? (resolvedOwnerId as string) : (body.owner_id as string);
      q = q.eq('owner_id', ownerIdForScope);
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
    // For person themes compare against the RESOLVED agents.id (not the
    // raw client-supplied owner_id, which may be auth.uid in legacy clients).
    const compareOwnerId =
      body.owner_kind === 'person' ? (resolvedOwnerId || null) : (body.owner_id || null);
    if (priorTheme.owner_kind !== body.owner_kind || (priorTheme.owner_id || null) !== compareOwnerId) {
      return errorResponse(
        'Cannot change owner_kind or owner_id on existing theme — create a new one instead',
        400, req,
      );
    }
    // Defensive (mig 280): person-theme updates verify the prior row's
    // owner_id matches the resolved agents.id for the calling user. Without
    // this, master_admin's translation block above could (theoretically)
    // accept a stale auth-id-as-owner that maps to a different agent than
    // the row currently holds. The check above already gates that for non-
    // admin callers; this is the master-admin belt-and-braces.
    if (body.owner_kind === 'person' && priorTheme.owner_id !== resolvedOwnerId) {
      return errorResponse(
        `prior theme owner_id ${priorTheme.owner_id} does not match resolved agents.id ${resolvedOwnerId}`,
        403, req,
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

  // mig 280: persist owner_id as the RESOLVED agents.id for person themes,
  // not whatever the client sent (which may be auth.uid). Other owner_kinds
  // pass through unchanged.
  const persistedOwnerId =
    body.owner_kind === 'person' ? (resolvedOwnerId ?? null) : (body.owner_id ?? null);
  const { data: inserted, error: insErr } = await admin
    .from('drone_themes')
    .insert({
      name: body.name,
      owner_kind: body.owner_kind,
      owner_id: persistedOwnerId,
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

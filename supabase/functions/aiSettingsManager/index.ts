import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const ADMIN_ROLES = ['master_admin', 'admin'];

/**
 * AI Settings Manager — CRUD for ai_settings table.
 *
 * GET  → returns effective settings (global merged with user overrides)
 * POST → action-based mutations:
 *   - update_global        (admin only)
 *   - update_user          (admin only, targets another user)
 *   - update_mine          (any authenticated user)
 *   - reset_daily_counters (admin / cron)
 */
serveWithAudit('aiSettingsManager', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401, req);

    const admin = getAdminClient();

    // ─── GET: return effective (merged) settings ─────────────────────────
    if (req.method === 'GET') {
      // Fetch global row
      const { data: globalRow } = await admin
        .from('ai_settings')
        .select('*')
        .eq('setting_scope', 'global')
        .is('user_id', null)
        .single();

      // Fetch user row (if exists)
      const { data: userRow } = await admin
        .from('ai_settings')
        .select('*')
        .eq('setting_scope', 'user')
        .eq('user_id', user.id)
        .maybeSingle();

      const effective = mergeSettings(globalRow, userRow);

      return jsonResponse({
        effective,
        global: globalRow || null,
        user: userRow || null,
      }, 200, req);
    }

    // ─── POST: action-based mutations ────────────────────────────────────
    if (req.method !== 'POST') {
      return errorResponse('Method not allowed', 405, req);
    }

    const body = await req.json();
    const { action, ...payload } = body;

    // ── update_global (admin only) ──
    if (action === 'update_global') {
      if (!ADMIN_ROLES.includes(user.role)) {
        return errorResponse('Admin access required', 403, req);
      }

      const fields = pickSettingsFields(payload);
      fields.updated_at = new Date().toISOString();

      const { data, error } = await admin
        .from('ai_settings')
        .update(fields)
        .eq('setting_scope', 'global')
        .is('user_id', null)
        .select()
        .single();

      if (error) return errorResponse(error.message, 400, req);
      return jsonResponse({ success: true, settings: data }, 200, req);
    }

    // ── update_user (admin only, targets another user) ──
    if (action === 'update_user') {
      if (!ADMIN_ROLES.includes(user.role)) {
        return errorResponse('Admin access required', 403, req);
      }

      const targetUserId = payload.user_id;
      if (!targetUserId) return errorResponse('user_id required', 400, req);

      const fields = pickSettingsFields(payload);
      fields.updated_at = new Date().toISOString();

      const { data, error } = await admin
        .from('ai_settings')
        .upsert(
          {
            setting_scope: 'user',
            user_id: targetUserId,
            ...fields,
          },
          { onConflict: 'setting_scope,user_id' },
        )
        .select()
        .single();

      if (error) return errorResponse(error.message, 400, req);
      return jsonResponse({ success: true, settings: data }, 200, req);
    }

    // ── update_mine (any authenticated user) ──
    if (action === 'update_mine') {
      const fields = pickSettingsFields(payload);
      fields.updated_at = new Date().toISOString();

      const { data, error } = await admin
        .from('ai_settings')
        .upsert(
          {
            setting_scope: 'user',
            user_id: user.id,
            ...fields,
          },
          { onConflict: 'setting_scope,user_id' },
        )
        .select()
        .single();

      if (error) return errorResponse(error.message, 400, req);
      return jsonResponse({ success: true, settings: data }, 200, req);
    }

    // ── reset_daily_counters (admin / cron) ──
    if (action === 'reset_daily_counters') {
      if (!ADMIN_ROLES.includes(user.role)) {
        return errorResponse('Admin access required', 403, req);
      }

      const { error } = await admin
        .from('ai_settings')
        .update({
          daily_used: 0,
          daily_reset_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .gte('daily_used', 1); // only touch rows that actually have usage

      if (error) return errorResponse(error.message, 400, req);
      return jsonResponse({ success: true, message: 'Daily counters reset' }, 200, req);
    }

    return errorResponse(`Unknown action: ${action}`, 400, req);
  } catch (err: any) {
    console.error('aiSettingsManager error:', err);
    return errorResponse(err?.message || 'Internal error', 500, req);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Allowlist of fields that can be written to ai_settings. */
const MUTABLE_FIELDS = [
  'enabled',
  'daily_limit',
  'confirmation_level',
  'allowed_actions',
  'blocked_actions',
  'voice_enabled',
  'auto_execute_safe',
  'tts_enabled',
  'consent_given_at',
  'cost_budget_daily',
  'model_preference',
] as const;

function pickSettingsFields(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MUTABLE_FIELDS) {
    if (key in payload && payload[key] !== undefined) {
      out[key] = payload[key];
    }
  }
  return out;
}

/**
 * Merge global defaults with user-level overrides.
 * User values win when they are non-null; otherwise global applies.
 */
function mergeSettings(
  global: Record<string, unknown> | null,
  user: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!global) return user ?? {};
  if (!user) return global;

  const merged: Record<string, unknown> = { ...global };

  for (const key of Object.keys(user)) {
    // Skip metadata fields that shouldn't override global
    if (['id', 'setting_scope', 'created_at'].includes(key)) continue;
    if (user[key] !== null && user[key] !== undefined) {
      merged[key] = user[key];
    }
  }

  return merged;
}

import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

const PRESENCE_TTL_SECONDS = 30;

serveWithAudit('projectPresenceHeartbeat', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    // Presence is per-real-user. Service-role callers (cron / cross-function calls)
    // have no UUID and would crash the uuid column on insert — short-circuit cleanly.
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!user.id || !UUID_RE.test(String(user.id))) {
      return jsonResponse({ success: true, viewers: [], skipped: 'service_role' });
    }

    const body = await req.json().catch(() => ({}));
    const { project_id, action = 'heartbeat' } = body;

    if (!project_id) return errorResponse('project_id required', 400);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PRESENCE_TTL_SECONDS * 1000);

    if (action === 'leave') {
      // Leave is best-effort — any DB failure here would just leave a stale record
      // that expires naturally, so swallow errors rather than 500-ing the caller.
      const existing = await entities.ProjectPresence.filter({ project_id, user_id: user.id }).catch(() => []);
      for (const record of existing) {
        await entities.ProjectPresence.delete(record.id).catch(() => {});
      }
      return jsonResponse({ success: true, action: 'left' });
    }

    // Upsert presence. Rapid heartbeats from the same user on the same project
    // can race (two inserts trying to create "first" row concurrently). If the
    // create fails because another heartbeat just won the race, fall back to
    // update on re-fetched row — the end state is the same.
    const existing = await entities.ProjectPresence.filter({ project_id, user_id: user.id });

    const presenceData = {
      project_id,
      user_id: user.id,
      user_name: user.full_name || user.email,
      user_email: user.email,
      user_role: user.role || 'user',
      last_seen: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    try {
      if (existing && existing.length > 0) {
        await entities.ProjectPresence.update(existing[0].id, presenceData);
      } else {
        await entities.ProjectPresence.create(presenceData);
      }
    } catch (upsertErr: any) {
      // Race condition: another concurrent heartbeat just created/updated the row.
      // Re-fetch and update the winning row rather than bubbling a 500.
      const retry = await entities.ProjectPresence.filter({ project_id, user_id: user.id }).catch(() => []);
      if (retry.length > 0) {
        await entities.ProjectPresence.update(retry[0].id, presenceData).catch(() => {});
      } else {
        // Genuine failure — log but don't fail the request (presence is best-effort).
        console.warn('Presence upsert failed after retry:', upsertErr?.message);
      }
    }

    // Clean up stale presence records
    const allPresence = await entities.ProjectPresence.filter({ project_id }).catch(() => []);
    const stale = allPresence.filter((p: any) => p.expires_at && new Date(p.expires_at) < now);
    for (const record of stale) {
      await entities.ProjectPresence.delete(record.id).catch(() => {});
    }

    // Return fresh active viewers
    const fresh = await entities.ProjectPresence.filter({ project_id }).catch(() => []);
    const active = fresh.filter((p: any) => p.expires_at && new Date(p.expires_at) >= now);

    return jsonResponse({
      success: true,
      viewers: active.map((p: any) => ({
        user_id: p.user_id,
        user_name: p.user_name,
        user_email: p.user_email,
        user_role: p.user_role,
        last_seen: p.last_seen,
        is_self: p.user_id === user.id,
      })),
    });
  } catch (error: any) {
    console.error('Presence heartbeat error:', error);
    // Presence is best-effort: degrade gracefully to an empty-viewers response
    // instead of bubbling a 500 for what is non-critical background UI.
    return jsonResponse({ success: false, viewers: [], error: error?.message || 'presence failed' });
  }
});

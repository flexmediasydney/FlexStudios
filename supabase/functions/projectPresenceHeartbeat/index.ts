import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const PRESENCE_TTL_SECONDS = 30;

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json().catch(() => ({}));
    const { project_id, action = 'heartbeat' } = body;

    if (!project_id) return errorResponse('project_id required', 400);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PRESENCE_TTL_SECONDS * 1000);

    if (action === 'leave') {
      const existing = await entities.ProjectPresence.filter({ project_id, user_id: user.id });
      for (const record of existing) {
        await entities.ProjectPresence.delete(record.id);
      }
      return jsonResponse({ success: true, action: 'left' });
    }

    // Upsert presence
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

    if (existing && existing.length > 0) {
      await entities.ProjectPresence.update(existing[0].id, presenceData);
    } else {
      await entities.ProjectPresence.create(presenceData);
    }

    // Clean up stale presence records
    const allPresence = await entities.ProjectPresence.filter({ project_id });
    const stale = allPresence.filter((p: any) => p.expires_at && new Date(p.expires_at) < now);
    for (const record of stale) {
      await entities.ProjectPresence.delete(record.id).catch(() => {});
    }

    // Return fresh active viewers
    const fresh = await entities.ProjectPresence.filter({ project_id });
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
    return errorResponse(error.message);
  }
});

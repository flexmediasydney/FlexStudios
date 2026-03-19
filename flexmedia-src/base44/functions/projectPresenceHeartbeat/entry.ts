import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const PRESENCE_TTL_SECONDS = 30; // Expire after 30s of no heartbeat
const HEARTBEAT_INTERVAL_MS = 15000; // Client sends every 15s

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { project_id, action = 'heartbeat' } = body;

    if (!project_id) return Response.json({ error: 'project_id required' }, { status: 400 });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PRESENCE_TTL_SECONDS * 1000);

    if (action === 'leave') {
      // Find and delete user's presence record for this project
      const existing = await base44.asServiceRole.entities.ProjectPresence.filter({
        project_id,
        user_id: user.id
      });
      for (const record of existing) {
        await base44.asServiceRole.entities.ProjectPresence.delete(record.id);
      }
      return Response.json({ success: true, action: 'left' });
    }

    // Upsert presence: find existing record, update or create
    const existing = await base44.asServiceRole.entities.ProjectPresence.filter({
      project_id,
      user_id: user.id
    });

    const presenceData = {
      project_id,
      user_id: user.id,
      user_name: user.full_name || user.email,
      user_email: user.email,
      user_role: user.role || 'user',
      last_seen: now.toISOString(),
      expires_at: expiresAt.toISOString()
    };

    if (existing && existing.length > 0) {
      await base44.asServiceRole.entities.ProjectPresence.update(existing[0].id, presenceData);
    } else {
      await base44.asServiceRole.entities.ProjectPresence.create(presenceData);
    }

    // Also clean up stale presence records for this project (expired > 30s ago)
    const allPresence = await base44.asServiceRole.entities.ProjectPresence.filter({ project_id });
    const stale = allPresence.filter(p => p.expires_at && new Date(p.expires_at) < now);
    for (const record of stale) {
      await base44.asServiceRole.entities.ProjectPresence.delete(record.id).catch(() => {});
    }

    // Return fresh active viewers
    const fresh = await base44.asServiceRole.entities.ProjectPresence.filter({ project_id });
    const active = fresh.filter(p => p.expires_at && new Date(p.expires_at) >= now);

    return Response.json({
      success: true,
      viewers: active.map(p => ({
        user_id: p.user_id,
        user_name: p.user_name,
        user_email: p.user_email,
        user_role: p.user_role,
        last_seen: p.last_seen,
        is_self: p.user_id === user.id
      }))
    });
  } catch (error) {
    console.error('Presence heartbeat error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
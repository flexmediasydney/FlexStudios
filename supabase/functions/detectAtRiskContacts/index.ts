import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

async function _canNotify(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 50);
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

const AT_RISK_DEFAULT_DAYS = 90;

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth check — callable by service-role (cron) or admin users
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const agents = await entities.Agent.list('-created_at', 1000);
    const watchedAgents = agents.filter((a: any) =>
      a.relationship_state === 'Active' || a.relationship_state === 'Prospecting'
    );

    const projects = await entities.Project.list('-shoot_date', 2000);
    const now = Date.now();
    const newlyAtRisk: Array<{ id: string; name: string }> = [];

    for (const agent of watchedAgents) {
      const agentProjects = projects.filter((p: any) => p.agent_id === agent.id);

      const latestMs = agentProjects.reduce((latest: number, p: any) => {
        const d = p.shoot_date || p.created_at;
        if (!d) return latest;
        const t = new Date(d).getTime();
        return t > latest ? t : latest;
      }, 0);

      const thresholdDays = agent.contact_frequency_days
        ? agent.contact_frequency_days * 3
        : AT_RISK_DEFAULT_DAYS;

      const daysSince = latestMs > 0
        ? Math.floor((now - latestMs) / (24 * 60 * 60 * 1000))
        : null;

      const createdDaysAgo = agent.created_at
        ? Math.floor((now - new Date(agent.created_at).getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      const shouldBeAtRisk =
        (agentProjects.length > 0 && daysSince !== null && daysSince > thresholdDays) ||
        (agentProjects.length === 0 && createdDaysAgo > thresholdDays);

      if (shouldBeAtRisk !== (agent.is_at_risk === true)) {
        await entities.Agent.update(agent.id, { is_at_risk: shouldBeAtRisk }).catch(() => {});
        if (shouldBeAtRisk) {
          newlyAtRisk.push({ id: agent.id, name: agent.name });
        }
      }
    }

    // Notify admins about newly at-risk contacts
    if (newlyAtRisk.length > 0) {
      const adminUsers = await entities.User.list('-created_at', 200);
      const admins = adminUsers.filter((u: any) =>
        u.role === 'master_admin' || u.role === 'admin'
      );
      const nameList = newlyAtRisk.slice(0, 5).map(u => u.name).join(', ');
      const overflow = newlyAtRisk.length > 5 ? ` +${newlyAtRisk.length - 5} more` : '';

      for (const admin of admins) {
        const allowed = await _canNotify(entities, admin.id, 'stale_project', 'system');
        if (!allowed) continue;
        await entities.Notification.create({
          user_id: admin.id,
          type: 'stale_project',
          category: 'system',
          severity: 'warning',
          title: `${newlyAtRisk.length} contact${newlyAtRisk.length > 1 ? 's' : ''} at risk of going dormant`,
          message: `${nameList}${overflow} — haven't booked in ${AT_RISK_DEFAULT_DAYS}+ days.`,
          cta_label: 'View Contacts',
          is_read: false,
          is_dismissed: false,
          source: 'at_risk_detection',
          idempotency_key: `at_risk_daily:${new Date().toISOString().slice(0, 10)}`,
          created_date: new Date().toISOString(),
        }).catch(() => {});
      }
    }

    return jsonResponse({
      success: true,
      checked: watchedAgents.length,
      newly_at_risk: newlyAtRisk.length,
      names: newlyAtRisk.map(u => u.name),
    });
  } catch (err: any) {
    console.error('detectAtRiskContacts error:', err);
    return errorResponse(err.message);
  }
});

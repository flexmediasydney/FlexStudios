import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, isQuietHours } from '../_shared/supabase.ts';

async function _canNotify(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    if (await isQuietHours(userId)) return false;
    const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 50);
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { project_id, triggered_by } = await req.json();

    if (!project_id) return errorResponse('project_id required', 400);

    const project = await entities.Project.get(project_id);
    if (!project) return errorResponse('Project not found', 404);

    // Already archived -- skip
    if (project.is_archived) return jsonResponse({ already_archived: true });

    // 1. Status must be delivered
    if (project.status !== 'delivered') {
      return jsonResponse({ archived: false, reason: 'status_not_delivered', status: project.status });
    }

    // 2. Payment must be paid
    if (project.payment_status !== 'paid') {
      return jsonResponse({ archived: false, reason: 'not_paid', payment_status: project.payment_status });
    }

    // 3. All tasks must be completed or deleted
    const tasks = await entities.ProjectTask.filter({ project_id }, null, 500).catch(() => [] as any[]);
    const incompleteTasks = tasks.filter((t: any) => !t.is_completed && !t.is_deleted && !t.is_archived);
    if (incompleteTasks.length > 0) {
      return jsonResponse({
        archived: false, reason: 'incomplete_tasks',
        count: incompleteTasks.length,
        titles: incompleteTasks.slice(0, 3).map((t: any) => t.title),
      });
    }

    // 4. No running timers
    const timeLogs = await entities.TaskTimeLog.filter({ project_id }, null, 200).catch(() => [] as any[]);
    const runningTimers = timeLogs.filter((t: any) => t.is_active && t.status === 'running');
    if (runningTimers.length > 0) {
      return jsonResponse({ archived: false, reason: 'running_timers', count: runningTimers.length });
    }

    // 5. All revisions must be completed or cancelled
    const revisions = await entities.ProjectRevision.filter({ project_id }, null, 100).catch(() => [] as any[]);
    const openRevisions = revisions.filter((r: any) =>
      r.status && !['completed', 'cancelled', 'delivered'].includes(r.status)
    );
    if (openRevisions.length > 0) {
      return jsonResponse({
        archived: false, reason: 'open_revisions',
        count: openRevisions.length,
        titles: openRevisions.slice(0, 3).map((r: any) => r.title),
      });
    }

    // ALL CRITERIA MET -- ARCHIVE
    const now = new Date().toISOString();
    await entities.Project.update(project_id, {
      is_archived: true,
      archived_at: now,
      archived_by: triggered_by || 'auto',
    });

    // Activity log
    try {
      await entities.ProjectActivity.create({
        project_id,
        project_title: project.title || project.property_address || '',
        action: 'auto_archived',
        description: `Project auto-archived — delivered, paid, all tasks complete, no open revisions.`,
        user_name: 'System',
        user_email: '',
      });
    } catch { /* non-fatal */ }

    // Team activity feed
    try {
      await entities.TeamActivityFeed.create({
        event_type: 'project_archived',
        category: 'project',
        severity: 'info',
        actor_id: null,
        actor_name: 'System',
        title: `Project archived: ${project.title || project.property_address}`,
        description: `Automatically archived — delivered, paid, all tasks complete.`,
        project_id,
        project_name: project.title || project.property_address || '',
      });
    } catch { /* non-fatal */ }

    // Notify project owner
    try {
      const ownerId = project.project_owner_id;
      if (ownerId && await _canNotify(entities, ownerId, 'project_stage_changed', 'project')) {
        await entities.Notification.create({
          user_id: ownerId,
          type: 'project_stage_changed',
          category: 'project',
          severity: 'info',
          title: `Project archived: ${project.title || project.property_address}`,
          message: `All deliverables complete, payment received. Project has been automatically archived.`,
          project_id,
          project_name: project.title || project.property_address || '',
          entity_type: 'project',
          entity_id: project_id,
          cta_url: 'ProjectDetails',
          cta_label: 'View Project',
          cta_params: JSON.stringify({ id: project_id }),
          source: 'system',
          source_user_id: null,
          is_read: false,
          is_dismissed: false,
          idempotency_key: `archived:${project_id}:${new Date().toISOString().slice(0, 10)}`,
          created_date: new Date().toISOString(),
        });
      }
    } catch { /* non-fatal */ }

    return jsonResponse({ archived: true, project_id, archived_at: now });

  } catch (err: any) {
    return errorResponse(err.message);
  }
});

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

async function _canNotify(base44: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    const prefs = await base44.asServiceRole.entities.NotificationPreference.filter(
      { user_id: userId }, null, 50
    );
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { revision_id } = await req.json();

    if (!revision_id) {
      return Response.json({ error: 'Missing revision_id' }, { status: 400 });
    }

    const revision = await base44.entities.ProjectRevision.filter({ id: revision_id });
    if (!revision || revision.length === 0) {
      return Response.json({ error: 'Revision not found' }, { status: 404 });
    }

    const rev = revision[0];

    // Get all tasks for the revision
    const tasks = await base44.entities.ProjectTask.filter({ project_id: rev.project_id });
    const revisionTasks = tasks.filter(t =>
      t.revision_id === rev.id ||
      (!t.revision_id && t.title?.startsWith(`[Revision #${rev.revision_number}]`))
    );

    // Mark all revision tasks as deleted
    for (const task of revisionTasks) {
      await base44.entities.ProjectTask.update(task.id, { is_deleted: true });
    }

    // Stop any active timers for these tasks
    const timeLogs = await base44.entities.TaskTimeLog.filter({ project_id: rev.project_id });
    const taskIds = new Set(revisionTasks.map(t => t.id));
    const relevantLogs = timeLogs.filter(log => taskIds.has(log.task_id) && log.is_active);

    for (const log of relevantLogs) {
      await base44.entities.TaskTimeLog.update(log.id, {
        is_active: false,
        status: 'completed',
        end_time: new Date().toISOString(),
      });
    }

    // Activity log and notify
    if (rev?.project_id) {
      const project = await base44.entities.Project.get(rev.project_id).catch(() => null);
      const projectName = project?.title || project?.property_address || 'Project';

      base44.entities.ProjectActivity.create({
        project_id: rev.project_id,
        project_title: projectName,
        action: 'request_cancelled',
        description: `Revision #${rev.revision_number || '?'} cancelled. ${revisionTasks?.length || 0} tasks archived, ${relevantLogs?.length || 0} timers stopped.`,
        actor_type: 'system',
        actor_source: 'handleRevisionCancellation',
        user_name: 'System',
        user_email: 'system@flexmedia',
      }).catch(() => {});

      if (project) {
        const notifyUsers = [
          project.image_editor_id,
          project.video_editor_id,
        ].filter(Boolean);
        for (const userId of notifyUsers) {
          const allowed = await _canNotify(base44, userId, 'revision_cancelled', 'revision');
          if (!allowed) continue;
          base44.entities.Notification.create({
            user_id: userId,
            type: 'revision_cancelled',
            category: 'revision',
            severity: 'info',
            title: `Revision cancelled — ${projectName}`,
            message: `Revision #${rev.revision_number || '?'} has been cancelled. Related tasks have been archived.`,
            project_id: rev.project_id,
            project_name: projectName,
            cta_label: 'View Project',
            is_read: false,
            is_dismissed: false,
            source: 'revision',
            idempotency_key: `revision_cancelled:${rev.id}`,
          }).catch(() => {});
        }
      }
    }

    // Sync project status out of in_revision if this was the last open revision
    if (rev.project_id) {
      base44.functions.invoke('syncProjectRevisionStatus', {
        project_id: rev.project_id,
      }).catch(() => {});
    }

    return Response.json({ 
      status: 'cancelled',
      tasks_killed: revisionTasks.length,
      timers_stopped: relevantLogs.length 
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
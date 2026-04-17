import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, isQuietHours, serveWithAudit } from '../_shared/supabase.ts';

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

serveWithAudit('handleRevisionCancellation', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth check — callable by service-role (from other functions) or authenticated users
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const { revision_id } = await req.json();

    if (!revision_id) return errorResponse('Missing revision_id', 400);

    const revision = await entities.ProjectRevision.filter({ id: revision_id });
    if (!revision || revision.length === 0) return errorResponse('Revision not found', 404);

    const rev = revision[0];

    // Guard: if already cancelled (concurrent request), skip
    if (rev.status === 'cancelled') {
      return jsonResponse({ success: true, skipped: true, reason: 'already_cancelled' });
    }

    // Get all tasks for the revision
    const tasks = await entities.ProjectTask.filter({ project_id: rev.project_id });
    const revisionTasks = tasks.filter((t: any) => t.title?.startsWith(`[Revision #${rev.revision_number}]`));

    // Mark all revision tasks as deleted
    for (const task of revisionTasks) {
      await entities.ProjectTask.update(task.id, { is_deleted: true });
    }

    // Stop any active timers for these tasks
    const timeLogs = await entities.TaskTimeLog.filter({ project_id: rev.project_id });
    const taskIds = new Set(revisionTasks.map((t: any) => t.id));
    const relevantLogs = timeLogs.filter((log: any) => taskIds.has(log.task_id) && log.is_active);

    for (const log of relevantLogs) {
      await entities.TaskTimeLog.update(log.id, {
        is_active: false,
        status: 'completed',
        end_time: new Date().toISOString(),
      });
    }

    // Activity log and notify
    if (rev?.project_id) {
      const project = await entities.Project.get(rev.project_id).catch(() => null);
      const projectName = project?.title || project?.property_address || 'Project';

      entities.ProjectActivity.create({
        project_id: rev.project_id,
        project_title: projectName,
        action: 'request_cancelled',
        description: `Revision #${rev.revision_number || '?'} cancelled. ${revisionTasks?.length || 0} tasks archived, ${relevantLogs?.length || 0} timers stopped.`,
        actor_type: 'system',
        actor_source: 'handleRevisionCancellation',
        user_name: 'System',
        user_email: 'system@flexstudios.app',
      }).catch(() => {});

      if (project) {
        const notifyUsers = [
          project.image_editor_id,
          project.video_editor_id,
        ].filter(Boolean);
        for (const userId of notifyUsers) {
          const allowed = await _canNotify(entities, userId, 'revision_cancelled', 'revision');
          if (!allowed) continue;
          await entities.Notification.create({
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
          }).catch((err: any) => console.error('Failed to notify user of revision cancellation:', err?.message));
        }
      }
    }

    // Sync project status out of in_revision if this was the last open revision
    if (rev.project_id) {
      invokeFunction('syncProjectRevisionStatus', {
        project_id: rev.project_id,
      }).catch(() => {});
    }

    return jsonResponse({
      status: 'cancelled',
      tasks_killed: revisionTasks.length,
      timers_stopped: relevantLogs.length,
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

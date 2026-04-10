import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, isQuietHours } from '../_shared/supabase.ts';

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

    // Auth check — callable by service-role (from other functions) or authenticated users
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json();
    const { event, data, function_args } = body;

    // Resolve event_type and revision_id from various sources
    let eventType = function_args?.event_type || data?.event_type;
    let revisionId: string | null = null;

    if (event?.entity_id) {
      revisionId = event.entity_id;
    } else if (data?.id && event?.entity_name === 'ProjectRevision') {
      revisionId = data.id;
    }

    if (!revisionId || !eventType) {
      return errorResponse('Missing revision_id or event_type', 400);
    }

    const revisionArr = await entities.ProjectRevision.filter({ id: revisionId }, null, 1);
    if (!revisionArr || revisionArr.length === 0) return errorResponse('Revision not found', 404);

    const rev = revisionArr[0];
    const tasks = await entities.ProjectTask.filter({ project_id: rev.project_id }, null, 1000);
    const revisionTasks = tasks.filter((t: any) => t.title?.startsWith(`[Revision #${rev.revision_number}]`));

    let newStatus = rev.status;
    const updates: any = {};

    // identified -> in_progress
    if (rev.status === 'identified' && (eventType === 'task_completed' || eventType === 'effort_logged')) {
      newStatus = 'in_progress';
    }

    // in_progress -> completed
    if (rev.status === 'in_progress' && eventType === 'check_completion') {
      const activeTasks = revisionTasks.filter((t: any) => !t.is_deleted);
      const allComplete = activeTasks.length > 0 && activeTasks.every((t: any) => t.is_completed);
      if (allComplete) {
        newStatus = 'completed';
        updates.completed_date = new Date().toISOString();
      }
    }

    // Don't auto-transition from delivered, cancelled, or stuck
    if (['delivered', 'cancelled', 'stuck'].includes(rev.status)) {
      return jsonResponse({ status: 'no_change', current_status: rev.status });
    }

    if (newStatus !== rev.status) {
      updates.status = newStatus;
      await entities.ProjectRevision.update(revisionId, updates);

      const project = await entities.Project.get(rev.project_id).catch(() => null);
      if (project) {
        const projectName = project.title || project.property_address || 'Project';

        // Activity log
        entities.ProjectActivity.create({
          project_id: rev.project_id,
          project_title: projectName,
          action: 'request_updated',
          description: `Revision #${rev.revision_number || '?'} status changed to ${newStatus}.`,
          actor_type: 'system',
          actor_source: 'updateRevisionStatus',
          user_name: 'System',
          user_email: 'system@flexstudios.app',
        }).catch(() => {});

        // Notify on key events
        if (newStatus === 'completed') {
          const notifyUsers = [
            project.image_editor_id,
            project.video_editor_id,
            project.project_owner_id,
          ].filter(Boolean);
          for (const userId of notifyUsers) {
            const allowed = await _canNotify(entities, userId, 'revision_approved', 'revision');
            if (!allowed) continue;
            await entities.Notification.create({
              user_id: userId,
              type: 'revision_approved',
              category: 'revision',
              severity: 'info',
              title: `Revision approved — ${projectName}`,
              message: `Revision #${rev.revision_number || '?'} has been approved.`,
              project_id: rev.project_id,
              project_name: projectName,
              cta_label: 'View Project',
              is_read: false,
              is_dismissed: false,
              source: 'revision',
              idempotency_key: `revision_approved:${rev.id}`,
            }).catch((err: any) => console.error('Failed to notify user of revision approval:', err?.message));
          }
        }
      }

      // If revision is now closed, sync project status
      const closedStatuses = ['completed', 'rejected', 'cancelled', 'delivered'];
      if (closedStatuses.includes(newStatus)) {
        invokeFunction('syncProjectRevisionStatus', {
          project_id: rev.project_id,
        }).catch(() => {});
      }

      return jsonResponse({ status: 'updated', previous: rev.status, new: newStatus });
    }

    return jsonResponse({ status: 'no_change', current_status: rev.status });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

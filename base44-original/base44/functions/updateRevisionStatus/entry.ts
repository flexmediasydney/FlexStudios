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
    const body = await req.json();
    const { event, data, function_args } = body;
    
    // Resolve event_type and revision_id from various sources
    let eventType = function_args?.event_type || data?.event_type;
    let revisionId = null;

    // For entity automations, the entity_id is the revision ID
    if (event?.entity_id) {
      revisionId = event.entity_id;
    }
    // Fallback: check data payload
    else if (data?.id && event?.entity_name === 'ProjectRevision') {
      revisionId = data.id;
    }

    if (!revisionId || !eventType) {
      return Response.json({ error: 'Missing revision_id or event_type' }, { status: 400 });
    }

    const revisionArr = await base44.asServiceRole.entities.ProjectRevision.filter({ id: revisionId }, null, 1);
    if (!revisionArr || revisionArr.length === 0) {
      return Response.json({ error: 'Revision not found' }, { status: 404 });
    }

    const rev = revisionArr[0];
    const tasks = await base44.asServiceRole.entities.ProjectTask.filter({ project_id: rev.project_id }, null, 1000);
    const revisionTasks = tasks.filter(t => t.title?.startsWith(`[Revision #${rev.revision_number}]`));

    let newStatus = rev.status;
    let updates = {};

    // identified → in_progress: triggered by task completion or effort logging
    if (rev.status === 'identified' && (eventType === 'task_completed' || eventType === 'effort_logged')) {
      newStatus = 'in_progress';
    }

    // in_progress → completed: all non-deleted tasks are completed
    if (rev.status === 'in_progress' && eventType === 'check_completion') {
      const activeTasks = revisionTasks.filter(t => !t.is_deleted);
      const allComplete = activeTasks.length > 0 && activeTasks.every(t => t.is_completed);
      if (allComplete) {
        newStatus = 'completed';
        updates.completed_date = new Date().toISOString();
      }
    }

    // Don't auto-transition from delivered, cancelled, or stuck
    if (['delivered', 'cancelled', 'stuck'].includes(rev.status)) {
      return Response.json({ status: 'no_change', current_status: rev.status });
    }

    if (newStatus !== rev.status) {
      updates.status = newStatus;
      await base44.asServiceRole.entities.ProjectRevision.update(revisionId, updates);

      // Write activity log and notify
      const project = await base44.asServiceRole.entities.Project.get(rev.project_id).catch(() => null);
      if (project) {
        const projectName = project.title || project.property_address || 'Project';

        // Activity log
        base44.asServiceRole.entities.ProjectActivity.create({
          project_id: rev.project_id,
          project_title: projectName,
          action: 'request_updated',
          description: `Revision #${rev.revision_number || '?'} status changed to ${newStatus}.`,
          actor_type: 'system',
          actor_source: 'updateRevisionStatus',
          user_name: 'System',
          user_email: 'system@flexmedia',
        }).catch(() => {});

        // Notify on key events
        if (newStatus === 'completed') {
          const notifyUsers = [
            project.image_editor_id,
            project.video_editor_id,
            project.project_owner_id,
          ].filter(Boolean);
          for (const userId of notifyUsers) {
            const allowed = await _canNotify(base44, userId, 'revision_approved', 'revision');
            if (!allowed) continue;
            base44.asServiceRole.entities.Notification.create({
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
            }).catch(() => {});
          }
        }
      }

      // If revision is now closed (completed/rejected/cancelled), sync project status
      // so it exits in_revision if no other open revisions remain
      const closedStatuses = ['completed', 'rejected', 'cancelled', 'delivered'];
      if (closedStatuses.includes(newStatus)) {
        base44.asServiceRole.functions.invoke('syncProjectRevisionStatus', {
          project_id: rev.project_id,
        }).catch(() => {});
      }

      return Response.json({ status: 'updated', previous: rev.status, new: newStatus });
    }

    return Response.json({ status: 'no_change', current_status: rev.status });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { project_id, triggered_by } = await req.json();

    if (!project_id) return Response.json({ error: 'project_id required' }, { status: 400 });

    const project = await base44.asServiceRole.entities.Project.get(project_id);
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    // Already archived — skip
    if (project.is_archived) return Response.json({ already_archived: true });

    // ── CHECK ALL 5 CRITERIA ──────────────────────────────────────────────

    // 1. Status must be delivered
    if (project.status !== 'delivered') {
      return Response.json({ archived: false, reason: 'status_not_delivered', status: project.status });
    }

    // 2. Payment must be paid
    if (project.payment_status !== 'paid') {
      return Response.json({ archived: false, reason: 'not_paid', payment_status: project.payment_status });
    }

    // 3. All tasks must be completed or deleted
    const tasks = await base44.asServiceRole.entities.ProjectTask.filter(
      { project_id }, null, 500
    ).catch(() => []);
    const incompleteTasks = tasks.filter(t => !t.is_completed && !t.is_deleted);
    if (incompleteTasks.length > 0) {
      return Response.json({
        archived: false, reason: 'incomplete_tasks',
        count: incompleteTasks.length,
        titles: incompleteTasks.slice(0, 3).map(t => t.title),
      });
    }

    // 4. No running timers
    const timeLogs = await base44.asServiceRole.entities.TaskTimeLog.filter(
      { project_id }, null, 200
    ).catch(() => []);
    const runningTimers = timeLogs.filter(t => t.is_active && t.status === 'running');
    if (runningTimers.length > 0) {
      return Response.json({ archived: false, reason: 'running_timers', count: runningTimers.length });
    }

    // 5. All revisions must be completed or cancelled
    const revisions = await base44.asServiceRole.entities.ProjectRevision.filter(
      { project_id }, null, 100
    ).catch(() => []);
    const openRevisions = revisions.filter(r =>
      r.status && !['completed', 'cancelled', 'delivered'].includes(r.status)
    );
    if (openRevisions.length > 0) {
      return Response.json({
        archived: false, reason: 'open_revisions',
        count: openRevisions.length,
        titles: openRevisions.slice(0, 3).map(r => r.title),
      });
    }

    // ── ALL CRITERIA MET — ARCHIVE ────────────────────────────────────────

    const now = new Date().toISOString();
    await base44.asServiceRole.entities.Project.update(project_id, {
      is_archived: true,
      archived_at: now,
      archived_by: triggered_by || 'auto',
    });

    // Activity log
    try {
      await base44.asServiceRole.entities.ProjectActivity.create({
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
      await base44.asServiceRole.entities.TeamActivityFeed.create({
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
      if (ownerId) {
        await base44.asServiceRole.entities.Notification.create({
          user_id: ownerId,
          type: 'project_archived',
          title: `Project archived: ${project.title || project.property_address}`,
          message: `All deliverables complete, payment received. Project has been automatically archived.`,
          project_id,
          project_name: project.title || project.property_address || '',
          entity_type: 'project',
          entity_id: project_id,
          cta_url: 'ProjectDetails',
          cta_params: JSON.stringify({ id: project_id }),
          source_user_id: null,
          is_read: false,
          idempotency_key: `archived:${project_id}`,
        });
      }
    } catch { /* non-fatal */ }

    return Response.json({ archived: true, project_id, archived_at: now });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { project_id } = await req.json();
    if (!project_id) {
      return Response.json({ error: 'project_id required' }, { status: 400 });
    }

    // Soft-delete all project tasks (preserves TaskTimeLogs for audit trail)
    const tasks = await base44.asServiceRole.entities.ProjectTask.filter({ project_id }, null, 500).catch(() => []);
    await Promise.all(tasks.map(t =>
      base44.asServiceRole.entities.ProjectTask.update(t.id, { is_deleted: true }).catch(() => {})
    ));

    // Hard-delete other child entities
    const [revisions, notes, mediaConfigs, efforts, activities] = await Promise.all([
      base44.asServiceRole.entities.ProjectRevision.filter({ project_id }, null, 100).catch(() => []),
      base44.asServiceRole.entities.ProjectNote.filter({ project_id }, null, 200).catch(() => []),
      base44.asServiceRole.entities.ProjectMedia.filter({ project_id }, null, 10).catch(() => []),
      base44.asServiceRole.entities.ProjectEffort.filter({ project_id }, null, 10).catch(() => []),
      base44.asServiceRole.entities.ProjectActivity.filter({ project_id }, null, 500).catch(() => []),
    ]);

    await Promise.all([
      ...revisions.map(r => base44.asServiceRole.entities.ProjectRevision.delete(r.id).catch(() => {})),
      ...notes.map(n => base44.asServiceRole.entities.ProjectNote.delete(n.id).catch(() => {})),
      ...mediaConfigs.map(m => base44.asServiceRole.entities.ProjectMedia.delete(m.id).catch(() => {})),
      ...efforts.map(e => base44.asServiceRole.entities.ProjectEffort.delete(e.id).catch(() => {})),
      ...activities.map(a => base44.asServiceRole.entities.ProjectActivity.delete(a.id).catch(() => {})),
    ]);

    // Unlink calendar events by event source
    const linkedEvents = await base44.asServiceRole.entities.CalendarEvent.filter({ project_id }, null, 500).catch(() => []);
    const batchSize = 10;
    for (let i = 0; i < linkedEvents.length; i += batchSize) {
      const batch = linkedEvents.slice(i, i + batchSize);
      await Promise.all(batch.map(ev => {
        const source = ev.event_source || (ev.tonomo_appointment_id ? 'tonomo' : ev.is_synced ? 'google' : 'flexmedia');
        if (source === 'flexmedia') {
          return base44.asServiceRole.entities.CalendarEvent.update(ev.id, {
            project_id: null,
            agent_id: null,
            agency_id: null,
            auto_linked: false,
          }).catch(() => {});
        } else {
          return base44.asServiceRole.entities.CalendarEvent.update(ev.id, {
            project_id: null,
            auto_linked: false,
            link_source: null,
          }).catch(() => {});
        }
      }));
    }

    return Response.json({ success: true, cleaned: { tasks: tasks.length, revisions: revisions.length, events: linkedEvents.length } });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
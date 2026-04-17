import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('cleanupProjectOnDelete', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json().catch(() => ({} as any));
    const { project_id } = body;
    if (!project_id) return errorResponse('project_id required', 400, req);

    // Soft-delete all project tasks (preserves TaskTimeLogs for audit trail)
    const tasks = await entities.ProjectTask.filter({ project_id }, null, 500).catch(() => [] as any[]);
    await Promise.all(tasks.map((t: any) =>
      entities.ProjectTask.update(t.id, { is_deleted: true }).catch(() => {})
    ));

    // Hard-delete other child entities
    const [revisions, notes, mediaConfigs, efforts, activities] = await Promise.all([
      entities.ProjectRevision.filter({ project_id }, null, 100).catch(() => [] as any[]),
      entities.ProjectNote.filter({ project_id }, null, 200).catch(() => [] as any[]),
      entities.ProjectMedia.filter({ project_id }, null, 10).catch(() => [] as any[]),
      entities.ProjectEffort.filter({ project_id }, null, 10).catch(() => [] as any[]),
      entities.ProjectActivity.filter({ project_id }, null, 500).catch(() => [] as any[]),
    ]);

    await Promise.all([
      ...revisions.map((r: any) => entities.ProjectRevision.delete(r.id).catch(() => {})),
      ...notes.map((n: any) => entities.ProjectNote.delete(n.id).catch(() => {})),
      ...mediaConfigs.map((m: any) => entities.ProjectMedia.delete(m.id).catch(() => {})),
      ...efforts.map((e: any) => entities.ProjectEffort.delete(e.id).catch(() => {})),
      ...activities.map((a: any) => entities.ProjectActivity.delete(a.id).catch(() => {})),
    ]);

    // Unlink calendar events by event source
    const linkedEvents = await entities.CalendarEvent.filter({ project_id }, null, 500).catch(() => [] as any[]);
    const batchSize = 10;
    for (let i = 0; i < linkedEvents.length; i += batchSize) {
      const batch = linkedEvents.slice(i, i + batchSize);
      await Promise.all(batch.map((ev: any) => {
        const source = ev.event_source || (ev.tonomo_appointment_id ? 'tonomo' : ev.is_synced ? 'google' : 'flexmedia');
        if (source === 'flexmedia') {
          return entities.CalendarEvent.update(ev.id, {
            project_id: null,
            agent_id: null,
            agency_id: null,
            auto_linked: false,
          }).catch(() => {});
        } else {
          return entities.CalendarEvent.update(ev.id, {
            project_id: null,
            auto_linked: false,
            link_source: null,
          }).catch(() => {});
        }
      }));
    }

    return jsonResponse({ success: true, cleaned: { tasks: tasks.length, revisions: revisions.length, events: linkedEvents.length } });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

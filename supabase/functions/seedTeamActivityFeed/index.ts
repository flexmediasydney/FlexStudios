import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    const existing = await entities.TeamActivityFeed.list('-created_date', 5);
    if (existing?.length > 0) {
      return jsonResponse({ message: 'Already seeded', count: existing.length });
    }

    const activities = await entities.ProjectActivity.list('-created_date', 200);
    const projects = await entities.Project.list('-created_date', 500);
    const pMap: Record<string, any> = {};
    projects.forEach((p: any) => { pMap[p.id] = p; });

    let created = 0;
    for (const act of activities) {
      const proj = pMap[act.project_id] || {};
      await entities.TeamActivityFeed.create({
        event_type:      act.activity_type || 'project_activity',
        category:        'project',
        severity:        'info',
        actor_id:        act.user_id || null,
        actor_name:      act.user_name || null,
        title:           act.description?.slice(0, 100) || 'Project activity',
        description:     act.description || null,
        project_id:      act.project_id || null,
        project_name:    proj.title || null,
        project_address: proj.property_address || null,
        project_stage:   proj.status || null,
        entity_type:     'project',
        entity_id:       act.project_id || null,
        metadata:        act.metadata || null,
        visible_to_roles: '',
        created_date:    act.created_date || new Date().toISOString(),
      });
      created++;
    }

    return jsonResponse({ message: `Seeded ${created} feed events`, created });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

import { createClient } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (_req) => {
  const base44 = createClient({ serviceRoleKey: Deno.env.get('BASE44_SERVICE_KEY') });

  const existing = await base44.asServiceRole.entities.TeamActivityFeed.list('-created_date', 5);
  if (existing?.length > 0) {
    return Response.json({ message: 'Already seeded', count: existing.length });
  }

  const activities = await base44.asServiceRole.entities.ProjectActivity.list('-created_date', 200);
  const projects = await base44.asServiceRole.entities.Project.list('-created_date', 500);
  const pMap: Record<string, any> = {};
  projects.forEach((p: any) => { pMap[p.id] = p; });

  let created = 0;
  for (const act of activities) {
    const proj = pMap[act.project_id] || {};
    await base44.asServiceRole.entities.TeamActivityFeed.create({
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

  return Response.json({ message: `Seeded ${created} feed events`, created });
});
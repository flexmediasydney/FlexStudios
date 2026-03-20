import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { entity_type, entity_id, new_name } = await req.json();

    if (!entity_type || !entity_id || !new_name) {
      return Response.json({ error: 'entity_type, entity_id, new_name required' }, { status: 400 });
    }

    let updatedCount = 0;

    if (entity_type === 'agency') {
      const matchingProjects = await base44.entities.Project.filter({ agency_id: entity_id }, null, 2000);
      
      for (const project of matchingProjects) {
        await base44.entities.Project.update(project.id, { agency_name: new_name });
        updatedCount++;
      }

      const matchingAgents = await base44.entities.Agent.filter({ current_agency_id: entity_id }, null, 500);
      
      for (const agent of matchingAgents) {
        await base44.entities.Agent.update(agent.id, { current_agency_name: new_name });
        updatedCount++;
      }
    } else if (entity_type === 'agent') {
      const matchingProjects = await base44.entities.Project.filter({ client_id: entity_id }, null, 2000);
      
      for (const project of matchingProjects) {
        await base44.entities.Project.update(project.id, { client_name: new_name });
        updatedCount++;
      }
    } else if (entity_type === 'user') {
      // Fix 6c — update denormalised user name on ProjectTasks assigned to this user
      const tasks = await base44.entities.ProjectTask.filter({ assigned_to: entity_id }, null, 2000);
      for (const task of tasks) {
        if (task.assigned_to_name !== new_name) {
          await base44.entities.ProjectTask.update(task.id, { assigned_to_name: new_name });
          updatedCount++;
        }
      }
      // Update EmployeeRole name
      const roles = await base44.entities.EmployeeRole.filter({ user_id: entity_id }, null, 50).catch(() => []);
      for (const role of roles) {
        await base44.entities.EmployeeRole.update(role.id, { user_name: new_name }).catch(() => {});
        updatedCount++;
      }
    }

    return Response.json({ 
      success: true, 
      entity_type, 
      entity_id, 
      new_name,
      updatedCount 
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});